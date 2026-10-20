// The stage step journal (`add-stage-flow-evidence`, task 1.1).
//
// One workflow's flow test writes one line per step into
// `stage-journal.jsonl`, beside its `manifest.json`. A file rather than a store
// table, for two reasons the design names: nothing about the store's schema has
// to change, and `workspace.cleanup` already removes the evidence directory the
// journal lives in.
//
// What the writer guarantees:
//
// * **The server owns the facts.** The sequence number, the time, the session,
//   the application, the role, the sanitized URL, the recording segment and the
//   offset are all derived here or handed in by the route that already knows
//   them; a caller supplies only its own text.
// * **Redaction happens before the bytes land.** Everything the caller wrote and
//   the URL the server resolved pass through the caller's redactor (`redact`),
//   which is the same one every browser reply is scrubbed with, and a value it
//   would mask is masked in the file.
// * **A referenced evidence id has to exist.** A step that names evidence the
//   manifest does not hold is refused, so the flow page can never link a picture
//   that is not there.
// * **The file is capped.** Past the evidence per-file cap further steps are
//   refused with `stage-journal-full` rather than silently dropping a step or
//   growing forever.
//
// The flow page (`stage-flow.html`) is rendered from the journal and the manifest
// and is deterministic: the same two inputs always produce the same bytes.
import fs from "node:fs";
import type {
	EvidenceEntry,
	EvidenceManifest,
} from "../../contracts/environment.ts";
import type {
	StageJournal,
	StageJournalEntry,
	StageJournalKnowledge,
} from "../../contracts/stages.ts";
import { flowOffsetLabel } from "../../workflow/format.ts";
import {
	type WorkflowEvidenceScope,
	withEvidenceRootLock,
} from "../../workflow/runtime/evidence-store.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
	secureDirectoryNames,
	writeAtomicPrivateFile,
} from "../../workflow/secure-fs.ts";
import {
	EVIDENCE_FILE_MAX_BYTES,
	EvidenceError,
	listEvidence,
} from "./store.ts";

/** The journal file inside one workflow's evidence directory. */
export const STAGE_JOURNAL_FILE = "stage-journal.jsonl";
/** The rendered flow page, beside the evidence files it links to. */
export const STAGE_FLOW_FILE = "stage-flow.html";
/** How many entries one read answers with, at most. */
export const MAX_STAGE_JOURNAL_ENTRIES = 200;
/** The bound a single `stage_journal` read defaults to. */
export const DEFAULT_STAGE_JOURNAL_LIMIT = 50;
/** Most entries the file may hold: the per-file cap in entries, so a file of
 * tiny steps cannot grow without the byte cap noticing late. */
const MAX_JOURNAL_SEQUENCES = 5_000;
/** How much of the journal one read parses. The file is capped at the evidence
 * per-file limit, so this is the same bound the writer enforces. */
const MAX_JOURNAL_READ_BYTES = EVIDENCE_FILE_MAX_BYTES;

/** The entry the writer builds; the sequence number and the time are the
 * server's. */
export interface StageJournalAppend {
	readonly session?: string;
	readonly app?: string;
	readonly role?: string;
	readonly url?: string;
	readonly label: string;
	readonly expected?: string;
	readonly observed?: string;
	readonly captures?: Readonly<Record<string, string>>;
	readonly evidence?: readonly string[];
	readonly knowledge?: StageJournalKnowledge;
	readonly segment?: number;
	readonly offsetMs?: number;
	/** Test seam: the clock the server time is taken from. */
	readonly now?: () => Date;
}

/** The redactor every written value passes through: the same one the browser
 * routes scrub their replies with. */
export type JournalRedactor = (value: string) => string;

/** A redactor that does nothing, for a caller with no secret set (a test, or a
 * server whose configuration has no `.env`). */
export const identityRedactor: JournalRedactor = (value) => value;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function openJournalDirectory(scope: WorkflowEvidenceScope): number {
	return openSecureDirectory(scope.root, scope.dataRoot, false);
}

/** The same directory, for a write. The data root is the boundary the root is
 * opened inside, so it has to exist before the chain can be followed into it —
 * the same precondition the store's own writer has. */
