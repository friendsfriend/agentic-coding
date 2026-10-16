// The pi-durable harness: the only source with full transcripts.
//
// `harness.sqlite` holds conversations, entries and documents. An entry is a
// JSON record with a `kind` (`pi.assistant`, `pi.tool-result`, `pi.user`,
// `pi.system`, `pi.compaction`); an assistant entry carries the provider's
// usage counters, the stop reason, the thinking parts and the tool calls it
// made, and the matching `pi.tool-result` entry carries the size and error flag
// of the result. Entry bodies are read here and reduced immediately: the
// dataset keeps counts, hashes and digests, never message text.
//
// Run attribution uses the session-scoped `agentic.runs` document, which maps
// an agent handle name (`worker-4c77a71e`) to a conversation id. The handle name
// is matched against `workflow_runs.handle_json.name` in the durable store;
// when that store no longer knows the run, the conversation keeps a synthetic
// id and the row is marked heuristic rather than dropped.

import { Database } from "bun:sqlite";
import { type ArgsDigest, digestToolArgs, looksTruncated } from "./redact.ts";
import type { ReadStats } from "./telemetry.ts";

export interface HarnessToolCall {
	callId: string;
	tool: string;
	args: unknown;
	argsDigest: ArgsDigest;
}

export interface HarnessToolResult {
	callId?: string;
	tool?: string;
	at?: string;
	isError: boolean;
	bytes: number;
	lines: number;
	truncated: boolean;
}

export interface HarnessTurn {
	/** 0-based index of the assistant message within its conversation. */
	index: number;
	at?: string;
	endedAt?: string;
	model?: string;
	provider?: string;
	stopReason?: string;
	thinkingTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costMicros?: number;
	cost?: number;
	toolCalls: HarnessToolCall[];
}

export interface HarnessCompaction {
	at?: string;
	summaryBytes: number;
}

export interface HarnessConversation {
	id: number;
	/** Handle name from the `agentic.runs` document, when the store has one. */
	label?: string;
	cwd?: string;
	model?: string;
	provider?: string;
	turns: HarnessTurn[];
	/** Tool results keyed by the call they answered. */
	toolResults: Map<string, HarnessToolResult>;
	compactions: HarnessCompaction[];
}

export interface HarnessReadResult {
	conversations: HarnessConversation[];
	stats: ReadStats;
}

interface EntryRow {
	id: number;
	conversation_id: number;
	record: string;
}

interface DocumentRow {
	id: number;
	kind: string;
	scope_kind: string;
	owner_id: number;
}

interface RevisionRow {
	document_id: number;
	seq: number;
	kind: string;
	content: string;
}

function unquote(value: unknown): string {
	return typeof value === "string" ? value.replace(/^"|"$/g, "") : "";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function iso(ms: unknown): string | undefined {
	return typeof ms === "number" && Number.isFinite(ms)
		? new Date(ms).toISOString()
		: undefined;
}

/** Apply the harness's document patch: an array of `["s", [path...], value]`
 * set operations. Unknown operations are counted, not applied. */
function applyPatch(
	state: Record<string, unknown>,
	content: string,
): { applied: number; ignored: number } {
	let ops: unknown;
	try {
		ops = JSON.parse(content);
	} catch {
		return { applied: 0, ignored: 1 };
	}
	if (!Array.isArray(ops)) return { applied: 0, ignored: 1 };
	let applied = 0;
	let ignored = 0;
	for (const op of ops) {
		if (
			!Array.isArray(op) ||
			op.length !== 3 ||
			op[0] !== "s" ||
			!Array.isArray(op[1]) ||
			op[1].length === 0
		) {
			ignored += 1;
			continue;
		}
		const path = op[1] as string[];
		let cursor = state;
		for (const key of path.slice(0, -1)) {
			const next = cursor[key];
			if (next && typeof next === "object" && !Array.isArray(next))
				cursor = next as Record<string, unknown>;
			else {
				const created: Record<string, unknown> = {};
				cursor[key] = created;
				cursor = created;
			}
		}
		cursor[path[path.length - 1] as string] = op[2];
		applied += 1;
	}
	return { applied, ignored };
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const textPart = (part as { text?: unknown }).text;
		if (typeof textPart === "string") text += textPart;
	}
	return text;
}

