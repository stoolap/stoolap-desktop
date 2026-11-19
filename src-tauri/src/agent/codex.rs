//! ChatGPT through the user's local Codex CLI, driven over its app-server
//! protocol (JSON-RPC lines on stdio), signed in with a ChatGPT account.
//!
//! Codex runs with a home directory of the app's own (`CODEX_HOME`), so the
//! user's Codex plugins, MCP servers, memories and instructions never load:
//! with the user's own home, a plugin's MCP server could read files and run
//! commands. The shell and every other built-in tool are switched off; the
//! only tools are ours, passed as dynamic tools and answered here. Any
//! approval Codex asks for anyway is declined.

use super::{emit, emit_tool, mcp::McpSession, Event};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

#[cfg(windows)]
const NAMES: &[&str] = &["codex.exe", "codex.cmd"];
#[cfg(not(windows))]
const NAMES: &[&str] = &["codex"];

/// Built-in tools and features that reach past the database: shell,
/// browsers, computer use, plugins, web search and the like.
const DISABLED: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "unified_exec_tty",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "browser_annotation_api",
    "in_app_browser",
    "computer_use",
    "image_generation",
    "view_image",
    "multi_agent",
    "sleep_tool",
    "tool_suggest",
    "skill_search",
    "goals",
    "hooks",
    "daemon_auto_start",
];

/// The `codex` executable, looked for like `claude`
pub fn find() -> Option<PathBuf> {
    super::claude_code::find_named(NAMES, "codex")
}

/// `codex --version`, e.g. "codex-cli 0.163.0"
pub fn version(path: &Path) -> Option<String> {
    super::claude_code::version(path)
}

/// The app's own Codex home, holding its ChatGPT sign-in
fn home(data_dir: &Path) -> PathBuf {
    data_dir.join("codex")
}

/// Whether the app's Codex home has a sign-in (kept in a file there)
pub fn signed_in(data_dir: &Path) -> bool {
    home(data_dir).join("auth.json").is_file()
}

/// A running `codex app-server`
pub struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Server {
    pub async fn start(codex: &Path, data_dir: &Path, cwd: &Path) -> Result<Server, String> {
        let home = home(data_dir);
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(cwd).map_err(|e| e.to_string())?;
        let mut cmd = tokio::process::Command::from(super::claude_code::command(codex));
        cmd.arg("app-server");
        for feature in DISABLED {
            cmd.args(["--disable", feature]);
        }
        cmd.args(["-c", "web_search=\"disabled\""])
            // The sign-in stays in the app's home, where signed_in() looks
            .args(["-c", "cli_auth_credentials_store=\"file\""])
            .env("CODEX_HOME", &home)
            // Only the ChatGPT sign-in, never a key from the environment
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("Could not start Codex: {e}"))?;
        let stdin = child.stdin.take().ok_or("Codex has no stdin")?;
        let stdout = child.stdout.take().ok_or("Codex has no stdout")?;
        let mut server = Server { child, stdin, lines: BufReader::new(stdout).lines(), next_id: 0 };
        server
            .request(
                "initialize",
                json!({
                    "clientInfo": {"name": "stoolap-desktop", "version": env!("CARGO_PKG_VERSION")},
                    // Dynamic tools are an experimental part of the protocol
                    "capabilities": {"experimentalApi": true},
                }),
            )
            .await?;
        server.write(&json!({"method": "initialized"})).await?;
        Ok(server)
    }

    async fn write(&mut self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Codex stopped: {e}"))
    }

    /// The next message from Codex; None when it has exited
    async fn next(&mut self) -> Result<Option<Value>, String> {
        loop {
            let Some(line) = self.lines.next_line().await.map_err(|e| e.to_string())? else {
                return Ok(None);
            };
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                return Ok(Some(message));
            }
        }
    }

    async fn send_request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(&json!({"id": id, "method": method, "params": params})).await?;
        Ok(id)
    }

    /// Send a request and wait for its response. Anything else that comes
    /// in meanwhile is set aside: notifications are dropped, and requests
    /// from Codex are declined.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send_request(method, params).await?;
        loop {
            let message = self.next().await?.ok_or("Codex stopped unexpectedly.")?;
            if message.get("method").is_some() {
                if message.get("id").is_some() {
                    self.answer_other(&message, "").await?;
                }
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(error["message"].as_str().unwrap_or("Codex refused the request").to_string());
            }
            return Ok(message["result"].clone());
        }
    }

    async fn respond(&mut self, id: &Value, result: Value) -> Result<(), String> {
        self.write(&json!({"id": id, "result": result})).await
    }

    /// Answer a request from Codex that is not one of our tools: approvals
    /// are declined, everything else is refused.
    async fn answer_other(&mut self, message: &Value, conversation_id: &str) -> Result<(), String> {
        let method = message["method"].as_str().unwrap_or("");
        let id = &message["id"];
        eprintln!("[agent] {conversation_id}: codex asked for {method}: declined");
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                self.respond(id, json!({"decision": "decline"})).await
            }
            "execCommandApproval" | "applyPatchApproval" => self.respond(id, json!({"decision": "denied"})).await,
            "currentTime/read" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                self.respond(id, json!({"currentTimeAt": now})).await
            }
            _ => {
                self.write(&json!({
                    "id": id,
                    "error": {"code": -32601, "message": "Not available in Stoolap Desktop"},
                }))
                .await
            }
        }
    }

    fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
}

