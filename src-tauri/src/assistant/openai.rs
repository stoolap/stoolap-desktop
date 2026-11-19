//! Streaming client for the OpenAI Responses API with the user's API key
//! (raw HTTP), and the tool loop around it.
//!
//! Nothing is stored at OpenAI (`store: false`): every request sends the
//! whole conversation, with reasoning carried along encrypted.

use super::api::or_cancel;
use super::{emit, emit_tool, mcp::McpSession, Event};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

const API: &str = "https://api.openai.com/v1";

/// Our tools in the Responses API's function format
fn tools() -> Value {
    Value::Array(
        super::tools::definitions()
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                    // Strict mode needs every property required; ours has optional ones
                    "strict": false,
                })
            })
            .collect(),
    )
}

fn request_body(model: &str, system: &str, items: &[Value]) -> Value {
    json!({
        "model": model,
        "instructions": system,
        "input": items,
        "tools": tools(),
        "reasoning": {"summary": "auto"},
        "include": ["reasoning.encrypted_content"],
        "store": false,
        "stream": true,
    })
}

fn error_message(status: u16, text: &str) -> String {
    let message = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| text.to_string());
    match status {
        401 => "The OpenAI API key was rejected. Check it in the assistant settings.".into(),
        429 => format!("OpenAI rate limit or quota: {message}"),
        _ => format!("OpenAI API error {status}: {message}"),
    }
}

/// The models offered for a key: the reasoning models (they take the
/// request's reasoning settings), newest first. (id, name)
pub async fn models(key: &str) -> Result<Vec<(String, String)>, String> {
    let resp = super::api::client()
        .get(format!("{API}/models"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Could not reach the OpenAI API: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(error_message(status, &text));
    }
    let list: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(chat_models(&list))
}

fn chat_models(list: &Value) -> Vec<(String, String)> {
    // Speech, image, search and embedding models can't run this loop
    const NOT_CHAT: &[&str] = &["audio", "realtime", "transcribe", "tts", "image", "search", "embedding", "moderation"];
    let reasoning = |id: &str| {
        id.strip_prefix("gpt-")
            .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|major| major.parse::<u32>().ok())
            .is_some_and(|major| major >= 5)
            || id.starts_with("o3")
            || id.starts_with("o4")
    };
    let mut models: Vec<(&str, i64)> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m["id"].as_str()?, m["created"].as_i64().unwrap_or(0))))
        .filter(|(id, _)| reasoning(id) && !NOT_CHAT.iter().any(|n| id.contains(n)))
        .collect();
    models.sort_by_key(|(id, created)| (std::cmp::Reverse(*created), *id));
    models.into_iter().map(|(id, _)| (id.to_string(), id.to_string())).collect()
}

/// One response, assembled from the event stream
#[derive(Default)]
struct ResponseBuilder {
    buffer: Vec<u8>,
    /// Function calls streaming in: item id -> (name, arguments so far)
    calls: HashMap<String, (String, String)>,
    output: Option<Vec<Value>>,
}

