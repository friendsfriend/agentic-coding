-- Synthetic OTel span store for the efficiency tests. Mirrors the real schema
-- (`otel-tui/traces.sqlite`) and carries hand-made spans only.
CREATE TABLE traces (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	change_id TEXT NOT NULL,
	span TEXT NOT NULL,
	ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
	start_nanos INTEGER,
	end_nanos INTEGER,
	status_code INTEGER,
	role TEXT,
	name TEXT
);
CREATE TABLE workspace_files (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	change_id TEXT UNIQUE NOT NULL,
	path TEXT NOT NULL,
	file_mtime INTEGER NOT NULL DEFAULT 0,
	parser_version INTEGER NOT NULL DEFAULT 1,
	file_size INTEGER NOT NULL DEFAULT 0,
	ingest_offset INTEGER NOT NULL DEFAULT 0,
	line_index INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, metric TEXT NOT NULL, ingested_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, log TEXT NOT NULL, ingested_at TEXT NOT NULL DEFAULT (datetime('now')));

-- `legacy-wf` seen through spans: same workflow as the legacy JSONL file, with
-- a tool call that carries argument and result sizes.
INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, name) VALUES (
	'legacy-wf',
	'{"traceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","spanId":"1111111111111111","parentSpanId":"","name":"runtime.tool","startTimeUnixNano":"1767261600000000000","endTimeUnixNano":"1767261600000000000","status":{"code":0},"attributes":[{"key":"herdr.change.id","value":"legacy-wf"},{"key":"herdr.run.id","value":"run-legacy"},{"key":"herdr.step.id","value":"core.plan"},{"key":"herdr.role","value":"planner"},{"key":"herdr.profile","value":"pi-free"},{"key":"pi.tool.name","value":"read"},{"key":"pi.tool.call_id","value":"call-legacy-1"},{"key":"pi.tool.outcome","value":"ok"},{"key":"pi.tool.duration_ms","value":12},{"key":"pi.tool.argument_bytes","value":44},{"key":"pi.tool.result_bytes","value":2048}],"resource":{"attributes":[]},"scope":{"name":"runtime"},"serviceName":"pi","kind":0}',
	1767261600000000000, 1767261600000000000, 0, 'planner', 'runtime.tool'
);
INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, name) VALUES (
	'legacy-wf',
	'{"traceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","spanId":"2222222222222222","parentSpanId":"","name":"runtime.tool","startTimeUnixNano":"1767261601000000000","endTimeUnixNano":"1767261601000000000","status":{"code":0},"attributes":[{"key":"herdr.change.id","value":"legacy-wf"},{"key":"herdr.run.id","value":"run-legacy"},{"key":"herdr.role","value":"planner"},{"key":"pi.tool.name","value":"read"},{"key":"pi.tool.call_id","value":"call-legacy-2"},{"key":"pi.tool.outcome","value":"ok"},{"key":"pi.tool.duration_ms","value":9},{"key":"pi.tool.argument_bytes","value":44},{"key":"pi.tool.result_bytes","value":2048}],"resource":{"attributes":[]},"scope":{"name":"runtime"},"serviceName":"pi","kind":0}',
	1767261601000000000, 1767261601000000000, 0, 'planner', 'runtime.tool'
);
INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, name) VALUES (
	'legacy-wf',
	'{"traceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","spanId":"3333333333333333","parentSpanId":"","name":"verification_finding","startTimeUnixNano":"1767261720000000000","endTimeUnixNano":"1767261720000000000","status":{"code":0},"attributes":[{"key":"change","value":"legacy-wf"},{"key":"herdr.role","value":"quality-verifier"},{"key":"finding_id","value":"abcd1234"},{"key":"severity","value":"warning"},{"key":"status","value":"new"},{"key":"finding_path","value":"src/a.ts"},{"key":"finding_line","value":12},{"key":"description","value":"Error message below the threshold"}],"resource":{"attributes":[]},"scope":{"name":"engine"},"serviceName":"herdr-workflow","kind":0}',
	1767261720000000000, 1767261720000000000, 0, 'quality-verifier', 'verification_finding'
);

-- `traces-only-wf` exists in no other source: it exercises the heuristic path.
INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, name) VALUES (
	'traces-only-wf',
	'{"traceId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","spanId":"4444444444444444","parentSpanId":"","name":"workflow.started","startTimeUnixNano":"1767300000000000000","endTimeUnixNano":"1767300000000000000","status":{"code":0},"attributes":[{"key":"change","value":"traces-only-wf"},{"key":"herdr.workflow.type","value":"openspec"}],"resource":{"attributes":[]},"scope":{"name":"engine"},"serviceName":"herdr-workflow","kind":0}',
	1767300000000000000, 1767300000000000000, 0, NULL, 'workflow.started'
);
INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, name) VALUES (
	'traces-only-wf',
	'{"traceId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","spanId":"5555555555555555","parentSpanId":"","name":"runtime.usage","startTimeUnixNano":"1767300001000000000","endTimeUnixNano":"1767300001000000000","status":{"code":0},"attributes":[{"key":"herdr.change.id","value":"traces-only-wf"},{"key":"herdr.role","value":"worker"},{"key":"herdr.run.id","value":"run-traces-only"},{"key":"herdr.step.id","value":"core.implementation"},{"key":"pi.turn.index","value":0},{"key":"inputTokens","value":300},{"key":"outputTokens","value":30},{"key":"totalTokens","value":330},{"key":"cacheReadTokens","value":50},{"key":"cacheWriteTokens","value":0},{"key":"cost","value":0.0007},{"key":"model","value":"opencode/deepseek-v4-flash-free"}],"resource":{"attributes":[]},"scope":{"name":"runtime"},"serviceName":"pi","kind":0}',
	1767300001000000000, 1767300001000000000, 0, 'worker', 'runtime.usage'
);

-- An empty store for a workflow the parser must not invent data for.
INSERT INTO workspace_files (change_id, path) VALUES ('legacy-wf', '/repo/agentic-coding/src/a.ts');