function openJournalDirectoryToWrite(scope: WorkflowEvidenceScope): number {
	fs.mkdirSync(scope.dataRoot, { recursive: true, mode: 0o700 });
	return openSecureDirectory(scope.root, scope.dataRoot, true);
}

/** One masked failure: a journal that cannot be read is reported, never
 * reinterpreted as an empty one. */
function unreadableJournal(
	scope: WorkflowEvidenceScope,
	error: unknown,
): never {
	throw new EvidenceError(
		"evidence-manifest",
		`the stage journal of ${scope.workflowId} cannot be read: ${
			error instanceof Error ? error.message : String(error)
		}`,
		500,
	);
}

function parseEntry(line: string): StageJournalEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.seq !== "number" || typeof record.at !== "string")
		return undefined;
	if (typeof record.label !== "string") return undefined;
	return record as unknown as StageJournalEntry;
}

/** Every entry of one workflow's journal, in write order. A workflow that never
 * wrote a step answers with none — that is what the panel's unchanged rendering
 * and `stage_journal`'s empty answer both key off. */
export function readStageJournal(
	scope: WorkflowEvidenceScope,
): StageJournalEntry[] {
	let directory: number | undefined;
	try {
		directory = openJournalDirectory(scope);
	} catch {
		return [];
	}
	let fd: number | undefined;
	try {
		fd = openSecureFile(directory, STAGE_JOURNAL_FILE);
	} catch {
		// No journal yet: the workflow simply recorded no step.
		return [];
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile())
			throw new EvidenceError(
				"evidence-manifest",
				`the stage journal of ${scope.workflowId} is not a regular file`,
				500,
			);
		if (stat.size > MAX_JOURNAL_READ_BYTES)
			throw new EvidenceError(
				"evidence-manifest",
				`the stage journal of ${scope.workflowId} is larger than ${MAX_JOURNAL_READ_BYTES} bytes`,
				500,
			);
		const text = fs.readFileSync(fd, "utf8");
		const entries: StageJournalEntry[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			const entry = parseEntry(line);
			// One malformed line does not make the rest unreadable: it is skipped,
			// because the writer only ever appends whole lines.
			if (entry !== undefined) entries.push(entry);
		}
		return entries;
	} catch (error) {
		if (error instanceof EvidenceError) throw error;
		throw unreadableJournal(scope, error);
	} finally {
		fs.closeSync(fd);
	}
}

/** Whether this workflow has a journal at all, which is what decides whether the
 * flow page and the panel's grouping exist. Never throws: a directory that
 * cannot be listed has no journal. */
export function hasStageJournal(scope: WorkflowEvidenceScope): boolean {
	let directory: number | undefined;
	try {
		directory = openJournalDirectory(scope);
	} catch {
		return false;
	}
	try {
		return secureDirectoryNames(directory, 1_000).includes(STAGE_JOURNAL_FILE);
	} catch {
		return false;
	} finally {
		closeSecureDirectory(directory);
	}
}

/** The journal as a reader gets it: the latest entries (bounded), optionally
 * narrowed to one session or application. */
export function journalSummary(
	scope: WorkflowEvidenceScope,
	options: {
		readonly session?: string;
		readonly app?: string;
		readonly limit?: number;
	} = {},
): StageJournal {
	const limit = Math.min(
		MAX_STAGE_JOURNAL_ENTRIES,
		Math.max(1, Math.floor(options.limit ?? DEFAULT_STAGE_JOURNAL_LIMIT)),
	);
	const matching = readStageJournal(scope).filter(
		(entry) =>
			(options.session === undefined || entry.session === options.session) &&
			(options.app === undefined || entry.app === options.app),
	);
	return {
		workflowId: scope.workflowId,
		entries: matching.slice(Math.max(0, matching.length - limit)),
		...(hasStageJournal(scope) ? { flowPage: STAGE_FLOW_FILE } : {}),
	};
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Redact one optional text, keeping `undefined` as absent. */
function redactText(
	redact: JournalRedactor,
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	const redacted = redact(value);
	return redacted === "" ? undefined : redacted;
}

function redactCaptures(
	redact: JournalRedactor,
	captures: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (captures === undefined) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(captures))
		out[redact(name)] = redact(value);
	return Object.keys(out).length === 0 ? undefined : out;
}

