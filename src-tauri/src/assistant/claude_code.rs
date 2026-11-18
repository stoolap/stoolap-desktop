//! Runs the assistant through the user's local Claude Code (`claude -p`),
//! signed in with their own account. Its built-in tools are turned off; the
//! only tools it gets are ours, over the local MCP server.

use super::{emit, Event};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[cfg(windows)]
const NAMES: &[&str] = &["claude.exe", "claude.cmd"];
#[cfg(not(windows))]
const NAMES: &[&str] = &["claude"];

/// Find the `claude` executable.
pub fn find() -> Option<PathBuf> {
    find_named(NAMES, "claude")
}

/// Find a CLI by its file names. Apps started from the Dock or Start menu
/// don't get the shell's PATH, so look in the usual install places too.
pub(super) fn find_named(
    names: &[&str],
    // Only the login-shell lookup uses it, and Windows has none
    #[cfg_attr(windows, allow(unused_variables))] command: &str,
) -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(h) = &home {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
            dirs.push(h.join(d));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    for dir in &dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(not(windows))]
    {
        // Last resort: ask the user's login shell
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let out = std::process::Command::new(shell)
            .args(["-lc", &format!("command -v {command}")])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// `<cli> --version`, e.g. "2.1.327 (Claude Code)"
pub fn version(path: &Path) -> Option<String> {
    let out = command(path).arg("--version").stdin(Stdio::null()).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// PATH for the child: an npm-installed `claude` is a Node script, and Node
/// lives next to it or in the usual places, not on the app's PATH.
pub(super) fn command(path: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(path);
    cmd.env("PATH", child_path(path));
    cmd
}

fn child_path(path: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = path.parent().map(|p| vec![p.to_path_buf()]).unwrap_or_default();
    if !cfg!(windows) {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

pub struct RunArgs<'a> {
    pub claude: &'a Path,
    pub workdir: &'a Path,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub mcp_url: &'a str,
    pub resume: Option<&'a str>,
    pub prompt: &'a str,
}

/// Run one message. Returns the Claude Code session id to resume next time.
pub async fn run(
    app: &AppHandle,
    target: &super::mcp::McpSession,
    args: RunArgs<'_>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let conversation_id = target.conversation_id.as_str();
    let mcp_config = json!({
        "mcpServers": {
            super::mcp::SERVER_NAME: {"type": "http", "url": args.mcp_url}
        }
    })
    .to_string();
    let allowed = format!("mcp__{}", super::mcp::SERVER_NAME);
    let mut cmd = tokio::process::Command::new(args.claude);
    cmd.env("PATH", child_path(args.claude))
        .current_dir(args.workdir)
        .args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--model", args.model])
        // No built-in tools (shell, files, web): only the database tools below
        .args(["--tools", ""])
        .args(["--mcp-config", &mcp_config, "--strict-mcp-config"])
        .args(["--allowedTools", &allowed])
        .args(["--system-prompt", args.system_prompt]);
    if let Some(id) = args.resume {
        cmd.args(["--resume", id]);
    }
    eprintln!(
        "[assistant] {conversation_id}: running {} (model {}, resume {:?})",
        args.claude.display(),
        args.model,
        args.resume
    );
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start Claude Code: {e}"))?;

    // The prompt goes in on stdin: no length limit, no shell quoting
    let mut stdin = child.stdin.take().ok_or("Claude Code has no stdin")?;
    stdin
        .write_all(args.prompt.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(stdin);

    let mut stderr = child.stderr.take().ok_or("Claude Code has no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let stdout = child.stdout.take().ok_or("Claude Code has no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut session_id = args.resume.unwrap_or_default().to_string();
    let mut outcome: Option<Result<(), String>> = None;
    // Tool calls streaming in this message: index -> (tool name, input so far)
    let mut tool_inputs: std::collections::HashMap<u64, (String, String)> = Default::default();

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err("cancelled".into());
        }
        let line = tokio::select! {
            l = lines.next_line() => l.map_err(|e| e.to_string())?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
        };
        let Some(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = msg["type"].as_str().unwrap_or("");
        if kind != "stream_event" {
            eprintln!("[assistant] {conversation_id}: claude {kind} {}", msg["subtype"].as_str().unwrap_or(""));
        }
        match kind {
            "system" if msg["subtype"] == "init" => {
                if let Some(id) = msg["session_id"].as_str() {
                    session_id = id.to_string();
                }
            }
            "stream_event" => {
                let event = &msg["event"];
                let index = event["index"].as_u64().unwrap_or(0);
                if event["type"] == "message_start" {
                    tool_inputs.clear();
                }
                if event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use" {
                    let name = event["content_block"]["name"].as_str().unwrap_or("").to_string();
                    tool_inputs.insert(index, (name, String::new()));
                }
                if event["type"] == "content_block_delta" {
                    let delta = &event["delta"];
                    match delta["type"].as_str().unwrap_or("") {
                        "input_json_delta" => {
                            if let Some((name, partial)) = tool_inputs.get_mut(&index) {
                                partial.push_str(delta["partial_json"].as_str().unwrap_or(""));
                                super::draft(app, target, name, partial);
                            }
                        }
                        "text_delta" => emit(app, conversation_id, Event::Text {
                            delta: delta["text"].as_str().unwrap_or("").to_string(),
                        }),
                        "thinking_delta" => emit(app, conversation_id, Event::Thinking {
                            delta: delta["thinking"].as_str().unwrap_or("").to_string(),
                        }),
                        _ => {}
                    }
                }
            }
            "result" => {
                if let Some(id) = msg["session_id"].as_str() {
                    session_id = id.to_string();
                }
                outcome = Some(if msg["is_error"].as_bool().unwrap_or(false) {
                    let detail = msg["result"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| msg["subtype"].as_str())
                        .unwrap_or("unknown error");
                    Err(format!("Claude Code: {detail}"))
                } else {
                    Ok(())
                });
            }
            _ => {}
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if !stderr.trim().is_empty() {
        eprintln!("[assistant] {conversation_id}: claude stderr: {}", stderr.trim());
    }
    match outcome {
        Some(Ok(())) => Ok(session_id),
        Some(Err(e)) => Err(e),
        None => {
            let tail: String = stderr.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            Err(if tail.is_empty() {
                format!("Claude Code exited ({status}) without an answer.")
            } else {
                format!("Claude Code exited ({status}): {tail}")
            })
        }
    }
}
