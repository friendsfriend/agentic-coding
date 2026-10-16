-- Synthetic pi-durable harness of the `span-wf` worktree: three conversations.
-- Conversation 2 is `run-span-a` (handle `worker-aaaa`), conversation 3 is
-- `run-span-b` (handle `worker-bbbb`) and conversation 4 has no handle at all —
-- the unattributed path. The transcript carries secret-shaped strings on
-- purpose: nothing from them may reach the dataset.
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

INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES
	(2, NULL, NULL, '{"id":2}'),
	(3, 2, 5, '{"id":3}'),
	(4, 2, 6, '{"id":4}');

INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) VALUES
	(6, '"pi.agent"', 1, '', 'conversation', 2, 1767344400000, NULL, '{"id":6}'),
	(7, '"agentic.runs"', 0, '', 'session', 0, 1767344400000, NULL, '{"id":7}'),
	(20, '"pi.agent"', 1, '', 'conversation', 3, 1767348000000, NULL, '{"id":20}'),
	(24, '"pi.agent"', 1, '', 'conversation', 4, 1767351600000, NULL, '{"id":24}');

INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES
	(6, 1, 'base', 1, '{"model":{"provider":"opencode-go","modelId":"deepseek-v4.1-flash"},"thinkingLevel":"high","cwd":"/Users/someone/development/worktrees/agentic-coding.feature-span-wf"}'),
	(7, 2, 'base', 1, '{"runs":{"worker-aaaa":{"conversationId":2}}}'),
	(7, 30, 'delta', 1, '[["s",["runs","worker-bbbb"],{"conversationId":3}]]'),
	(20, 29, 'base', 1, '{"model":{"provider":"opencode-go","modelId":"deepseek-v4.1-flash"},"thinkingLevel":"high","cwd":"/Users/someone/development/worktrees/agentic-coding.feature-span-wf"}'),
	(24, 40, 'base', 1, '{"model":{"provider":"opencode-go","modelId":"deepseek-v4.1-flash"},"cwd":"/Users/someone/development/worktrees/agentic-coding.feature-span-wf"}');

-- Conversation 2 → run-span-a: two turns, two calls.
INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES
	(100, 2, NULL, 1, '{"model":[{"role":"assistant","content":[{"type":"thinking","thinking":"inspect"},{"type":"toolCall","id":"call-a1","name":"bash","arguments":{"command":"sed -n 1,40p src/a.ts"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":1000,"output":100,"cacheRead":0,"cacheWrite":0,"totalTokens":1100,"cost":{"input":0.0001,"output":0.001,"cacheRead":0,"cacheWrite":0,"total":0.0011},"reasoning":40},"stopReason":"toolUse","timestamp":1767344401000}],"kind":"pi.assistant","id":100,"conversationId":2}'),
	(101, 2, NULL, 2, '{"model":[{"role":"toolResult","toolCallId":"call-a1","toolName":"bash","content":[{"type":"text","text":"line one\nline two"}],"isError":false,"timestamp":1767344404700}],"kind":"pi.tool-result","id":101,"conversationId":2}'),
	(102, 2, NULL, 3, '{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-a2","name":"read","arguments":{"path":"src/a.ts"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":1500,"output":120,"cacheRead":500,"cacheWrite":0,"totalTokens":2120,"cost":{"input":0.0002,"output":0.0012,"cacheRead":0.0001,"cacheWrite":0,"total":0.0015},"reasoning":15},"stopReason":"toolUse","timestamp":1767344405000}],"kind":"pi.assistant","id":102,"conversationId":2}'),
	(103, 2, NULL, 4, '{"model":[{"role":"toolResult","toolCallId":"call-a2","toolName":"read","content":[{"type":"text","text":"[truncated 900 bytes]"}],"isError":false,"timestamp":1767344409300}],"kind":"pi.tool-result","id":103,"conversationId":2}');

-- Conversation 3 → run-span-b: one turn in the transcript (the main store saw
-- two), one failing call.
INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES
	(200, 3, NULL, 1, '{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-b1","name":"bash","arguments":{"command":"bun test test/a.test.ts"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":2000,"output":90,"cacheRead":0,"cacheWrite":0,"totalTokens":2090,"cost":{"input":0.0003,"output":0.0009,"cacheRead":0,"cacheWrite":0,"total":0.0012},"reasoning":8},"stopReason":"toolUse","timestamp":1767348001000}],"kind":"pi.assistant","id":200,"conversationId":3}'),
	(201, 3, NULL, 2, '{"model":[{"role":"toolResult","toolCallId":"call-b1","toolName":"bash","content":[{"type":"text","text":"1 test failed"}],"isError":true,"timestamp":1767348004800}],"kind":"pi.tool-result","id":201,"conversationId":3}');

-- Conversation 4: no handle, so no run attribution. Its arguments and results
-- are the secret-shaped ones the redaction test looks for, and two of its calls
-- read the same path so the repeated-call queries have a hit.
INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES
	(300, 4, NULL, 1, '{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-c1","name":"bash","arguments":{"command":"curl -H Authorization:Bearer sk-live-abcdefghijklmnop https://user:hunter2@example.com/x"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.00001},"reasoning":1},"stopReason":"toolUse","timestamp":1767351601000}],"kind":"pi.assistant","id":300,"conversationId":4}'),
	(301, 4, NULL, 2, '{"model":[{"role":"toolResult","toolCallId":"call-c1","toolName":"bash","content":[{"type":"text","text":"api_key=ghp_0123456789abcdefghij token sk-live-abcdefghijklmnop ok"}],"isError":false,"timestamp":1767351601500}],"kind":"pi.tool-result","id":301,"conversationId":4}'),
	(302, 4, NULL, 3, '{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-c2","name":"read","arguments":{"path":"src/dup.ts"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":20,"output":5,"totalTokens":25,"cost":{"total":0.00002}},"stopReason":"toolUse","timestamp":1767351602000}],"kind":"pi.assistant","id":302,"conversationId":4}'),
	(303, 4, NULL, 4, '{"model":[{"role":"toolResult","toolCallId":"call-c2","toolName":"read","content":[{"type":"text","text":"export const dup = 1;\nexport const more = 2;"}],"isError":false,"timestamp":1767351602300}],"kind":"pi.tool-result","id":303,"conversationId":4}'),
	(304, 4, NULL, 5, '{"model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-c3","name":"read","arguments":{"path":"src/dup.ts"}}],"provider":"opencode-go","model":"deepseek-v4.1-flash","usage":{"input":30,"output":5,"totalTokens":35,"cost":{"total":0.00003}},"stopReason":"toolUse","timestamp":1767351603000}],"kind":"pi.assistant","id":304,"conversationId":4}'),
	(305, 4, NULL, 6, '{"model":[{"role":"toolResult","toolCallId":"call-c3","toolName":"read","content":[{"type":"text","text":"export const dup = 1;\nexport const more = 2;"}],"isError":false,"timestamp":1767351603300}],"kind":"pi.tool-result","id":305,"conversationId":4}');
