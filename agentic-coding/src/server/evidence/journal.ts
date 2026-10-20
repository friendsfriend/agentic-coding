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
//   growing forever. The cap measures the file's own size, so the writer refuses
//   past exactly the size the reader refuses to parse.
// * **An entry names its version.** Every line carries `v`, and a journal a newer
//   build wrote is reported instead of reinterpreted: `backfillStageJournalVideo`
//   and `clearStageJournalSegment` rewrite the whole file from the entries this
//   build parsed, so an unknown field would otherwise be dropped silently. A new
//   per-step field therefore needs a `JOURNAL_VERSION` bump, not just a writer
//   change.
// * **The values are the shape the reader accepts.** The caller's own text is
//   free-form (a page excerpt is multi-line by nature), so control characters are
//   folded to spaces *before* the bytes land: the journal's read contract rejects
//   them, and one such value would otherwise make the whole journal undecodable
//   for a dashboard that reads it through that contract.
//
// The flow page (`stage-flow.html`) is rendered from the journal and the manifest
// and is deterministic: the same two inputs always produce the same bytes.
import fs from "node:fs";
import path from "node:path";
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
/** The entry format this build writes and reads. A journal whose lines name
 * another version is reported, never rewritten: a rewrite would drop every field
 * this build does not know. */
const JOURNAL_VERSION = 1;
/** The URL bound the journal's read contract enforces (`journalText(2048)`). */
const MAX_JOURNAL_URL = 2_048;
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

/** The journal as the file holds it: the entries the reader accepted, the file's
 * own size, and whether the workflow has one at all. */
interface JournalRead {
	readonly entries: StageJournalEntry[];
	/** The file's own size in bytes — what the append cap measures, because those
	 * are the bytes the reader refuses past, including a line it skipped. */
	readonly bytes: number;
	readonly present: boolean;
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
	// An absent `v` is the format this build wrote before the marker existed, so it
	// reads as 1. Any other version is a journal this build cannot rewrite safely.
	if (record.v !== undefined && record.v !== JOURNAL_VERSION)
		throw new EvidenceError(
			"evidence-manifest",
			`the stage journal was written by a newer build (entry version ${String(
				record.v,
			)}); this build reads version ${JOURNAL_VERSION}`,
			500,
		);
	if (typeof record.seq !== "number" || typeof record.at !== "string")
		return undefined;
	if (typeof record.label !== "string") return undefined;
	return record as unknown as StageJournalEntry;
}

/** The journal, with the file's own size. One open, one `fstat`, one read: the
 * append and the summary both need the size, and neither may derive it by
 * re-serializing what it parsed. */
function readJournalFile(scope: WorkflowEvidenceScope): JournalRead {
	let directory: number | undefined;
	try {
		directory = openJournalDirectory(scope);
	} catch {
		return { entries: [], bytes: 0, present: false };
	}
	let fd: number | undefined;
	try {
		fd = openSecureFile(directory, STAGE_JOURNAL_FILE);
	} catch {
		// No journal yet: the workflow simply recorded no step.
		closeSecureDirectory(directory);
		return { entries: [], bytes: 0, present: false };
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
		return { entries, bytes: stat.size, present: true };
	} catch (error) {
		if (error instanceof EvidenceError) throw error;
		throw unreadableJournal(scope, error);
	} finally {
		fs.closeSync(fd);
		closeSecureDirectory(directory);
	}
}

/** Every entry of one workflow's journal, in write order. A workflow that never
 * wrote a step answers with none — that is what the panel's unchanged rendering
 * and `stage_journal`'s empty answer both key off. */
export function readStageJournal(
	scope: WorkflowEvidenceScope,
): StageJournalEntry[] {
	return readJournalFile(scope).entries;
}

/** The highest segment number the journal already names, or 0 when it names none:
 * the floor a new recording's segment number is issued above, so a resumed run
 * cannot hand a segment the number its own steps link. */
export function highestStageSegment(scope: WorkflowEvidenceScope): number {
	return readStageJournal(scope).reduce(
		(highest, entry) => Math.max(highest, entry.segment ?? 0),
		0,
	);
}