enum Streamed<'a> {
    Text(&'a str),
    Thinking(&'a str),
    ToolInput { name: &'a str, partial: &'a str },
}

impl ResponseBuilder {
    fn feed(&mut self, chunk: &[u8], on_event: &mut impl FnMut(Streamed)) -> Result<(), String> {
        self.buffer.extend_from_slice(chunk);
        while let Some(end) = super::api::find_event_end(&self.buffer) {
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

    fn apply(&mut self, event: &Value, on_event: &mut impl FnMut(Streamed)) -> Result<(), String> {
        match event["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => on_event(Streamed::Text(event["delta"].as_str().unwrap_or(""))),
            "response.reasoning_summary_text.delta" => {
                on_event(Streamed::Thinking(event["delta"].as_str().unwrap_or("")))
            }
            "response.output_item.added" if event["item"]["type"] == "function_call" => {
                let item = &event["item"];
                let id = item["id"].as_str().unwrap_or("").to_string();
                let name = item["name"].as_str().unwrap_or("").to_string();
                self.calls.insert(id, (name, String::new()));
            }
            "response.function_call_arguments.delta" => {
                let id = event["item_id"].as_str().unwrap_or("");
                if let Some((name, partial)) = self.calls.get_mut(id) {
                    partial.push_str(event["delta"].as_str().unwrap_or(""));
                    on_event(Streamed::ToolInput { name, partial });
                }
            }
            "response.completed" => {
                self.output = Some(event["response"]["output"].as_array().cloned().unwrap_or_default());
            }
            "response.incomplete" => {
                let reason = event["response"]["incomplete_details"]["reason"].as_str().unwrap_or("unknown");
                return Err(if reason == "max_output_tokens" {
                    "The answer ran past the output limit. Try a narrower request.".into()
                } else {
                    format!("The response stopped early ({reason}).")
                });
            }
            "response.failed" => {
                let message = event["response"]["error"]["message"].as_str().unwrap_or("the request failed");
                return Err(format!("OpenAI: {message}"));
            }
            "error" => {
                let message = event["message"].as_str().or(event["error"]["message"].as_str()).unwrap_or("stream error");
                return Err(format!("OpenAI: {message}"));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Result<Vec<Value>, String> {
        self.output.ok_or_else(|| "The response stream ended early.".into())
    }
}

async fn stream_response(
    key: &str,
    body: &Value,
    cancel: &AtomicBool,
    mut on_event: impl FnMut(Streamed),
) -> Result<Vec<Value>, String> {
    let request = super::api::client().post(format!("{API}/responses")).bearer_auth(key).json(body);
    let resp = or_cancel(cancel, request.send())
        .await?
        .map_err(|e| format!("Could not reach the OpenAI API: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Err(error_message(status, &text));
    }
    let mut builder = ResponseBuilder::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = or_cancel(cancel, stream.next()).await? {
        let chunk = chunk.map_err(|e| format!("The response stream broke off: {e}"))?;
        builder.feed(&chunk, &mut on_event)?;
    }
    builder.finish()
}

/// Run one message: responses and tool calls until the model answers.
/// `items` is the conversation so far, and grows with this exchange.
pub async fn run_loop(
    app: &tauri::AppHandle,
    target: &McpSession,
    model: &str,
    key: &str,
    system: &str,
    items: &mut Vec<Value>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let conversation_id = target.conversation_id.as_str();
    for _ in 0..super::MAX_TURNS {
        let body = request_body(model, system, items);
        let output = stream_response(key, &body, cancel, |ev| match ev {
            Streamed::Text(t) => emit(app, conversation_id, Event::Text { delta: t.to_string() }),
            Streamed::Thinking(t) => emit(app, conversation_id, Event::Thinking { delta: t.to_string() }),
            Streamed::ToolInput { name, partial } => super::draft(app, target, name, partial),
        })
        .await?;

        let calls: Vec<Value> = output.iter().filter(|i| i["type"] == "function_call").cloned().collect();
        items.extend(output);
        if calls.is_empty() {
            return Ok(());
        }
        for call in calls {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let name = call["name"].as_str().unwrap_or_default().to_string();
            let output = match serde_json::from_str::<Value>(call["arguments"].as_str().unwrap_or("")) {
                Ok(input) => {
                    // Database reads, or waiting on the tab: both block
                    let (app2, target2, tool) = (app.clone(), target.clone(), name.clone());
                    tauri::async_runtime::spawn_blocking(move || super::run_tool(&app2, &target2, &tool, &input))
                        .await
                        .map_err(|e| e.to_string())?
                }
                Err(_) => super::tools::Output {
                    content: json!({"INVALID_JSON": call["arguments"]}).to_string(),
                    is_error: true,
                    summary: format!("{name}: invalid input"),
                },
            };
            emit_tool(app, conversation_id, &name, &output);
            items.push(json!({
                "type": "function_call_output",
                "call_id": call["call_id"],
                "output": output.content,
            }));
        }
    }
    Err("The assistant took too many steps without finishing.".into())
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
    fn assembles_text_and_function_calls_across_chunks() {
        let bytes = sse(&[
            json!({"type": "response.reasoning_summary_text.delta", "delta": "Look at tables"}),
            json!({"type": "response.output_text.delta", "delta": "Here ü"}),
            json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc_1", "name": "write_query"}}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\"sql\":\"SEL"}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "ECT 1\"}"}),
            json!({"type": "response.completed", "response": {"output": [
                {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "write_query", "arguments": "{\"sql\":\"SELECT 1\"}"}
            ]}}),
        ]);
        let mut b = ResponseBuilder::default();
        let (mut text, mut thinking, mut last_partial) = (String::new(), String::new(), String::new());
        // Small pieces that split events and UTF-8 characters
        for piece in bytes.chunks(7) {
            b.feed(piece, &mut |ev| match ev {
                Streamed::Text(t) => text.push_str(t),
                Streamed::Thinking(t) => thinking.push_str(t),
                Streamed::ToolInput { name, partial } => {
                    assert_eq!(name, "write_query");
                    last_partial = partial.to_string();
                }
            })
            .unwrap();
        }
        assert_eq!((text.as_str(), thinking.as_str()), ("Here ü", "Look at tables"));
        assert_eq!(last_partial, "{\"sql\":\"SELECT 1\"}");
        assert_eq!(b.finish().unwrap()[0]["call_id"], "call_1");
    }

    #[test]
    fn failures_and_early_ends_are_errors() {
        let mut b = ResponseBuilder::default();
        let failed = sse(&[json!({"type": "response.failed", "response": {"error": {"message": "boom"}}})]);
        assert!(b.feed(&failed, &mut |_| {}).unwrap_err().contains("boom"));
        assert!(ResponseBuilder::default().finish().is_err());
        assert!(error_message(401, "{}").contains("rejected"));
    }

    #[test]
    fn offers_reasoning_chat_models_newest_first() {
        let list = json!({"data": [
            {"id": "gpt-4.1", "created": 5},
            {"id": "gpt-5.5", "created": 3},
            {"id": "gpt-6.1-sol", "created": 9},
            {"id": "gpt-6-realtime", "created": 10},
            {"id": "text-embedding-3-large", "created": 11},
            {"id": "o3", "created": 1},
        ]});
        let ids: Vec<String> = chat_models(&list).into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, ["gpt-6.1-sol", "gpt-5.5", "o3"]);
    }

    #[test]
    fn passes_our_tools_as_functions() {
        let t = tools();
        assert!(t.as_array().unwrap().iter().any(|f| f["name"] == "write_query" && f["parameters"]["type"] == "object"));
    }

    /// Reaches the real API over TLS: run with `cargo test -- --ignored`.
    /// A made-up key costs nothing and must come back as a 401.
    #[test]
    #[ignore]
    fn reaches_the_openai_api_over_tls() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(models("sk-not-a-key")).unwrap_err();
        assert!(err.contains("rejected"), "{err}");
    }
}
