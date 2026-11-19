//! A local MCP server (streamable HTTP, JSON responses) that gives Claude
//! Code the agent's tools. It listens on 127.0.0.1 only, and each
//! conversation gets its own unguessable path, which is the only way in.

use super::{tools, AgentState};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// What a conversation's tools act on; refreshed on every message.
#[derive(Clone)]
pub struct McpSession {
    pub conversation_id: String,
    pub conn_id: String,
    /// The user lets the agent run SQL that can change data
    pub allow_writes: bool,
    /// The tab the agent writes into
    pub tab_id: String,
    pub tab_title: String,
}

pub const SERVER_NAME: &str = "stoolap";

/// Start the server once; returns its port.
pub fn ensure_started(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<AgentState>();
    let mut port = state.mcp_port.lock().map_err(|e| e.to_string())?;
    if let Some(p) = *port {
        return Ok(p);
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let p = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("The MCP server has no TCP address")?;
    let app = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            // Tool calls can take a while (EXPLAIN, queries): one thread each
            std::thread::spawn(move || handle(&app, request));
        }
    });
    *port = Some(p);
    Ok(p)
}

fn respond(request: tiny_http::Request, status: u16, body: Option<Value>) {
    let response = match body {
        Some(b) => tiny_http::Response::from_string(b.to_string())
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
            ),
        None => tiny_http::Response::from_string(String::new()).with_status_code(status),
    };
    let _ = request.respond(response);
}

fn handle(app: &AppHandle, mut request: tiny_http::Request) {
    let token = request.url().strip_prefix("/mcp/").unwrap_or("").to_string();
    let session = app
        .state::<AgentState>()
        .mcp_sessions
        .lock()
        .ok()
        .and_then(|s| s.get(&token).cloned());
    let Some(session) = session else {
        return respond(request, 404, None);
    };
    if request.method() != &tiny_http::Method::Post {
        // No server-initiated stream
        return respond(request, 405, None);
    }
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        return respond(request, 400, None);
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return respond(request, 400, None);
    };
    eprintln!(
        "[agent] {}: mcp {} {}",
        session.conversation_id,
        message["method"].as_str().unwrap_or("?"),
        message["params"]["name"].as_str().unwrap_or("")
    );
    match dispatch(&message, |params| call(app, &session, params)) {
        Some(envelope) => respond(request, 200, Some(envelope)),
        // Notifications get no response body
        None => respond(request, 202, None),
    }
}

/// Answer one JSON-RPC message; None for a notification.
fn dispatch(message: &Value, call: impl FnOnce(&Value) -> Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let reply = match message["method"].as_str().unwrap_or("") {
        "initialize" => Ok(json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_list()})),
        "tools/call" => Ok(call(&message["params"])),
        other => Err(json!({"code": -32601, "message": format!("Method not found: {other}")})),
    };
    Some(match reply {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
    })
}

/// The API tool definitions in MCP's shape
fn tool_list() -> Vec<Value> {
    tools::definitions()
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            json!({
                "name": t["name"],
                "description": t["description"],
                "inputSchema": t["input_schema"],
            })
        })
        .collect()
}

fn call(app: &AppHandle, session: &McpSession, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let output = super::run_tool(app, session, name, &input);
    super::emit_tool(app, &session.conversation_id, name, &output);
    json!({
        "content": [{"type": "text", "text": output.content}],
        "isError": output.is_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaks_mcp_json_rpc() {
        let no_call = |_: &Value| -> Value { unreachable!() };
        let init = dispatch(
            &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            no_call,
        )
        .unwrap();
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(init["result"]["capabilities"]["tools"].is_object());

        assert!(dispatch(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), no_call).is_none());

        let list = dispatch(&json!({"jsonrpc": "2.0", "id": "a", "method": "tools/list"}), no_call).unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "write_query"));
        assert!(!tools.iter().any(|t| t["name"] == "run_query"));
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object" && t.get("strict").is_none()));

        let called = dispatch(
            &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_tables", "arguments": {}}}),
            |p| json!({"echo": p["name"]}),
        )
        .unwrap();
        assert_eq!(called["result"]["echo"], "list_tables");

        let unknown = dispatch(&json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"}), no_call).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }
}