/** The one cached parse the dashboard reads through. It is keyed by the file's own
 * `(path, mtime, size)` and every writer clears it, so a mutation can never be
 * served from it — only an unchanged file can. */
let journalCache:
	| {
			/** The workflow's own journal, not the directory its worktree shares with
			 * every other workflow of the same repository: two journals of one
			 * worktree are two different files. */
			readonly path: string;
			readonly workflowId: string;
			readonly mtimeMs: number;
			readonly size: number;
			readonly entries: StageJournalEntry[];
			readonly present: boolean;
	  }
	| undefined;

/** The journal as one dashboard observation wants it: every entry, plus the flow
 * page's name when there is one.
 *
 * Cached by `(mtime, size)`: the dashboard re-reads its observations on every
 * refresh, and an unchanged journal must cost a `stat` rather than re-parsing a
 * file that can reach 20 MB — the same bound the tool read puts on itself, where
 * a *read per second* would still be the whole history. */
export function stageJournalSnapshot(
	scope: WorkflowEvidenceScope,
): StageJournal {
	const stat = journalStat(scope);
	if (stat === undefined) return { workflowId: scope.workflowId, entries: [] };
	if (
		journalCache !== undefined &&
		journalCache.path === stat.path &&
		journalCache.workflowId === stat.workflowId &&
		journalCache.mtimeMs === stat.mtimeMs &&
		journalCache.size === stat.size
	)
		return {
			workflowId: scope.workflowId,
			entries: journalCache.entries,
			...(journalCache.present ? { flowPage: STAGE_FLOW_FILE } : {}),
		};
	const journal = readJournalFile(scope);
	journalCache = {
		path: stat.path,
		workflowId: stat.workflowId,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		entries: journal.entries,
		present: journal.present,
	};
	return {
		workflowId: scope.workflowId,
		entries: journal.entries,
		...(journal.present ? { flowPage: STAGE_FLOW_FILE } : {}),
	};
}