/// A Codex conversation: its server, and the thread on it
pub struct Session {
    server: Server,
    thread_id: String,
}

/// Our tools in Codex's dynamic tool format
fn dynamic_tools() -> Value {
    let tools = super::tools::definitions();
    Value::Array(
        tools
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": t["input_schema"],
                })
            })
            .collect(),
    )
}

pub struct RunArgs<'a> {
    pub codex: &'a Path,
    pub data_dir: &'a Path,
    pub workdir: &'a Path,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub prompt: &'a str,
}

/// Run one message. `session` is the conversation's Codex session: started
/// here on the first message, and left None when Codex has stopped.
pub async fn run(
    app: &AppHandle,
    target: &McpSession,
    session: &mut Option<Session>,
    args: RunArgs<'_>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let conversation_id = target.conversation_id.as_str();
    if session.as_mut().is_some_and(|s| s.server.exited()) {
        *session = None;
    }
    if session.is_none() {
        eprintln!("[agent] {conversation_id}: starting {} (model {})", args.codex.display(), args.model);
        let mut server = Server::start(args.codex, args.data_dir, args.workdir).await?;
        let started = server
            .request(
                "thread/start",
                json!({
                    "cwd": args.workdir,
                    "model": args.model,
                    "sandbox": "read-only",
                    // Commands would need approval, which is always declined
                    "approvalPolicy": "untrusted",
                    // Kept in memory only: nothing is written to the Codex home
                    "ephemeral": true,
                    "developerInstructions": args.system_prompt,
                    "dynamicTools": dynamic_tools(),
                }),
            )
            .await?;
        let thread_id = started["thread"]["id"].as_str().ok_or("Codex did not start a thread")?.to_string();
        *session = Some(Session { server, thread_id });
    }
    let s = session.as_mut().ok_or("no Codex session")?;
    let result = run_turn(app, target, s, &args, cancel).await;
    if s.server.exited() {
        *session = None;
    }
    result
}

async fn run_turn(
    app: &AppHandle,
    target: &McpSession,
    s: &mut Session,
    args: &RunArgs<'_>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let conversation_id = target.conversation_id.as_str();
    let thread_id = s.thread_id.clone();
    let started = s
        .server
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "model": args.model,
                "input": [{"type": "text", "text": args.prompt}],
            }),
        )
        .await?;
    let turn_id = started["turn"]["id"].as_str().unwrap_or_default().to_string();
    let mut last_error: Option<String> = None;
    let mut interrupted_at: Option<std::time::Instant> = None;

    loop {
        if cancel.load(Ordering::Relaxed) {
            match interrupted_at {
                None => {
                    s.server
                        .send_request("turn/interrupt", json!({"threadId": thread_id, "turnId": turn_id}))
                        .await?;
                    interrupted_at = Some(std::time::Instant::now());
                }
                // Codex did not wind the turn down: stop it
                Some(t) if t.elapsed() > Duration::from_secs(5) => {
                    let _ = s.server.child.kill().await;
                    return Err("cancelled".into());
                }
                Some(_) => {}
            }
        }
        let message = tokio::select! {
            m = s.server.next() => m?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
        };
        let Some(message) = message else {
            return Err("Codex stopped unexpectedly.".into());
        };
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        match method {
            "item/agentMessage/delta" => emit(app, conversation_id, Event::Text {
                delta: params["delta"].as_str().unwrap_or("").to_string(),
            }),
            "item/reasoning/summaryTextDelta" => emit(app, conversation_id, Event::Thinking {
                delta: params["delta"].as_str().unwrap_or("").to_string(),
            }),
            "item/tool/call" => {
                let name = params["tool"].as_str().unwrap_or("").to_string();
                let input = params["arguments"].clone();
                // Database reads, or waiting on the tab: both block
                let (app2, target2, tool) = (app.clone(), target.clone(), name.clone());
                let output = tauri::async_runtime::spawn_blocking(move || super::run_tool(&app2, &target2, &tool, &input))
                    .await
                    .map_err(|e| e.to_string())?;
                emit_tool(app, conversation_id, &name, &output);
                s.server
                    .respond(
                        &message["id"],
                        json!({
                            "contentItems": [{"type": "inputText", "text": output.content}],
                            "success": !output.is_error,
                        }),
                    )
                    .await?;
            }
            "item/started" => {
                // Anything but talking and our tools is worth a note in the log
                let kind = params["item"]["type"].as_str().unwrap_or("");
                if !matches!(kind, "agentMessage" | "reasoning" | "dynamicToolCall" | "userMessage") {
                    eprintln!("[agent] {conversation_id}: codex item {kind}");
                }
            }
            "error" => {
                if !params["willRetry"].as_bool().unwrap_or(false) {
                    last_error = params["error"]["message"].as_str().map(str::to_string);
                }
            }
            "turn/completed" if params["turn"]["id"].as_str() == Some(turn_id.as_str()) => {
                let turn = &params["turn"];
                return match turn["status"].as_str().unwrap_or("") {
                    "completed" => Ok(()),
                    "interrupted" => Err("cancelled".into()),
                    _ => Err(format!(
                        "Codex: {}",
                        turn["error"]["message"]
                            .as_str()
                            .map(str::to_string)
                            .or(last_error)
                            .unwrap_or_else(|| "the request failed".into())
                    )),
                };
            }
            _ if message.get("id").is_some() && !method.is_empty() => {
                s.server.answer_other(&message, conversation_id).await?;
            }
            _ => {}
        }
    }
}

