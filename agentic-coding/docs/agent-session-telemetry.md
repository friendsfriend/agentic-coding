# Agent session telemetry content

Status: session content capture behind the existing telemetry opt-in.

The runtime bridges (`agent-definitions/bridges/*`) emit one envelope per
lifecycle event into `.herdr-workflow/<id>/telemetry.jsonl` (and, when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OTLP logs endpoint). Metadata is
always emitted. Session content — user/assistant text, tool arguments and tool
results — is captured only when the run's `telemetry.capture_content` config is
true (the default), which the engine forwards to the agent process as
`HERDR_CAPTURE_CONTENT=1` in the run environment. With capture off, no content
key ever reaches an envelope.

## What is captured

| Event | Content attribute | Value |
| --- | --- | --- |
| `runtime.message` (role `user`) | `herdr.content.input` | user message text |
| `runtime.message` (role `assistant`) | `herdr.content.output` | assistant text parts |
| `runtime.tool_start` | `herdr.content.tool_input` | tool arguments (JSON) |
| `runtime.tool` | `herdr.content.tool_output` | tool result (JSON) |
| opencode `runtime.part_length` (final text part) | `herdr.content.input` / `herdr.content.output` | text part |

pi emits one `runtime.message` per user/assistant message, so the conversation
is reconstructable without repeating the whole history per provider call.
opencode text parts are captured only once complete (`time.end`, or a user
part) and only when the part's message role was learned from a `message.updated`
row; tool content is captured once per call id (arguments on the first update
that carries them, result on the terminal one).

Every value is redacted with the bridge credential pattern before the cap and
truncated to 8192 characters, matching the engine's `TELEMETRY_ATTRIBUTE_LIMIT`.
A cut value is marked by `pi.content.truncated` / `oc.content.truncated`. Tool
results are never re-emitted as a second message row.

## Where it shows

`parseTelemetryLine` maps every scalar envelope key to a span attribute, so the
captured content reaches the trace database unchanged. The observability span
detail renders `herdr.content.*` attributes wrapped (JSON indented) under
"Message input", "Message output", "Tool input" and "Tool output" instead of a
clipped one-line metadata row.

## Not captured

- system prompts and thinking/reasoning parts
- images and other non-text content parts
- streaming updates (only the completed message/part is recorded)
- anything at all while `telemetry.capture_content = false`