function parseAssistant(
	record: Record<string, unknown>,
): HarnessTurn | undefined {
	const messages = record.model;
	if (!Array.isArray(messages)) return undefined;
	const message = messages[0];
	if (!message || typeof message !== "object") return undefined;
	const assistant = message as Record<string, unknown>;
	if (assistant.role !== "assistant") return undefined;
	const usage = (assistant.usage ?? {}) as Record<string, unknown>;
	const cost = (usage.cost ?? {}) as Record<string, unknown>;
	const toolCalls: HarnessToolCall[] = [];
	const content = assistant.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const call = part as Record<string, unknown>;
			if (call.type !== "toolCall") continue;
			const callId = str(call.id) ?? `unnamed-${toolCalls.length}`;
			const tool = str(call.name) ?? "unknown";
			toolCalls.push({
				callId,
				tool,
				args: call.arguments,
				argsDigest: digestToolArgs(tool, call.arguments),
			});
		}
	}
	const totalCost = num(cost.total);
	return {
		index: -1,
		at: iso(assistant.timestamp) ?? iso(record.timestamp),
		model: str(assistant.model),
		provider: str(assistant.provider),
		stopReason: str(assistant.stopReason),
		thinkingTokens: num(usage.reasoning),
		inputTokens: num(usage.input),
		outputTokens: num(usage.output),
		cacheReadTokens: num(usage.cacheRead),
		cacheWriteTokens: num(usage.cacheWrite),
		totalTokens: num(usage.totalTokens),
		cost: totalCost,
		toolCalls,
	};
}

function parseToolResult(
	record: Record<string, unknown>,
): HarnessToolResult | undefined {
	const messages = record.model;
	if (!Array.isArray(messages)) return undefined;
	const message = messages[0];
	if (!message || typeof message !== "object") return undefined;
	const toolResult = message as Record<string, unknown>;
	const text = extractContentText(toolResult.content);
	return {
		callId: str(toolResult.toolCallId),
		tool: str(toolResult.toolName),
		at: iso(toolResult.timestamp) ?? iso(record.timestamp),
		isError: toolResult.isError === true,
		bytes: Buffer.byteLength(text, "utf8"),
		lines: text.length === 0 ? 0 : text.split("\n").length,
		truncated: looksTruncated(text),
	};
}

interface RunsDocumentState {
	applied: number;
	ignored: number;
}