/** The journal file's identity, or `undefined` when the workflow has none. */
function journalStat(
	scope: WorkflowEvidenceScope,
):
	| { path: string; workflowId: string; mtimeMs: number; size: number }
	| undefined {
	let directory: number | undefined;
	try {
		directory = openJournalDirectory(scope);
	} catch {
		return undefined;
	}
	let fd: number | undefined;
	try {
		fd = openSecureFile(directory, STAGE_JOURNAL_FILE);
	} catch {
		closeSecureDirectory(directory);
		return undefined;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return undefined;
		return {
			// The file this read just opened — `<dataRoot>/evidence/<workflowId>/…` —
			// not `<dataRoot>/…`: every workflow of one worktree shares the data root,
			// and a cache keyed by that would answer another workflow's steps.
			path: path.join(scope.root, STAGE_JOURNAL_FILE),
			workflowId: scope.workflowId,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		};
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
		closeSecureDirectory(directory);
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
	// One read answers both the entries and whether a page exists: the file's own
	// presence is what the page is rendered from, so a second directory listing
	// cannot disagree with it.
	const journal = readJournalFile(scope);
	const matching = journal.entries.filter(
		(entry) =>
			(options.session === undefined || entry.session === options.session) &&
			(options.app === undefined || entry.app === options.app),
	);
	return {
		workflowId: scope.workflowId,
		entries: matching.slice(Math.max(0, matching.length - limit)),
		...(journal.present ? { flowPage: STAGE_FLOW_FILE } : {}),
	};
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Fold the control characters a free-form value may carry, so what is written is
 * what the journal's read contract accepts: a copied page excerpt is multi-line
 * by nature, and one newline would otherwise make the whole journal undecodable
 * in the dashboard. */
function journalText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are exactly what this folds.
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** The one path a written text takes: the caller's redactor, then the shape the
 * reader accepts. */
function cleanText(redact: JournalRedactor, value: string): string {
	return journalText(redact(value));
}

/** Redact one optional text, keeping `undefined` as absent. */
function redactText(
	redact: JournalRedactor,
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	const redacted = cleanText(redact, value);
	return redacted === "" ? undefined : redacted;
}

/** A URL is text too, and the journal's own contract bounds it at 2048: the
 * server derives it from the page, so the bound is applied here rather than
 * trusted from the caller. */
function cleanUrl(
	redact: JournalRedactor,
	value: string | undefined,
): string | undefined {
	const redacted = redactText(redact, value);
	return redacted === undefined
		? undefined
		: redacted.slice(0, MAX_JOURNAL_URL);
}

function redactCaptures(
	redact: JournalRedactor,
	captures: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (captures === undefined) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(captures))
		out[cleanText(redact, name)] = cleanText(redact, value);
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
	/** Called inside this append's own lock section, with the entries and the
	 * manifest it just parsed. The flow page is rendered from exactly these, so one
	 * step costs one journal read and one manifest read instead of two of each, and
	 * a page can never be written from a snapshot older than the step it shows. */
	afterWrite?: (snapshot: {
		readonly entries: readonly StageJournalEntry[];
		readonly manifest: EvidenceManifest;
	}) => void | Promise<void>,
): Promise<StageJournalEntry> {
	return await withEvidenceRootLock(scope.root, async () => {
		const journal = readJournalFile(scope);
		const existing = journal.entries;
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
				: { session: cleanText(redact, input.session) }),
			...(input.app === undefined ? {} : { app: cleanText(redact, input.app) }),
			...(input.role === undefined
				? {}
				: { role: cleanText(redact, input.role) }),
			...textField("url", cleanUrl(redact, input.url)),
			label: cleanText(redact, input.label),
			...textField("expected", redactText(redact, input.expected)),
			...textField("observed", redactText(redact, input.observed)),
			...(captures === undefined ? {} : { captures }),
			...(evidence === undefined ? {} : { evidence }),
			...(knowledge === undefined
				? {}
				: {
						knowledge: {
							concept: cleanText(redact, knowledge.concept),
							...(knowledge.section === undefined
								? {}
								: { section: cleanText(redact, knowledge.section) }),
							kind: knowledge.kind,
							...(knowledge.suspectedCause === undefined
								? {}
								: { suspectedCause: knowledge.suspectedCause }),
						},
					}),
			...(input.segment === undefined ? {} : { segment: input.segment }),
			...(input.offsetMs === undefined ? {} : { offsetMs: input.offsetMs }),
		};
		const line = lineOf(entry);
		const bytes = Buffer.byteLength(line, "utf8");
		// The file's own size, not a re-serialization of what parsed: a line the reader
		// skipped still occupies bytes, and the writer must refuse past exactly the
		// size the reader refuses to parse.
		if (journal.bytes + bytes > EVIDENCE_FILE_MAX_BYTES)
			throw new EvidenceError(
				"stage-journal-full",
				`the stage journal of ${scope.workflowId} is at its ${EVIDENCE_FILE_MAX_BYTES}-byte cap; no further step is recorded and nothing was discarded`,
				409,
			);
		appendLine(scope, line);
		await afterWrite?.({ entries: [...existing, entry], manifest });
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

/** One journal line, including the version marker and the terminating newline. */
function lineOf(entry: StageJournalEntry): string {
	return `${JSON.stringify({ v: JOURNAL_VERSION, ...entry })}\n`;
}

function appendLine(scope: WorkflowEvidenceScope, line: string): void {
	// A write is what makes a cached parse stale; nothing may serve it afterwards.
	journalCache = undefined;
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
	/** Called inside this rewrite's lock section with the entries it just wrote, so
	 * the page is rendered from them rather than from a second read. */
	afterWrite?: (snapshot: {
		readonly entries: readonly StageJournalEntry[];
	}) => void | Promise<void>,
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
		if (!writeJournal(scope, updated)) return 0;
		await afterWrite?.({ entries: updated });
		return changed;
	});
}

/**
 * Rewrite the whole journal, or refuse to.
 *
 * A rewrite is the one path that can push the file past the cap the reader
 * enforces, and the state it would leave behind is unreadable for every caller —
 * including the repair paths, which all read first. So it is refused here exactly
 * where an append is refused; a caller that gains nothing from the field it was
 * adding (a back-filled video id, which both the panel and the page take from the
 * manifest) treats the refusal as "nothing changed".
 *
 * Answers whether the file was written.
 */
