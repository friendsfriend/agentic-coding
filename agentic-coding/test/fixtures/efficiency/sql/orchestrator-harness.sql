-- Synthetic pi-durable harness for the orchestrator conversation.
CREATE TABLE conversations (
	id INTEGER PRIMARY KEY,
	owner_conversation_id INTEGER,
	owner_task_id INTEGER,
	record TEXT NOT NULL
);
CREATE TABLE entries (
	id INTEGER PRIMARY KEY,
	conversation_id INTEGER NOT NULL,
	head INTEGER,
	commit_seq INTEGER NOT NULL,
	record TEXT NOT NULL
);
CREATE TABLE documents (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	family INTEGER NOT NULL,
	key_value TEXT NOT NULL,
	scope_kind TEXT NOT NULL,
	owner_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	retired_at INTEGER,
	record TEXT NOT NULL
);
CREATE TABLE document_revisions (
	document_id INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	version INTEGER NOT NULL,
	content TEXT NOT NULL,
	PRIMARY KEY (document_id, seq)
);

INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (2, NULL, NULL, '{"id":2}');
INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) VALUES
	(6, '"pi.agent"', 1, '', 'conversation', 2, 1767300000000, NULL, '{"id":6}'),
	(7, '"agentic.runs"', 0, '', 'session', 0, 1767300000000, NULL, '{"id":7}');
INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES
	(6, 1, 'base', 1, '{"model":{"provider":"github-copilot","modelId":"claude-sonnet-5.5"},"thinkingLevel":"high","cwd":"/Users/someone/development"}'),
	(7, 2, 'base', 1, '{"runs":{"orchestrator":{"conversationId":2}}}');

INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES
	(8, 2, NULL, 1, '{"model":[{"role":"user","content":"start the workflow","timestamp":1767300000000}],"kind":"pi.user","id":8,"conversationId":2}'),
	(9, 2, NULL, 2, '{"model":[{"role":"assistant","content":[{"type":"thinking","thinking":"planning"},{"type":"toolCall","id":"orc-call-1","name":"list_workflows","arguments":{}}],"provider":"github-copilot","model":"claude-sonnet-5.5","usage":{"input":1200,"output":40,"cacheRead":0,"cacheWrite":900,"totalTokens":2140,"cost":{"input":0.0001,"output":0.0004,"cacheRead":0,"cacheWrite":0.001,"total":0.0015},"reasoning":33},"stopReason":"toolUse","timestamp":1767300001000}],"kind":"pi.assistant","id":9,"conversationId":2}'),
	(10, 2, NULL, 3, '{"model":[{"role":"toolResult","toolCallId":"orc-call-1","toolName":"list_workflows","content":[{"type":"text","text":"workflow span-wf running"}],"isError":false,"timestamp":1767300001100}],"kind":"pi.tool-result","id":10,"conversationId":2}'),
	(11, 2, NULL, 4, '{"model":[{"role":"assistant","content":[{"type":"text","text":"done"}],"provider":"github-copilot","model":"claude-sonnet-5.5","usage":{"input":2200,"output":60,"cacheRead":1800,"cacheWrite":0,"totalTokens":4060,"cost":{"input":0.0002,"output":0.0006,"cacheRead":0.0001,"cacheWrite":0,"total":0.0009},"reasoning":12},"stopReason":"stop","timestamp":1767300002000}],"kind":"pi.assistant","id":11,"conversationId":2}'),
	(12, 2, NULL, 5, '{"model":[{"role":"user","content":[{"type":"text","text":"history was compacted into the following summary: goal and open items"}],"timestamp":1767300003000}],"kind":"pi.compaction","id":12,"conversationId":2}');