/** The evidence ids a step names, refused when one is not in the manifest. This
 * is the only refusal that leaves the journal untouched, so it runs before the
 * append. */
function requireEvidence(
	manifest: EvidenceManifest,
	ids: readonly string[] | undefined,
): readonly string[] | undefined {
	if (ids === undefined || ids.length === 0) return undefined;
	const known = new Set(manifest.entries.map((entry) => entry.id));
	for (const id of ids)
		if (!known.has(id))
			throw new EvidenceError(
				"evidence-missing",
				`no evidence ${id} is recorded for this workflow; attach it first or drop it from the step`,
				404,
			);
	return [...new Set(ids)];
}

/**
 * Append one step and answer the entry the file now holds. Refuses with
 * `evidence-missing` for an unknown evidence id and `stage-journal-full` when the
 * file is at its cap; in both cases nothing is written.
 */
export async function appendStageJournalEntry(
	scope: WorkflowEvidenceScope,
	input: StageJournalAppend,
	redact: JournalRedactor = identityRedactor,
): Promise<StageJournalEntry> {
	return await withEvidenceRootLock(scope.root, async () => {
		const existing = readStageJournal(scope);
		if (existing.length >= MAX_JOURNAL_SEQUENCES)
			throw new EvidenceError(
				"stage-journal-full",
				`the stage journal of ${scope.workflowId} already holds ${MAX_JOURNAL_SEQUENCES} entries; nothing was discarded to make room`,
				409,
			);
		const manifest = listEvidence(scope);
		const evidence = requireEvidence(manifest, input.evidence);
		const captures = redactCaptures(redact, input.captures);
		const knowledge = input.knowledge;
		const at = (input.now?.() ?? new Date()).toISOString();
		const entry: StageJournalEntry = {
			seq: (existing[existing.length - 1]?.seq ?? 0) + 1,
			at,
			...(input.session === undefined
				? {}
				: { session: redact(input.session) }),
			...(input.app === undefined ? {} : { app: redact(input.app) }),
			...(input.role === undefined ? {} : { role: redact(input.role) }),
			...textField("url", redactText(redact, input.url)),
			label: redact(input.label),
			...textField("expected", redactText(redact, input.expected)),
			...textField("observed", redactText(redact, input.observed)),
			...(captures === undefined ? {} : { captures }),
			...(evidence === undefined ? {} : { evidence }),
			...(knowledge === undefined
				? {}
				: {
						knowledge: {
							concept: redact(knowledge.concept),
							...(knowledge.section === undefined
								? {}
								: { section: redact(knowledge.section) }),
							kind: knowledge.kind,
							...(knowledge.suspectedCause === undefined
								? {}
								: { suspectedCause: knowledge.suspectedCause }),
						},
					}),
			...(input.segment === undefined ? {} : { segment: input.segment }),
			...(input.offsetMs === undefined ? {} : { offsetMs: input.offsetMs }),
		};
		const line = `${JSON.stringify(entry)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		const held = existing.reduce(
			(total, each) =>
				total + Buffer.byteLength(`${JSON.stringify(each)}\n`, "utf8"),
			0,
		);
		if (held + bytes > EVIDENCE_FILE_MAX_BYTES)
			throw new EvidenceError(
				"stage-journal-full",
				`the stage journal of ${scope.workflowId} is at its ${EVIDENCE_FILE_MAX_BYTES}-byte cap; no further step is recorded and nothing was discarded`,
				409,
			);
		appendLine(scope, line);
		return entry;
	});
}

/** One `{ field: value }` spread, so an absent text is absent from the file
 * rather than an explicit `undefined` the reader would have to tolerate. */
function textField<K extends string>(
	name: K,
	value: string | undefined,
): { [P in K]?: string } {
	return (value === undefined ? {} : { [name]: value }) as {
		[P in K]?: string;
	};
}

function appendLine(scope: WorkflowEvidenceScope, line: string): void {
	const directory = openJournalDirectoryToWrite(scope);
	let fd: number | undefined;
	try {
		fd = openSecureFile(
			directory,
			STAGE_JOURNAL_FILE,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_APPEND |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		fs.writeSync(fd, line);
		fs.fchmodSync(fd, 0o600);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		closeSecureDirectory(directory);
	}
}

/**
 * Back-fill the kept video's evidence id onto the entries of one segment
 * (`task 1.2`). Entries keep their order and their sequence numbers; only the
 * matching segment's `video` field is added, and a segment that already named a
 * video is left alone so a retried stop cannot rewrite history.
 */
export async function backfillStageJournalVideo(
	scope: WorkflowEvidenceScope,
	input: {
		readonly segment: number;
		readonly video: string;
		readonly session?: string;
	},
): Promise<number> {
	return await withEvidenceRootLock(scope.root, async () => {
		const entries = readStageJournal(scope);
		let changed = 0;
		const updated = entries.map((entry) => {
			if (entry.segment !== input.segment) return entry;
			if (input.session !== undefined && entry.session !== input.session)
				return entry;
			if (entry.video !== undefined) return entry;
			changed += 1;
			return { ...entry, video: input.video };
		});
		if (changed === 0) return 0;
		writeJournal(scope, updated);
		return changed;
	});
}

function writeJournal(
	scope: WorkflowEvidenceScope,
	entries: readonly StageJournalEntry[],
): void {
	const directory = openJournalDirectoryToWrite(scope);
	try {
		writeAtomicPrivateFile(
			directory,
			STAGE_JOURNAL_FILE,
			entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
			0o600,
		);
	} finally {
		closeSecureDirectory(directory);
	}
}

// ---------------------------------------------------------------------------
// Flow page
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** The `#t=` fragment a step seeks to, in whole seconds: the media fragment
 * syntax every system browser understands. */
function flowSeekSeconds(offsetMs: number): number {
	return Math.max(0, Math.round(offsetMs / 1000));
}

interface FlowStep {
	readonly entry: StageJournalEntry;
	readonly captions: readonly string[];
}

interface FlowSegment {
	readonly segment: number;
	readonly video?: EvidenceEntry;
	readonly steps: FlowStep[];
}

function captionsOf(
	entry: StageJournalEntry,
	byId: ReadonlyMap<string, EvidenceEntry>,
): readonly string[] {
	const captions: string[] = [];
	for (const id of entry.evidence ?? []) {
		const evidence = byId.get(id);
		if (evidence !== undefined)
			captions.push(`${evidence.kind} ${evidence.id}: ${evidence.caption}`);
	}
	return captions;
}

/** Group the journal into segments, in journal order. A step without a segment
 * is kept apart: it was written while no recording ran. */
function flowSegments(
	entries: readonly StageJournalEntry[],
	manifest: EvidenceManifest,
): { segments: FlowSegment[]; loose: FlowStep[] } {
	const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
	const videos = new Map<number, EvidenceEntry>();
	for (const entry of manifest.entries)
		if (entry.kind === "video" && entry.segment !== undefined)
			videos.set(entry.segment, entry);
	const segments = new Map<number, FlowStep[]>();
	const loose: FlowStep[] = [];
	for (const entry of entries) {
		const step: FlowStep = { entry, captions: captionsOf(entry, byId) };
		if (entry.segment === undefined) {
			loose.push(step);
			continue;
		}
		const group = segments.get(entry.segment);
		if (group) group.push(step);
		else segments.set(entry.segment, [step]);
	}
	return {
		segments: [...segments.entries()].map(([segment, steps]) => ({
			segment,
			...(videos.get(segment) === undefined
				? {}
				: { video: videos.get(segment) as EvidenceEntry }),
			steps,
		})),
		loose,
	};
}

function stepHtml(step: FlowStep, video?: EvidenceEntry): string {
	const entry = step.entry;
	const where = [entry.app, entry.role].filter(Boolean).join(" / ");
	const offset =
		entry.offsetMs === undefined ? "" : flowOffsetLabel(entry.offsetMs);
	const href =
		video !== undefined && entry.offsetMs !== undefined
			? ` href="${escapeHtml(`${video.file}#t=${flowSeekSeconds(entry.offsetMs)}`)}"`
			: "";
	const lines = [
		`\t\t<li><a${href}>${escapeHtml(offset === "" ? entry.label : `${offset} ${entry.label}`)}</a>`,
	];
	if (where !== "")
		lines.push(`\t\t\t<span class="where">${escapeHtml(where)}</span>`);
	if (entry.expected !== undefined)
		lines.push(
			`\t\t\t<span class="expected">expected ${escapeHtml(entry.expected)}</span>`,
		);
	if (entry.observed !== undefined)
		lines.push(
			`\t\t\t<span class="observed">observed ${escapeHtml(entry.observed)}</span>`,
		);
	for (const [name, value] of Object.entries(entry.captures ?? {}))
		lines.push(
			`\t\t\t<span class="capture">${escapeHtml(name)}=${escapeHtml(value)}</span>`,
		);
	for (const caption of step.captions)
		lines.push(`\t\t\t<span class="evidence">${escapeHtml(caption)}</span>`);
	lines.push("\t\t</li>");
	return lines.join("\n");
}

/**
 * The flow page: one section per segment in journal order, the segment's video by
 * relative path, and every step a link that seeks its offset with a `#t=` media
 * fragment. Deterministic — no clock, no randomness, stable markup — so the same
 * journal and manifest always produce the same file.
 */
export function renderStageFlowPage(
	workflowId: string,
	entries: readonly StageJournalEntry[],
	manifest: EvidenceManifest,
): string {
	const { segments, loose } = flowSegments(entries, manifest);
	const body: string[] = [];
	for (const segment of segments) {
		body.push(`\t<section id="segment-${segment.segment}">`);
		body.push(`\t\t<h2>Segment ${segment.segment}</h2>`);
		if (segment.video !== undefined) {
			const first = segment.steps[0]?.entry;
			body.push(
				`\t\t<video controls preload="metadata" src="${escapeHtml(segment.video.file)}"${
					first?.offsetMs === undefined
						? ""
						: ` data-start="${flowSeekSeconds(first.offsetMs)}"`
				}>${escapeHtml(segment.video.caption)}</video>`,
			);
			body.push(
				`\t\t<p class="video">${escapeHtml(segment.video.caption)} <a href="${escapeHtml(segment.video.file)}">open the recording</a></p>`,
			);
		} else {
			body.push(
				'\t\t<p class="video missing">this segment was not kept as a recording</p>',
			);
		}
		body.push("\t\t<ol>");
		for (const step of segment.steps) body.push(stepHtml(step, segment.video));
		body.push("\t\t</ol>");
		body.push("\t</section>");
	}
	if (loose.length > 0) {
		body.push('\t<section id="no-segment">');
		body.push("\t\t<h2>Steps without a recording</h2>");
		body.push("\t\t<ol>");
		for (const step of loose) body.push(stepHtml(step));
		body.push("\t\t</ol>");
		body.push("\t</section>");
	}
	if (body.length === 0)
		body.push('\t<p id="empty">This workflow recorded no stage step.</p>');
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'\t<meta charset="utf-8">',
		'\t<meta name="viewport" content="width=device-width, initial-scale=1">',
		`\t<title>Stage flow of ${escapeHtml(workflowId)}</title>`,
		"\t<style>",
		"\t\tbody { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 60rem; }",
		"\t\th2 { margin-bottom: 0.25rem; }",
		"\t\tvideo { max-width: 100%; }",
		"\t\tli { margin-bottom: 0.75rem; }",
		"\t\tli span { display: block; opacity: 0.75; }",
		"\t\t.where { font-weight: 600; opacity: 1; }",
		"\t</style>",
		"</head>",
		"<body>",
		`\t<h1>Stage flow of ${escapeHtml(workflowId)}</h1>`,
		...body,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/**
 * Render and write the flow page beside the evidence. A workflow without a
 * journal has no flow page, so nothing is written: the panel's unchanged
 * rendering and "no open-flow action" both depend on that.
 */
export async function writeStageFlowPage(
	scope: WorkflowEvidenceScope,
	redact: JournalRedactor = identityRedactor,
): Promise<string | undefined> {
	if (!hasStageJournal(scope)) return undefined;
	const entries = readStageJournal(scope);
	const manifest = listEvidence(scope);
	const html = redact(renderStageFlowPage(scope.workflowId, entries, manifest));
	const directory = openJournalDirectoryToWrite(scope);
	try {
		writeAtomicPrivateFile(directory, STAGE_FLOW_FILE, html, 0o600);
	} finally {
		closeSecureDirectory(directory);
	}
	return STAGE_FLOW_FILE;
}
