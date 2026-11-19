//! Streaming client for the Claude Messages API (raw HTTP: there is no
//! official Rust SDK).

use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";

/// Models offered in the panel. The user picks one; the first is the default.
pub const MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-fable-5-2", "Claude Fable 5.2"),
];

/// The app's HTTP client. reqwest has no TLS crypto provider of its own
/// here (`rustls-no-provider`), so install ring as the process default first.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // Err only if a provider is already installed, which is fine
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .expect("HTTP client")
    })
}

/// What the stream reports as it arrives.
pub enum StreamEvent<'a> {
    Text(&'a str),
    Thinking(&'a str),
    /// A tool call's input so far (JSON, cut off anywhere)
    ToolInput { name: &'a str, partial: &'a str },
}

/// One finished model turn.
pub struct Turn {
    /// The assistant message's content blocks, unchanged, to send back next
    /// request (thinking blocks included: they must be replayed as received).
    pub content: Vec<Value>,
    pub stop_reason: String,
    /// tool_use blocks whose streamed input was not valid JSON, by id
    pub invalid_inputs: Vec<(String, String)>,
}

pub fn request_body(model: &str, system: &str, tools: &Value, messages: &[Value]) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": 32000,
        "stream": true,
        // Caches the longest stable prefix (tools, system, earlier turns).
        "cache_control": {"type": "ephemeral"},
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "medium"},
        "system": system,
        "tools": tools,
        "messages": messages,
    });
    // Server-side fallback on a policy decline; Claude Haiku 5.5 has none.
    if model != "claude-haiku-5-5" {
        body["fallbacks"] = json!("default");
    }
    body
}

/// How requests authenticate
pub enum Credential {
    ApiKey(String),
    /// A browser sign-in kept by Anthropic's `ant` CLI
    Console(super::console::Ant),
}

/// Send one streaming request and assemble the assistant turn.
pub async fn stream_turn(
    credential: &Credential,
    body: &Value,
    cancel: &AtomicBool,
    mut on_event: impl FnMut(StreamEvent),
) -> Result<Turn, String> {
    let mut betas: Vec<&str> = Vec::new();
    if body.get("fallbacks").is_some() {
        betas.push("server-side-fallback-2026-07-01");
    }
    let mut req = client()
        .post(API_URL)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    req = match credential {
        Credential::ApiKey(key) => req.header("x-api-key", key),
        Credential::Console(ant) => {
            // Short-lived; ask for it on every request (ant refreshes it)
            let ant = ant.clone();
            let token = tauri::async_runtime::spawn_blocking(move || ant.access_token())
                .await
                .map_err(|e| e.to_string())?
                .ok_or("You are signed out of your Anthropic account. Sign in again in the assistant settings.")?;
            // OAuth tokens need this beta on /v1/messages
            betas.push("oauth-2025-04-20");
            req.header("authorization", format!("Bearer {token}"))
        }
    };
    if !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    let resp = or_cancel(cancel, req.json(body).send())
        .await?
        .map_err(|e| format!("Could not reach the Claude API: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or(text);
        return Err(match status.as_u16() {
            401 => match credential {
                Credential::ApiKey(_) => "The API key was rejected. Check it in the assistant settings.".to_string(),
                Credential::Console(_) => "Your Anthropic sign-in was rejected or has expired. Sign in again in the assistant settings.".to_string(),
            },
            429 => format!("Rate limited by the Claude API: {message}"),
            _ => format!("Claude API error {}: {message}", status.as_u16()),
        });
    }

    let mut builder = TurnBuilder::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = or_cancel(cancel, stream.next()).await? {
        let chunk = chunk.map_err(|e| format!("The response stream broke off: {e}"))?;
        builder.feed(&chunk, &mut on_event)?;
    }
    builder.finish()
}

/// `fut`'s output, or Err("cancelled") as soon as `cancel` is set, even
/// while the provider sends nothing (it can hold a stream open silently).
pub(super) async fn or_cancel<T>(cancel: &AtomicBool, fut: impl std::future::Future<Output = T>) -> Result<T, String> {
    tokio::pin!(fut);
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            out = &mut fut => return Ok(out),
            _ = tick.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
            }
        }
    }
}

/// Assembles a turn from the SSE byte stream.
#[derive(Default)]
struct TurnBuilder {
    buffer: Vec<u8>,
    blocks: Vec<Value>,
    partial_json: Vec<String>,
    stop_reason: String,
}

