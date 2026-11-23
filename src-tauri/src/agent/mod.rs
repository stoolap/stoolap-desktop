//! SQL agent over the open connection, through one of these backends:
//!
//! - the user's local Claude Code (`claude -p`, their own sign-in), given the
//!   tools through a local MCP server ([claude_code], [mcp]);
//! - the Claude API with an API key or a browser sign-in, a tool-use loop
//!   run here so the credential never leaves Rust ([api], [console]);
//! - the user's local Codex, signed in to ChatGPT in the app's own Codex
//!   home, given the tools as dynamic tools ([codex]);
//! - the OpenAI API with an API key, a tool loop run here ([openai]).
//!
//! Progress streams to the renderer as `agent:event` events.

pub(crate) mod api;
mod claude_code;
mod codex;
mod console;
pub(crate) mod docs_index;
mod mcp;
mod openai;
mod partial_json;
pub mod tools;

use crate::db::DbManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use mcp::McpSession;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::i18n::t;

const KEYCHAIN_SERVICE: &str = "com.stoolap.desktop";
/// Keychain entries of the API keys, by provider
fn keychain_user(provider: &str) -> Result<&'static str, String> {
    match provider {
        "anthropic" => Ok("anthropic-api-key"),
        "openai" => Ok("openai-api-key"),
        other => Err(format!("Unknown provider {other}")),
    }
}
/// Model turns per request before the loop gives up
const MAX_TURNS: usize = 16;

/// The Stoolap SQL dialect, written for the agent and checked against
/// the engine (every ```sql block runs in a test below).
const SQL_GUIDE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/agent/stoolap-sql-guide.md"
));

#[derive(Default)]
struct Conversation {
    /// API backend: messages exactly as sent to and received from the API
    messages: Vec<Value>,
    /// Claude Code backend: the session to resume
    claude_session: Option<String>,
    /// OpenAI API backend: the conversation's input items
    openai_items: Vec<Value>,
    /// Codex backend: its running server and thread (out while a request runs)
    codex: Option<codex::Session>,
    /// Which kind of history the fields above hold (history_kind)
    history_kind: &'static str,
    /// The backend has none of what was said yet: the panel's transcript
    /// goes with each request until one completes
    needs_transcript: bool,
    cancel: Arc<AtomicBool>,
    running: bool,
}

/// Backends that can continue each other's history: the API key and the
/// Anthropic account send the same messages.
fn history_kind(backend: &str) -> &'static str {
    match backend {
        "api" | "console" => "anthropic",
        "claude-code" => "claude-code",
        "codex" => "codex",
        _ => "openai",
    }
}

impl Conversation {
    /// Ready the conversation for a request on `backend`. Returns true when
    /// that backend has none of what was said, so the panel's transcript
    /// must come with the message: a conversation new here (the app
    /// restarted), or one that was on another backend until now, whose
    /// history that backend can't read (and which would miss the turns in
    /// between if it were picked up again later). Stays true until a
    /// request completes, so a failed or stopped first request doesn't
    /// lose the transcript.
    fn start_on(&mut self, backend: &str, new_here: bool) -> bool {
        let kind = history_kind(backend);
        let switched = !new_here && self.history_kind != kind;
        if switched {
            self.messages.clear();
            self.claude_session = None;
            self.openai_items.clear();
            self.codex = None;
        }
        self.history_kind = kind;
        self.needs_transcript |= new_here || switched;
        self.needs_transcript
    }
}

#[derive(Default)]
pub struct AgentState {
    conversations: Mutex<HashMap<String, Conversation>>,
    mcp_port: Mutex<Option<u16>>,
    /// MCP path token -> what that request's tools act on
    mcp_sessions: Mutex<HashMap<String, mcp::McpSession>>,
    /// write_query calls waiting for the renderer to run the SQL in the tab
    pending_writes: Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>,
}