/** Read one harness store. Read-only; a corrupt harness degrades to a note. */
export function readHarness(filePath: string): HarnessReadResult {
	const stats: ReadStats = { records: 0, parsed: 0, skipped: 0, notes: [] };
	const conversations = new Map<number, HarnessConversation>();
	let db: Database | undefined;
	try {
		db = new Database(filePath, { readonly: true });
		const conversationRows = db
			.query<{ id: number }, []>("select id from conversations order by id")
			.all();
		for (const row of conversationRows)
			conversations.set(Number(row.id), {
				id: Number(row.id),
				turns: [],
				toolResults: new Map(),
				compactions: [],
			});

		// Documents: the session `agentic.runs` map and each conversation's
		// `pi.agent` identity (cwd plus the model the run was launched with).
		const documents = db
			.query<DocumentRow, []>(
				"select id, kind, scope_kind, owner_id from documents",
			)
			.all();
		const revisions = db
			.query<RevisionRow, []>(
				"select document_id, seq, kind, content from document_revisions order by document_id, seq",
			)
			.all();
		const byDocument = new Map<number, RevisionRow[]>();
		const patchOutcome: RunsDocumentState = { applied: 0, ignored: 0 };
		for (const revision of revisions) {
			const list = byDocument.get(revision.document_id) ?? [];
			list.push(revision);
			byDocument.set(revision.document_id, list);
		}
		for (const document of documents) {
			const kind = unquote(document.kind);
			const list = byDocument.get(document.id) ?? [];
			if (list.length === 0) continue;
			if (kind === "pi.agent") {
				// The newest base revision is the current full state.
				const base = [...list]
					.reverse()
					.find((revision) => revision.kind === "base");
				const state = base === undefined ? undefined : safeParse(base.content);
				const conversation = conversations.get(Number(document.owner_id));
				if (conversation && state) {
					conversation.cwd = str(state.cwd) ?? conversation.cwd;
					const model = state.model as Record<string, unknown> | undefined;
					if (model) {
						conversation.provider =
							str(model.provider) ?? conversation.provider;
						conversation.model = str(model.modelId) ?? conversation.model;
					}
				}
				continue;
			}
			if (kind !== "agentic.runs") continue;
			const baseIndex = list.reduce(
				(best, revision, index) => (revision.kind === "base" ? index : best),
				-1,
			);
			const base = baseIndex >= 0 ? list[baseIndex] : undefined;
			const state = base === undefined ? {} : (safeParse(base.content) ?? {});
			for (const revision of list.slice(baseIndex + 1)) {
				const outcome = applyPatch(state, revision.content);
				patchOutcome.applied += outcome.applied;
				patchOutcome.ignored += outcome.ignored;
			}
			if (patchOutcome.applied > 0 || patchOutcome.ignored > 0)
				stats.notes.push(
					`agentic.runs: ${patchOutcome.applied} patch(es) applied, ${patchOutcome.ignored} ignored`,
				);
			const runs = state.runs;
			if (runs && typeof runs === "object") {
				for (const [label, value] of Object.entries(
					runs as Record<string, unknown>,
				)) {
					if (!value || typeof value !== "object") continue;
					const conversationId = num(
						(value as Record<string, unknown>).conversationId,
					);
					if (conversationId === undefined) continue;
					const conversation = conversations.get(conversationId);
					if (conversation) conversation.label = label;
				}
			}
		}

		const entries = db
			.query<EntryRow, []>(
				"select id, conversation_id, record from entries order by conversation_id, id",
			)
			.all();
		for (const entry of entries) {
			stats.records += 1;
			let record: Record<string, unknown>;
			try {
				const parsed = JSON.parse(entry.record);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					stats.skipped += 1;
					continue;
				}
				record = parsed as Record<string, unknown>;
			} catch {
				stats.skipped += 1;
				continue;
			}
			const conversation = conversations.get(Number(entry.conversation_id));
			if (!conversation) {
				stats.skipped += 1;
				continue;
			}
			const kind = unquote(record.kind);
			switch (kind) {
				case "pi.assistant": {
					const turn = parseAssistant(record);
					if (turn === undefined) {
						stats.skipped += 1;
						continue;
					}
					turn.index = conversation.turns.length;
					conversation.turns.push(turn);
					break;
				}
				case "pi.tool-result": {
					const toolResult = parseToolResult(record);
					if (toolResult === undefined) {
						stats.skipped += 1;
						continue;
					}
					if (toolResult.callId !== undefined)
						conversation.toolResults.set(toolResult.callId, toolResult);
					break;
				}
				case "pi.compaction": {
					const messages = record.model;
					const message = Array.isArray(messages) ? messages[0] : undefined;
					conversation.compactions.push({
						at: iso(
							(message as Record<string, unknown> | undefined)?.timestamp,
						),
						summaryBytes: Buffer.byteLength(
							extractContentText(
								(message as Record<string, unknown> | undefined)?.content,
							),
							"utf8",
						),
					});
					break;
				}
				default:
					break;
			}
			stats.parsed += 1;
		}
	} catch (error) {
		stats.notes.push(`unreadable: ${(error as Error).message}`);
	} finally {
		db?.close();
	}
	return { conversations: [...conversations.values()], stats };
}

function safeParse(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	return undefined;
}