impl TurnBuilder {
    fn feed(&mut self, chunk: &[u8], on_event: &mut impl FnMut(StreamEvent)) -> Result<(), String> {
        self.buffer.extend_from_slice(chunk);
        // SSE events are separated by a blank line
        while let Some(end) = find_event_end(&self.buffer) {
            let raw: Vec<u8> = self.buffer.drain(..end).collect();
            let text = String::from_utf8_lossy(&raw).into_owned();
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let Ok(event) = serde_json::from_str::<Value>(data.trim()) else { continue };
                self.apply(&event, on_event)?;
            }
        }
        Ok(())
    }

    fn apply(&mut self, event: &Value, on_event: &mut impl FnMut(StreamEvent)) -> Result<(), String> {
        match event["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let i = event["index"].as_u64().unwrap_or(0) as usize;
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                self.blocks[i] = event["content_block"].clone();
            }
            "content_block_delta" => {
                let i = event["index"].as_u64().unwrap_or(0) as usize;
                let Some(block) = self.blocks.get_mut(i) else { return Ok(()) };
                let delta = &event["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = delta["text"].as_str().unwrap_or("");
                        append_str(block, "text", t);
                        on_event(StreamEvent::Text(t));
                    }
                    "thinking_delta" => {
                        let t = delta["thinking"].as_str().unwrap_or("");
                        append_str(block, "thinking", t);
                        on_event(StreamEvent::Thinking(t));
                    }
                    "signature_delta" => block["signature"] = delta["signature"].clone(),
                    "input_json_delta" => {
                        self.partial_json[i].push_str(delta["partial_json"].as_str().unwrap_or(""));
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        on_event(StreamEvent::ToolInput { name: &name, partial: &self.partial_json[i] });
                    }
                    "citations_delta" => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(list) = block["citations"].as_array_mut() {
                            list.push(delta["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(r) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = r.to_string();
                }
            }
            "error" => {
                let msg = event["error"]["message"].as_str().unwrap_or("unknown error");
                return Err(format!("Claude API error: {msg}"));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(mut self) -> Result<Turn, String> {
        // Tool inputs stream as JSON fragments; parse them strictly now.
        let mut invalid_inputs = Vec::new();
        for (i, block) in self.blocks.iter_mut().enumerate() {
            if block["type"] == "tool_use" {
                let raw = &self.partial_json[i];
                if raw.trim().is_empty() {
                    continue; // a tool without arguments: input stays {}
                }
                match serde_json::from_str::<Value>(raw) {
                    Ok(input) if input.is_object() => block["input"] = input,
                    _ => invalid_inputs.push((
                        block["id"].as_str().unwrap_or_default().to_string(),
                        raw.clone(),
                    )),
                }
            }
        }
        if self.stop_reason.is_empty() {
            return Err("The response stream ended early.".into());
        }
        Ok(Turn {
            content: self.blocks.into_iter().filter(|b| !b.is_null()).collect(),
            stop_reason: self.stop_reason,
            invalid_inputs,
        })
    }
}

fn append_str(block: &mut Value, key: &str, s: &str) {
    let mut cur = block[key].as_str().unwrap_or("").to_string();
    cur.push_str(s);
    block[key] = Value::String(cur);
}

pub(super) fn find_event_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2)
        .position(|w| w == b"\n\n")
        .map(|p| p + 2)
        .or_else(|| buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse(events: &[Value]) -> Vec<u8> {
        events
            .iter()
            .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn assembles_text_thinking_and_tool_calls_across_chunks() {
        let bytes = sse(&[
            json!({"type": "message_start", "message": {"id": "msg_1"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Check the schema."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Bakıyorum "}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "kankam"}}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "describe_table", "input": {}}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"name\": \"or"}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "ders\"}"}}),
            json!({"type": "content_block_start", "index": 3, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "list_tables", "input": {}}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            json!({"type": "message_stop"}),
        ]);
        let mut builder = TurnBuilder::default();
        let mut text = String::new();
        // Feed in small pieces that split events and UTF-8 characters
        for piece in bytes.chunks(7) {
            builder
                .feed(piece, &mut |e| {
                    if let StreamEvent::Text(t) = e {
                        text.push_str(t)
                    }
                })
                .unwrap();
        }
        let turn = builder.finish().unwrap();
        assert_eq!(text, "Bakıyorum kankam");
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(turn.content[0]["thinking"], "Check the schema.");
        assert_eq!(turn.content[0]["signature"], "sig");
        assert_eq!(turn.content[2]["input"], json!({"name": "orders"}));
        assert_eq!(turn.content[3]["input"], json!({}));
        assert!(turn.invalid_inputs.is_empty());
    }

    #[test]
    fn reports_tool_input_that_is_not_json() {
        let bytes = sse(&[
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "run_query", "input": {}}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"sql\": \"SELECT"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ]);
        let mut builder = TurnBuilder::default();
        builder.feed(&bytes, &mut |_| {}).unwrap();
        let turn = builder.finish().unwrap();
        assert_eq!(turn.invalid_inputs.len(), 1);
        assert_eq!(turn.invalid_inputs[0].0, "toolu_1");
    }

    /// Reaches the real API over TLS: run with `cargo test -- --ignored`.
    /// A made-up key costs nothing and must come back as a 401.
    #[test]
    #[ignore]
    fn reaches_the_api_over_tls() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let body = request_body("claude-haiku-5-5", "test", &json!([]), &[json!({"role": "user", "content": "hi"})]);
        let err = rt
            .block_on(stream_turn(&Credential::ApiKey("sk-ant-not-a-key".into()), &body, &AtomicBool::new(false), |_| {}))
            .err()
            .unwrap();
        assert!(err.contains("API key was rejected"), "{err}");
    }

    #[test]
    fn stream_errors_and_early_ends_fail() {
        let mut builder = TurnBuilder::default();
        let bytes = sse(&[json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})]);
        assert!(builder.feed(&bytes, &mut |_| {}).is_err());
        assert!(TurnBuilder::default().finish().is_err());
    }

    #[tokio::test]
    async fn stop_ends_a_wait_on_a_silent_stream() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let out = or_cancel(&cancel, std::future::pending::<()>()).await;
        assert_eq!(out, Err("cancelled".to_string()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
