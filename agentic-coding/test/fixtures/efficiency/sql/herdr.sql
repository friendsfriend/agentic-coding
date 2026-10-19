-- Synthetic durable workflow store: the authoritative run list. Its handle
-- names are what let the harness conversations above be attributed exactly.
CREATE TABLE workflows (change_id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE workflow_instances (
	id TEXT PRIMARY KEY,
	change_id TEXT NULL,
	repository TEXT NOT NULL,
	worktree TEXT NOT NULL,
	definition_id TEXT NOT NULL,
	definition_version INTEGER NOT NULL,
	definition_digest TEXT NOT NULL,
	revision INTEGER NOT NULL,
	status TEXT NOT NULL,
	current_step TEXT NOT NULL,
	snapshot_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE workflow_runs (
	id TEXT PRIMARY KEY,
	workflow_id TEXT NOT NULL,
	step_id TEXT NOT NULL,
	role TEXT NOT NULL,
	generation INTEGER NOT NULL,
	attempt INTEGER NOT NULL,
	status TEXT NOT NULL,
	profile_json TEXT NOT NULL,
	issued_revision INTEGER NOT NULL,
	allowed_outcomes_json TEXT NOT NULL,
	capability_hash TEXT NOT NULL,
	capability_expires_at TEXT NOT NULL,
	assignment_path TEXT NOT NULL,
	output_path TEXT,
	output_schema_id TEXT,
	output_schema_version INTEGER,
	output_digest TEXT,
	handle_json TEXT,
	created_at TEXT NOT NULL,
	completed_at TEXT
);
CREATE TABLE workflow_events (
	workflow_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	type TEXT NOT NULL,
	actor_json TEXT NOT NULL,
	data_json TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (workflow_id, revision)
);

INSERT INTO workflow_instances (id, change_id, repository, worktree, definition_id, definition_version, definition_digest, revision, status, current_step, snapshot_json, created_at, updated_at) VALUES
	('span-wf', NULL, '/repo/agentic-coding', '/repo/worktrees/span-wf', 'solo', 820, 'digest', 6, 'attention-required', 'core.implementation',
	 '{"workflowId":"span-wf","definition":{"id":"solo","version":820},"metadata":{"repository":"/repo/agentic-coding","branch":"feature/span-wf","baseCommit":"deadbeef","task":"a synthetic assignment body that must never reach the dataset"}}',
	 '2026-01-02T09:00:00.000Z', '2026-01-02T10:10:00.000Z');

INSERT INTO workflow_runs (id, workflow_id, step_id, role, generation, attempt, status, profile_json, issued_revision, allowed_outcomes_json, capability_hash, capability_expires_at, assignment_path, output_path, output_schema_id, output_schema_version, output_digest, handle_json, created_at, completed_at) VALUES
	('run-span-a', 'span-wf', 'core.implementation', 'worker', 1, 1, 'completed',
	 '{"name":"pi-opencode-go-deepseek-flash","runtime":"pi-durable","model":"opencode-go/deepseek-v4.1-flash","thinking":"high"}',
	 1, '["complete"]', 'hash', '2026-01-02T10:00:00.000Z', 'assignment.md', 'out.json', 'core.json', 1, 'digest',
	 '{"runtime":"pi-durable","name":"worker-aaaa","sessionId":"run-span-a","conversationId":"2"}',
	 '2026-01-02T09:00:01.000Z', '2026-01-02T09:05:00.000Z'),
	('run-span-b', 'span-wf', 'core.implementation', 'worker', 1, 2, 'blocked',
	 '{"name":"pi-opencode-go-deepseek-flash","runtime":"pi-durable","model":"opencode-go/deepseek-v4.1-flash"}',
	 2, '["complete","blocked"]', 'hash', '2026-01-02T11:00:00.000Z', 'assignment.md', 'out.json', 'core.json', 1, 'digest',
	 '{"runtime":"pi-durable","name":"worker-bbbb","sessionId":"run-span-b","conversationId":"3"}',
	 '2026-01-02T10:00:01.000Z', '2026-01-02T10:10:00.000Z');

INSERT INTO workflow_events (workflow_id, revision, type, actor_json, data_json, at) VALUES
	('span-wf', 0, 'workflow.started', '{"kind":"developer"}', '{"definition":{"id":"solo"}}', '2026-01-02T09:00:00.000Z'),
	('span-wf', 5, 'agent.handoff', '{"kind":"agent","runId":"run-span-a","role":"worker"}', '{"outcome":"complete"}', '2026-01-02T09:05:00.000Z'),
	('span-wf', 6, 'agent.handoff', '{"kind":"agent","runId":"run-span-b","role":"worker"}', '{"outcome":"blocked"}', '2026-01-02T10:10:00.000Z'),
	('span-wf', 7, 'operator.repair', '{"kind":"developer"}', '{"source":"core.implementation","target":"core.implementation","reason":"verification failed twice; restarting implementation","repairCount":1,"expiredEffects":["effect-1","effect-2"],"retiredRuns":["run-span-b"]}', '2026-01-02T10:20:00.000Z');