function writeJournal(
	scope: WorkflowEvidenceScope,
	entries: readonly StageJournalEntry[],
): boolean {
	const text = entries.map(lineOf).join("");
	if (Buffer.byteLength(text, "utf8") > EVIDENCE_FILE_MAX_BYTES) return false;
	journalCache = undefined;
	const directory = openJournalDirectoryToWrite(scope);
	try {
		writeAtomicPrivateFile(directory, STAGE_JOURNAL_FILE, text, 0o600);
	} finally {
		closeSecureDirectory(directory);
	}
	return true;
}

/**
 * Drop one discarded segment's reference from its entries (`task 1.2`, spec "Flow
 * segments carry offsets"): when a recording is stopped without keeping it, the
 * steps written while it ran name a video nobody has. They keep their sequence
 * numbers and every other field; only `segment` and `offsetMs` go, so the flow
 * page has no section to link and the panel groups them as unreferenced.
 *
 * Answers how many entries changed; a segment with no step is untouched.
 */
export async function clearStageJournalSegment(
	scope: WorkflowEvidenceScope,
	input: { readonly segment: number; readonly session?: string },
	afterWrite?: (snapshot: {
		readonly entries: readonly StageJournalEntry[];
	}) => void | Promise<void>,
): Promise<number> {
	return await withEvidenceRootLock(scope.root, async () => {
		const entries = readStageJournal(scope);
		let changed = 0;
		const updated = entries.map((entry) => {
			if (entry.segment !== input.segment) return entry;
			if (input.session !== undefined && entry.session !== input.session)
				return entry;
			changed += 1;
			// Only the segment reference goes; a field a later format adds survives,
			// because the entry is filtered rather than rebuilt.
			return Object.fromEntries(
				Object.entries(entry).filter(
					([key]) => key !== "segment" && key !== "offsetMs",
				),
			) as StageJournalEntry;
		});
		if (changed === 0) return 0;
		if (!writeJournal(scope, updated)) return 0;
		await afterWrite?.({ entries: updated });
		return changed;
	});
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
 *
 * It takes the evidence root lock, like every other writer of that directory,
 * and re-checks the journal *inside* it: a render that interleaved with
 * `removeWorkflowEvidence` would otherwise recreate the directory chain of a
 * workflow whose evidence was just removed — the exact failure the lock exists to
 * prevent. The read-render-rename then happens in one lock section, so a slow
 * write can never land an older snapshot after a newer one.
 */
export async function writeStageFlowPage(
	scope: WorkflowEvidenceScope,
	redact: JournalRedactor = identityRedactor,
	/** What a caller already parsed, so a page is not rendered from a second read of
	 * the same journal and the same manifest. */
	preloaded: {
		readonly entries?: readonly StageJournalEntry[];
		readonly manifest?: EvidenceManifest;
	} = {},
): Promise<string | undefined> {
	return await withEvidenceRootLock(scope.root, async () =>
		writeStageFlowPageUnlocked(scope, redact, preloaded),
	);
}

/**
 * The page write itself, for a caller that already holds the evidence root lock —
 * `appendStageJournalEntry`'s own section, which is the whole point of the
 * `afterWrite` seam. Never acquires the lock: it is not re-entrant, so a nested
 * call would deadlock rather than serialize.
 */
export async function writeStageFlowPageUnlocked(
	scope: WorkflowEvidenceScope,
	redact: JournalRedactor = identityRedactor,
	preloaded: {
		readonly entries?: readonly StageJournalEntry[];
		readonly manifest?: EvidenceManifest;
	} = {},
): Promise<string | undefined> {
	let entries = preloaded.entries;
	if (entries === undefined) {
		const journal = readJournalFile(scope);
		if (!journal.present) return undefined;
		entries = journal.entries;
	}
	const manifest = preloaded.manifest ?? listEvidence(scope);
	const html = redact(renderStageFlowPage(scope.workflowId, entries, manifest));
	const directory = openJournalDirectoryToWrite(scope);
	try {
		writeAtomicPrivateFile(directory, STAGE_FLOW_FILE, html, 0o600);
	} finally {
		closeSecureDirectory(directory);
	}
	return STAGE_FLOW_FILE;
}