/// Which backends this machine can use
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backends {
    claude_code: Option<ClaudeCodeInfo>,
    has_api_key: bool,
    has_openai_key: bool,
    /// The local Codex, and whether the app's Codex home is signed in
    codex: Option<CodexInfo>,
    /// Browser sign-in (through Anthropic's `ant` CLI, fetched on first
    /// use); None where it isn't available
    console: Option<ConsoleInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInfo {
    path: String,
    version: Option<String>,
    signed_in: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleInfo {
    /// The app's copy of `ant` has been downloaded
    installed: bool,
    signed_in: bool,
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeInfo {
    path: String,
    version: Option<String>,
}

/// The editor state the request is about, and where the answer goes
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    /// The tab the user is looking at
    tab_title: String,
    sql: String,
    selection: Option<String>,
    last_error: Option<String>,
    /// The tab the agent writes into: this one, or one of its own
    target_tab_id: String,
    target_tab_title: String,
    /// "memory" or "file"; a file database's folder
    #[serde(default)]
    storage: String,
    #[serde(default)]
    path: Option<String>,
    /// When an in-memory database opened (its history starts there)
    #[serde(default)]
    opened_at: Option<String>,
    #[serde(default)]
    tabs: Vec<tools::TabSnapshot>,
    #[serde(default)]
    runs: Vec<Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
}

#[derive(Serialize, Clone)]
// rename_all names the variants; the fields need rename_all_fields
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Event {
    Text { delta: String },
    Thinking { delta: String },
    Tool {
        id: String,
        name: String,
        summary: String,
        is_error: bool,
        /// What the step shows when opened (check_query's SQL and rows)
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<Value>,
    },
    /// write_query's SQL so far, while it streams in
    Draft { tab_id: String, sql: String },
    /// write_query's complete SQL: write it into the tab, maybe run it, and
    /// answer with agent_write_result
    /// `conn_id` is the database the request is about; it runs only there
    Write {
        request_id: String,
        conn_id: String,
        tab_id: String,
        sql: String,
        explanation: String,
        /// A name for the agent's own tab
        title: String,
        allow_writes: bool,
    },
    Done,
    Error { message: String },
    Cancelled,
}

fn emit(app: &AppHandle, conversation_id: &str, event: Event) {
    let _ = app.emit(
        "agent:event",
        json!({"conversationId": conversation_id, "event": event}),
    );
}

fn emit_tool(app: &AppHandle, conversation_id: &str, name: &str, output: &tools::Output) {
    emit(
        app,
        conversation_id,
        Event::Tool {
            id: String::new(),
            name: name.to_string(),
            summary: output.summary.clone(),
            is_error: output.is_error,
            detail: output.detail.clone(),
        },
    );
}

fn keychain(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, keychain_user(provider)?).map_err(|e| e.to_string())
}

fn read_key(provider: &str) -> Option<String> {
    keychain(provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

/// Whether a backend talks to Claude or to OpenAI
fn is_openai(backend: &str) -> bool {
    matches!(backend, "codex" | "openai")
}

/// The models a backend offers; the first is the default.
#[tauri::command]
pub async fn agent_models(app: AppHandle, backend: String) -> Result<Vec<ModelInfo>, String> {
    let list: Vec<(String, String)> = match backend.as_str() {
        "codex" => {
            let path = codex::find().ok_or_else(|| t("errors.codexNotFound", &[]))?;
            codex::models(&path, &data_dir(&app)?).await?
        }
        "openai" => openai::models(&read_key("openai").ok_or_else(|| t("errors.addOpenaiKey", &[]))?).await?,
        // Claude's come from the account; Claude Code has no list to ask
        backend => {
            let credential = match backend {
                "api" => read_key("anthropic").map(api::Credential::ApiKey),
                "console" => console::Ant::installed(&data_dir(&app)?).map(api::Credential::Console),
                _ => None,
            };
            let listed = match credential {
                Some(c) => api::models(&c).await.unwrap_or_else(|e| {
                    eprintln!("Couldn't list Claude models, offering the built-in ones: {e}");
                    Vec::new()
                }),
                None => Vec::new(),
            };
            if listed.is_empty() {
                api::MODELS.iter().map(|(id, name)| (id.to_string(), name.to_string())).collect()
            } else {
                listed
            }
        }
    };
    Ok(list.into_iter().map(|(id, name)| ModelInfo { id, name }).collect())
}

#[tauri::command]
pub async fn agent_backends(app: AppHandle) -> Backends {
    let data = data_dir(&app).ok();
    // Finding and asking the CLIs spawns processes: keep it off the main thread
    tauri::async_runtime::spawn_blocking(move || Backends {
        claude_code: claude_code::find().map(|p| ClaudeCodeInfo {
            version: claude_code::version(&p),
            path: p.to_string_lossy().into_owned(),
        }),
        has_api_key: read_key("anthropic").is_some(),
        has_openai_key: read_key("openai").is_some(),
        codex: codex::find().map(|p| CodexInfo {
            version: codex::version(&p),
            path: p.to_string_lossy().into_owned(),
            signed_in: data.as_deref().is_some_and(codex::signed_in),
        }),
        console: console::supported().then(|| {
            let ant = data.as_deref().and_then(console::Ant::installed);
            ConsoleInfo {
                installed: ant.is_some(),
                signed_in: ant.is_some_and(|a| a.access_token().is_some()),
            }
        }),
    })
    .await
    .unwrap_or(Backends {
        claude_code: None,
        has_api_key: false,
        has_openai_key: false,
        codex: None,
        console: None,
    })
}

/// Sign the app's Codex home in to ChatGPT in the browser. Resolves when
/// the user has approved it (or it failed or timed out).
#[tauri::command]
pub async fn agent_codex_login(app: AppHandle) -> Result<(), String> {
    let path = codex::find().ok_or_else(|| t("errors.codexNotFound", &[]))?;
    codex::login(&path, &data_dir(&app)?).await
}

#[tauri::command]
pub async fn agent_codex_logout(app: AppHandle) -> Result<(), String> {
    let path = codex::find().ok_or_else(|| t("errors.codexNotFound", &[]))?;
    codex::logout(&path, &data_dir(&app)?).await
}

/// Open a link from a reply in the browser; only web links.
#[tauri::command]
pub fn agent_open_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(t("errors.onlyWebLinks", &[]));
    }
    codex::open_in_browser(&url)
}

/// Fetch the app's copy of `ant` (once; checked against its pinned SHA-256).
#[tauri::command]
pub async fn agent_console_install(app: AppHandle) -> Result<(), String> {
    console::install(&data_dir(&app)?).await.map(|_| ())
}

/// Sign in to the Claude API in the browser, through `ant auth login`.
/// Resolves when the user has approved it (or it failed or timed out).
#[tauri::command]
pub async fn agent_console_login(app: AppHandle) -> Result<(), String> {
    console::install(&data_dir(&app)?).await?.login().await
}

#[tauri::command]
pub async fn agent_console_logout(app: AppHandle) -> Result<(), String> {
    match console::Ant::installed(&data_dir(&app)?) {
        Some(ant) => tauri::async_runtime::spawn_blocking(move || ant.logout())
            .await
            .map_err(|e| e.to_string())?,
        None => Ok(()),
    }
}

/// Stored in the OS credential store (Keychain, Credential Manager, Secret
/// Service); never returned to the renderer.
#[tauri::command]
pub fn agent_set_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(t("errors.emptyKey", &[]));
    }
    keychain(&provider)?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_delete_key(provider: String) -> Result<(), String> {
    match keychain(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn agent_reset(state: State<'_, AgentState>, conversation_id: String) {
    if let Ok(mut convs) = state.conversations.lock() {
        if let Some(c) = convs.get_mut(&conversation_id) {
            c.cancel.store(true, Ordering::Relaxed);
        }
        convs.remove(&conversation_id);
    }
}

#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, conversation_id: String) {
    if let Ok(convs) = state.conversations.lock() {
        if let Some(c) = convs.get(&conversation_id) {
            c.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Start one request. Returns at once; progress arrives as events.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    conversation_id: String,
    conn_id: String,
    connection_name: String,
    backend: String,
    model: String,
    allow_writes: bool,
    text: String,
    context: EditorContext,
    // The conversation so far as the panel shows it, for when this side has
    // lost it (the app restarted) or the backend changed: Conversation::start_on
    earlier: Option<String>,
) -> Result<(), String> {
    // OpenAI's models come from the account; Claude's are a fixed list
    if model.is_empty() || (!is_openai(&backend) && !api::MODELS.iter().any(|(id, _)| *id == model)) {
        return Err(format!("Unknown model {model}"));
    }
    enum Via {
        ClaudeCode(std::path::PathBuf),
        Api(api::Credential),
        Codex(std::path::PathBuf),
        OpenAi(String),
    }
    let via = match backend.as_str() {
        "claude-code" => Via::ClaudeCode(
            claude_code::find().ok_or_else(|| t("errors.claudeCodeNotFound", &[]))?,
        ),
        "api" => Via::Api(api::Credential::ApiKey(read_key("anthropic").ok_or_else(|| t("errors.addAnthropicKey", &[]))?)),
        "codex" => {
            if !codex::signed_in(&data_dir(&app)?) {
                return Err(t("errors.signInChatgpt", &[]));
            }
            Via::Codex(codex::find().ok_or_else(|| t("errors.codexNotFoundUseKey", &[]))?)
        }
        "openai" => Via::OpenAi(read_key("openai").ok_or_else(|| t("errors.addOpenaiKey", &[]))?),
        "console" => Via::Api(api::Credential::Console(
            console::Ant::installed(&data_dir(&app)?)
                .ok_or_else(|| t("errors.signInAnthropic", &[]))?,
        )),
        other => return Err(format!("Unknown agent backend {other}")),
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let (history, claude_session, openai_items, mut codex_session, fresh) = {
        let mut convs = state.conversations.lock().map_err(|e| e.to_string())?;
        let new_here = !convs.contains_key(&conversation_id);
        let conv = convs.entry(conversation_id.clone()).or_default();
        if conv.running {
            return Err(t("errors.stillWorking", &[]));
        }
        let fresh = conv.start_on(&backend, new_here);
        conv.running = true;
        conv.cancel = cancel.clone();
        (conv.messages.clone(), conv.claude_session.clone(), conv.openai_items.clone(), conv.codex.take(), fresh)
    };

    // The user's session may be inside a transaction they began
    let in_transaction = open_transaction(&app, &conn_id);
    let mut prompt = user_text(&text, &connection_name, allow_writes, in_transaction, &context);
    if let Some(earlier) = earlier.filter(|e| fresh && !e.trim().is_empty()) {
        prompt = format!("<earlier_conversation>\n{}\n</earlier_conversation>\n\n{prompt}", earlier.trim());
    }
    let target = McpSession {
        conversation_id: conversation_id.clone(),
        conn_id: conn_id.clone(),
        allow_writes,
        tab_id: context.target_tab_id.clone(),
        tab_title: context.target_tab_title.clone(),
        live: Arc::new(Mutex::new(tools::Live { tabs: context.tabs.clone(), runs: context.runs.clone() })),
    };

    tauri::async_runtime::spawn(async move {
        let result = match via {
            Via::Api(credential) => {
                let mut messages = history;
                messages.push(json!({"role": "user", "content": prompt}));
                run_loop(&app, &target, &model, &credential, &mut messages, &cancel)
                .await
                // Keep the exchange only when it completed, so the history the
                // next request sends is always well formed.
                .map(|()| Outcome::Messages(messages))
            }
            Via::ClaudeCode(claude) => {
                run_claude_code(&app, &claude, target, &model, &prompt, claude_session.as_deref(), &cancel)
                    .await
                    .map(Outcome::ClaudeSession)
            }
            Via::OpenAi(key) => {
                let mut items = openai_items;
                items.push(json!({"role": "user", "content": prompt}));
                openai::run_loop(&app, &target, &model, &key, &system_prompt(), &mut items, &cancel)
                    .await
                    .map(|()| Outcome::OpenAiItems(items))
            }
            Via::Codex(path) => match data_dir(&app) {
                Ok(data) => {
                    let workdir = data.join("agent");
                    let args = codex::RunArgs {
                        codex: &path,
                        data_dir: &data,
                        workdir: &workdir,
                        model: &model,
                        system_prompt: &system_prompt(),
                        prompt: &prompt,
                    };
                    codex::run(&app, &target, &mut codex_session, args, &cancel).await.map(|()| Outcome::None)
                }
                Err(e) => Err(e),
            },
        };

        let state = app.state::<AgentState>();
        let result = result.map(|outcome| {
            if let Ok(mut convs) = state.conversations.lock() {
                if let Some(conv) = convs.get_mut(&conversation_id) {
                    conv.needs_transcript = false;
                    match outcome {
                        Outcome::Messages(m) => conv.messages = m,
                        Outcome::ClaudeSession(id) => conv.claude_session = Some(id),
                        Outcome::OpenAiItems(items) => conv.openai_items = items,
                        Outcome::None => {}
                    }
                }
            }
        });
        if let Ok(mut convs) = state.conversations.lock() {
            if let Some(conv) = convs.get_mut(&conversation_id) {
                conv.running = false;
                // A reset conversation is gone: its Codex stops with this drop
                conv.codex = codex_session.take();
            }
        }
        if let Err(e) = &result {
            eprintln!("[agent] {conversation_id}: request ended: {e}");
        }
        match result {
            Ok(()) => emit(&app, &conversation_id, Event::Done),
            Err(e) if e == "cancelled" => emit(&app, &conversation_id, Event::Cancelled),
            Err(message) => emit(&app, &conversation_id, Event::Error { message }),
        }
    });
    Ok(())
}

enum Outcome {
    Messages(Vec<Value>),
    ClaudeSession(String),
    OpenAiItems(Vec<Value>),
    /// Kept elsewhere (the Codex session)
    None,
}

async fn run_claude_code(
    app: &AppHandle,
    claude: &std::path::Path,
    session: McpSession,
    model: &str,
    prompt: &str,
    resume: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let port = mcp::ensure_started(app)?;
    // A fresh token per request, removed when it ends
    let token = uuid::Uuid::new_v4().to_string();
    let state = app.state::<AgentState>();
    state
        .mcp_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(token.clone(), session.clone());

    // An empty working directory: no project files or CLAUDE.md to pick up
    let workdir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    std::fs::create_dir_all(&workdir).map_err(|e| e.to_string())?;

    let result = claude_code::run(
        app,
        &session,
        claude_code::RunArgs {
            claude,
            workdir: &workdir,
            model,
            system_prompt: &system_prompt(),
            mcp_url: &format!("http://127.0.0.1:{port}/mcp/{token}"),
            resume,
            prompt,
        },
        cancel,
    )
    .await;
    if let Ok(mut sessions) = state.mcp_sessions.lock() {
        sessions.remove(&token);
    }
    result
}

async fn run_loop(
    app: &AppHandle,
    target: &McpSession,
    model: &str,
    credential: &api::Credential,
    messages: &mut Vec<Value>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let system = system_prompt();
    let tools = tools::definitions();
    let conversation_id = target.conversation_id.as_str();

    for _ in 0..MAX_TURNS {
        let body = api::request_body(model, &system, &tools, messages);
        let turn = api::stream_turn(credential, &body, cancel, |ev| match ev {
            api::StreamEvent::Text(t) => {
                emit(app, conversation_id, Event::Text { delta: t.to_string() })
            }
            api::StreamEvent::Thinking(t) => {
                emit(app, conversation_id, Event::Thinking { delta: t.to_string() })
            }
            api::StreamEvent::ToolInput { name, partial } => draft(app, target, name, partial),
        })
        .await?;

        match turn.stop_reason.as_str() {
            "refusal" => {
                return Err(t("errors.claudeDeclined", &[]));
            }
            "max_tokens" => {
                return Err(t("errors.outputLimit", &[]));
            }
            _ => {}
        }

        let tool_uses: Vec<Value> = turn
            .content
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .cloned()
            .collect();
        messages.push(json!({"role": "assistant", "content": turn.content}));
        if turn.stop_reason != "tool_use" || tool_uses.is_empty() {
            return Ok(());
        }

        // Every tool result goes back in one user message.
        let mut results = Vec::new();
        for call in tool_uses {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let id = call["id"].as_str().unwrap_or_default().to_string();
            let name = call["name"].as_str().unwrap_or_default().to_string();
            let output = if let Some((_, raw)) = turn.invalid_inputs.iter().find(|(i, _)| *i == id) {
                tools::Output {
                    content: json!({"INVALID_JSON": raw}).to_string(),
                    is_error: true,
                    summary: format!("{name}: invalid input"),
                    detail: None,
                }
            } else {
                // Both kinds block: database reads, or waiting on the tab
                let app = app.clone();
                let target = target.clone();
                let input = call["input"].clone();
                let tool_name = name.clone();
                tauri::async_runtime::spawn_blocking(move || run_tool(&app, &target, &tool_name, &input))
                    .await
                    .map_err(|e| e.to_string())?
            };
            emit_tool(app, conversation_id, &name, &output);
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": output.content,
                "is_error": output.is_error,
            }));
        }
        messages.push(json!({"role": "user", "content": results}));
    }
    Err(t("errors.tooManySteps", &[]))
}

/// Run one tool call for either backend (blocking).
pub(super) fn run_tool(app: &AppHandle, target: &McpSession, name: &str, input: &Value) -> tools::Output {
    if name == "write_query" {
        write_query(app, target, input)
    } else {
        let db = app.state::<DbManager>();
        tools::run(&db, target, name, input)
    }
}

/// Whether the user's session on the connection is inside a transaction
fn open_transaction(app: &AppHandle, conn_id: &str) -> bool {
    app.state::<DbManager>()
        .transaction_state(conn_id)
        .is_ok_and(|t| t.load(std::sync::atomic::Ordering::Relaxed))
}

/// Stream write_query's SQL into the tab as it is generated.
pub(super) fn draft(app: &AppHandle, target: &McpSession, tool: &str, partial: &str) {
    if tool != "write_query" && !tool.ends_with("__write_query") {
        return;
    }
    if let Some(sql) = partial_json::string_field(partial, "sql") {
        emit(
            app,
            &target.conversation_id,
            Event::Draft { tab_id: target.tab_id.clone(), sql },
        );
    }
}

/// Longest a write_query waits for the tab to run the SQL
const WRITE_WAIT: std::time::Duration = std::time::Duration::from_secs(65 * 60);

/// Hand the SQL to the renderer, which writes it into the tab and runs it
/// when it only reads, then wait for what happened there.
fn write_query(app: &AppHandle, target: &McpSession, input: &Value) -> tools::Output {
    let sql = input["sql"].as_str().unwrap_or_default();
    let explanation = input["explanation"].as_str().unwrap_or_default();
    if sql.trim().is_empty() {
        return tools::Output {
            content: "write_query needs the complete new SQL".into(),
            is_error: true,
            summary: "Empty SQL".into(),
            detail: None,
        };
    }
    let was_open = open_transaction(app, &target.conn_id);
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let state = app.state::<AgentState>();
    if let Ok(mut pending) = state.pending_writes.lock() {
        pending.insert(request_id.clone(), tx);
    }
    emit(
        app,
        &target.conversation_id,
        Event::Write {
            request_id: request_id.clone(),
            conn_id: target.conn_id.clone(),
            tab_id: target.tab_id.clone(),
            sql: sql.to_string(),
            explanation: explanation.to_string(),
            // null keeps the tab's name
            title: input["title"].as_str().unwrap_or_default().trim().to_string(),
            allow_writes: target.allow_writes,
        },
    );
    let outcome = rx.recv_timeout(WRITE_WAIT);
    if let Ok(mut pending) = state.pending_writes.lock() {
        pending.remove(&request_id);
    }
    match outcome {
        Ok(outcome) => {
            // The renderer's view of the tabs and runs after this write
            if let Some(ctx) = outcome.get("context") {
                if let (Ok(live), Ok(mut shared)) = (serde_json::from_value::<tools::Live>(ctx.clone()), target.live.lock()) {
                    *shared = live;
                }
            }
            // The tab's name now: the agent may have just named it
            let tab = outcome["tabTitle"].as_str().unwrap_or(&target.tab_title);
            let mut output = tools::format_run(&outcome, tab);
            // Say where the user's transaction stands, every time, without
            // repeating what an error already said
            let now_open = open_transaction(app, &target.conn_id);
            let note = match (was_open, now_open) {
                (false, true) => "The user's session now has an open transaction: what ran is not committed until COMMIT (or undone by ROLLBACK).",
                (true, true) if output.content.contains("still open") => "",
                (true, true) => "The user's session is still in its open transaction: nothing is committed until COMMIT.",
                (true, false) => "The user's transaction is now closed.",
                (false, false) => "The user's session has no open transaction.",
            };
            if !note.is_empty() {
                output.content.push_str(&format!("\n\n{note}"));
            }
            output
        }
        Err(_) => tools::Output {
            content: "Written into the tab; no result came back from running it.".into(),
            is_error: false,
            summary: t("steps.wroteSql", &[("tab", &target.tab_title)]),
            detail: None,
        },
    }
}

/// The renderer's report of running a write_query in the tab
#[tauri::command]
pub fn agent_write_result(state: State<'_, AgentState>, request_id: String, outcome: Value) {
    if let Ok(pending) = state.pending_writes.lock() {
        if let Some(tx) = pending.get(&request_id) {
            let _ = tx.send(outcome);
        }
    }
}

fn user_text(text: &str, connection: &str, allow_writes: bool, in_transaction: bool, ctx: &EditorContext) -> String {
    // Where the database lives: COPY paths and AS OF depend on it
    let storage = match (ctx.storage.as_str(), ctx.path.as_deref()) {
        ("memory", _) => match ctx.opened_at.as_deref() {
            Some(at) => format!(" storage=\"memory\" opened=\"{at}\""),
            None => " storage=\"memory\"".to_string(),
        },
        (_, Some(path)) => format!(" storage=\"file\" path=\"{path}\""),
        _ => String::new(),
    };
    let mut s = format!(
        "{text}\n\n<editor tab=\"{}\" connection=\"{connection}\"{storage}{} write_into=\"{}\" run_writes=\"{}\">\n<sql>\n{}\n</sql>\n",
        ctx.tab_title,
        if in_transaction { " transaction=\"open\"" } else { "" },
        ctx.target_tab_title,
        if allow_writes { "allowed" } else { "ask" },
        ctx.sql,
    );
    if let Some(sel) = ctx.selection.as_deref().filter(|s| !s.trim().is_empty()) {
        s.push_str(&format!("<selection>\n{sel}\n</selection>\n"));
    }
    if let Some(e) = ctx.last_error.as_deref().filter(|s| !s.trim().is_empty()) {
        s.push_str(&format!("<last_error>\n{e}\n</last_error>\n"));
    }
    s.push_str("</editor>");
    s
}

fn system_prompt() -> String {
    format!(
        "You are the SQL agent in Stoolap Desktop, a desktop client for the Stoolap embedded SQL database (version 0.5). \
You help the user write, fix, explain and speed up SQL for the database they have open.\n\n\
How to work:\n\
- Each user message ends with an <editor> block: the SQL in the tab the user is looking at, their selection if any, and the last error that tab showed. \
\"This query\" means that SQL; a selection narrows what they are asking about. write_into names the tab your write_query calls go to: \
that same tab, or a tab of your own (then start from the SQL above when the user asks about it). storage says whether the database is in memory \
or a folder on disk (path), which matters for COPY file paths and for what survives a restart. transaction=\"open\" means the user's session \
is inside a transaction: what runs in the tab is not committed until COMMIT, and your checks don't see its uncommitted changes. Other tabs: list_tabs, then read_tab. \
What the user ran before on this database, with timings: query_history.\n\
- You work in that tab, in front of the user. write_query replaces its SQL with what you pass (they watch it appear) and runs it there, \
so the result grid shows it; you get the outcome back, rows included. Use it for the query the user asked for and for anything they should see.\n\
- To verify something for yourself (a count, whether a value exists, the distinct values of a column, a quick plan) use check_query: \
one read-only statement, run in a transaction that is rolled back, without touching the tab. The user still sees each check in the panel. \
Check instead of guessing when an answer depends on the data, but keep checks few and small (aggregates, LIMIT). \
When the user asks to see a plan or a result, that goes in the tab (write_query); a plan you only need for your own diagnosis is a check. \
After a write the user allowed (INSERT, UPDATE, DELETE, DDL), confirm it took effect with a check before saying it did.\n\
- Look at the real schema with list_tables and describe_table before writing SQL against it; don't guess table or column names.\n\
- Stoolap is not PostgreSQL, MySQL or SQLite. Write SQL by the guide below; it lists every type and function that exists and what fails. \
For anything it doesn't cover, use search_stoolap_docs (and read_stoolap_docs for a whole page) before relying on it. \
When a run fails, read the error and fix the SQL rather than guessing again.\n\
- Every write_query replaces the tab, so keep the number of tries small, and leave the tab holding the final SQL the user asked for.\n\
- Never paste result rows into your reply; the user sees them in the grid.\n\
- Reads always run. SQL that can change data (INSERT, UPDATE, DELETE, DDL) or several statements runs only when run_writes=\"allowed\"; \
otherwise it is written into the tab and waits for the user to press Run, so say what it will do. Even when allowed, change only what the user asked for.\n\
- A message may start with an <earlier_conversation> block: what was said before the app restarted. Treat it as the conversation so far.\n\
- Replies render as GitHub-flavoured Markdown; fenced code blocks get a Copy button and ```sql blocks are highlighted. \
A code block that itself contains a fenced block (a gh command with a Markdown body, say) is fenced with four backticks.\n\
- Keep replies short. Answer in the language the user writes in. Don't repeat SQL you wrote into the tab.\n\n\
{SQL_GUIDE}\n\n\
Documentation pages for read_stoolap_docs:\n{}\n",
        tools::page_list()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backend_taking_over_a_conversation_gets_the_transcript() {
        let mut c = Conversation::default();
        assert!(c.start_on("claude-code", true), "new here");
        assert!(c.start_on("claude-code", false), "until a request completes");
        c.needs_transcript = false;
        c.claude_session = Some("s".into());
        assert!(!c.start_on("claude-code", false), "same backend continues");
        assert!(c.start_on("openai", false), "OpenAI can't read Claude Code's history");
        assert_eq!(c.claude_session, None, "dropped, so a switch back starts from the transcript too");
        assert!(c.start_on("openai", false), "the first request on OpenAI failed: send it again");
        c.needs_transcript = false;
        c.openai_items.push(json!({"role": "user"}));
        assert!(c.start_on("claude-code", false));
        assert!(c.openai_items.is_empty());
        assert!(c.start_on("api", false));
        c.needs_transcript = false;
        c.messages.push(json!({"role": "user"}));
        assert!(!c.start_on("console", false), "API key and Anthropic account share messages");
        assert_eq!(c.messages.len(), 1);
    }

    #[test]
    fn the_editor_block_says_where_the_database_lives() {
        let ctx = |storage: &str, path: Option<&str>| EditorContext {
            tab_title: "Query 1".into(),
            sql: "SELECT 1".into(),
            selection: None,
            last_error: None,
            target_tab_id: "t".into(),
            target_tab_title: "Agent".into(),
            storage: storage.into(),
            path: path.map(str::to_string),
            opened_at: None,
            tabs: vec![],
            runs: vec![],
        };
        let file = user_text("hi", "Shop", false, true, &ctx("file", Some("/data/shop")));
        assert!(file.contains(r#"connection="Shop" storage="file" path="/data/shop" transaction="open""#), "{file}");
        let memory = user_text("hi", "Scratch", false, false, &ctx("memory", None));
        assert!(memory.contains(r#"connection="Scratch" storage="memory" write_into"#), "{memory}");
    }

    #[test]
    fn events_use_the_renderers_field_names() {
        let tool = serde_json::to_value(Event::Tool {
            id: "t".into(),
            name: "list_tables".into(),
            summary: "s".into(),
            is_error: true,
            detail: None,
        })
        .unwrap();
        assert_eq!(tool["kind"], "tool");
        assert_eq!(tool["isError"], true);
        assert!(tool.get("detail").is_none(), "left out when there is none");
        let write = serde_json::to_value(Event::Write {
            request_id: "r".into(),
            conn_id: "c".into(),
            tab_id: "tab".into(),
            sql: "SELECT 1".into(),
            explanation: "e".into(),
            title: "Totals".into(),
            allow_writes: false,
        })
        .unwrap();
        assert_eq!(write["kind"], "write");
        assert_eq!(write["requestId"], "r");
        assert_eq!(write["tabId"], "tab");
        assert_eq!(write["connId"], "c");
        assert_eq!(serde_json::to_value(Event::Done).unwrap(), json!({"kind": "done"}));
    }
}

#[cfg(test)]
mod guide_tests {
    use super::SQL_GUIDE;
    use crate::sql_utils::{classify_statement, split_statements, StatementType};
    use stoolap::api::Database;

    /// Every ```sql block in the guide runs on the engine without an error,
    /// each in a fresh database, so the guide can't teach broken SQL.
    #[test]
    fn every_example_in_the_sql_guide_runs() {
        let blocks: Vec<&str> = SQL_GUIDE
            .split("```sql")
            .skip(1)
            .map(|b| b.split("```").next().unwrap_or(""))
            .collect();
        assert!(blocks.len() >= 8, "found only {} sql blocks", blocks.len());
        for (n, block) in blocks.iter().enumerate() {
            let db = Database::open_in_memory().unwrap();
            for stmt in split_statements(block) {
                let result = match classify_statement(&stmt) {
                    StatementType::Query => db
                        .query(&stmt, ())
                        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>().map(|_| ())),
                    _ => db.execute(&stmt, ()).map(|_| ()),
                };
                if let Err(e) = result {
                    panic!("guide block {} fails on `{stmt}`: {e}", n + 1);
                }
            }
        }
    }
}
