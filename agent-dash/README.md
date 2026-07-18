# agent-dash

OpenTUI dashboard for managed Herdr OpenSpec workflows.

```bash
bun install
bun run build:single # current OS/architecture
bun run build        # all supported variants
bun run install:bin  # build current variant and install to ~/.local/bin

agent-dash --repo /path/to/repo --change change-id
agent-dash --home  # global workspace overview
otel-tui --file /path/to/.herdr-workflow/change/traces.jsonl
```

Build output lives under `dist/agent-dash-<os>-<arch>/` with baseline and musl variants included by the all-platform build.

Preview without a workflow using interactive dummy data:

```bash
agent-dash --profile test
```

Press Enter in test profile to cycle through workflow phases.

`otel-tui` receives OTLP HTTP **JSON** at `POST http://127.0.0.1:4318/v1/traces`. Options: `--host`, `--port`, `--max-spans`, `--file`, `--filter`. Non-loopback binds have no authentication; keep them protected. Herdr exports to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces`, then local viewer. Prompt/model text, tool args/results, and repository content stay excluded; set `HERDR_TELEMETRY_MESSAGE_PREVIEW` only when bounded message previews are needed.

Keys: `Enter` approves current gate, `J/K` or Tab switches focused panels, `j/k` scrolls the focused panel, `Alt+C` copies selected text, `r` refreshes, `q` exits. Mouse selection copies automatically on release. Data auto-refreshes every five seconds.