/// Sign in with ChatGPT: Codex gives a URL to approve in the browser and
/// listens for the approval on a local port. Resolves once approved.
pub async fn login(codex: &Path, data_dir: &Path) -> Result<(), String> {
    let mut server = Server::start(codex, data_dir, &data_dir.join("agent")).await?;
    let started = server.request("account/login/start", json!({"type": "chatgpt"})).await?;
    let url = started["authUrl"].as_str().ok_or("Codex gave no sign-in address")?;
    open_in_browser(url)?;
    let wait = async {
        loop {
            let message = server.next().await?.ok_or("Codex stopped during the sign-in.")?;
            if message["method"] == "account/login/completed" {
                let p = &message["params"];
                return if p["success"].as_bool().unwrap_or(false) {
                    Ok(())
                } else {
                    Err(p["error"].as_str().unwrap_or("The sign-in did not finish.").to_string())
                };
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(6 * 60), wait)
        .await
        .map_err(|_| "The sign-in was not approved in time. Try again.".to_string())?
}

pub async fn logout(codex: &Path, data_dir: &Path) -> Result<(), String> {
    let mut server = Server::start(codex, data_dir, &data_dir.join("agent")).await?;
    server.request("account/logout", Value::Null).await.map(|_| ())
}

/// The models the signed-in account can use: (id, display name)
pub async fn models(codex: &Path, data_dir: &Path) -> Result<Vec<(String, String)>, String> {
    let mut server = Server::start(codex, data_dir, &data_dir.join("agent")).await?;
    let list = server.request("model/list", json!({})).await?;
    Ok(parse_models(&list))
}

fn parse_models(list: &Value) -> Vec<(String, String)> {
    let mut models: Vec<&Value> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !m["hidden"].as_bool().unwrap_or(false))
        .collect();
    // The account's default first
    models.sort_by_key(|m| !m["isDefault"].as_bool().unwrap_or(false));
    models
        .into_iter()
        .filter_map(|m| {
            let id = m["model"].as_str().or(m["id"].as_str())?;
            Some((id.to_string(), m["displayName"].as_str().unwrap_or(id).to_string()))
        })
        .collect()
}

pub(super) fn open_in_browser(url: &str) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    cmd.arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_our_tools_as_dynamic_tools() {
        let tools = dynamic_tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"write_query") && names.contains(&"list_tables"));
        assert!(tools.as_array().unwrap().iter().all(|t| t["type"] == "function" && t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn lists_visible_models_default_first() {
        let list = json!({"data": [
            {"model": "a", "displayName": "A", "hidden": false, "isDefault": false},
            {"model": "h", "displayName": "H", "hidden": true, "isDefault": false},
            {"model": "b", "displayName": "B", "hidden": false, "isDefault": true},
        ]});
        assert_eq!(parse_models(&list), vec![("b".into(), "B".into()), ("a".into(), "A".into())]);
    }
}
