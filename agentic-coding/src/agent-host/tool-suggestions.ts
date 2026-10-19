// Self-correcting tool failures (efficiency backlog item 12). An `edit` call
// fails about one time in eight — "oldText not found", "not unique", "edits
// overlap" — and each failure costs the model a full turn plus a re-read to
// re-derive text it already had; nine of the 22 errors in one measured run were
// the same wrong-root path (a repository-root-relative path while the package
// lives one level down) answered by a bare ENOENT. This module derives a
// suggestion **locally**, from the file and the run's own environment, and
// appends it to the tool's own error text as a question ("did you mean …") —
// never as a silent substitution, because a nearest match can mislead.
//
// Three hints:
//   - a failed `edit` names the nearest whitespace-normalised region of the file
//     with 1-based line numbers, the line numbers a non-unique `oldText` occurs
//     at, or the edit indexes that overlap;
//   - a missing path suggests the nearest existing one — the same relative path
//     under an ancestor or a descendant directory of the working directory (the
//     wrong-root case), then the closest same-named file;
//   - a path that is a directory says so and lists its first entries.
//
// Everything here is bounded (`SuggestionLimits`) and the text logic is pure, so
// a suggestion can be unit-tested without a tool, a harness or a filesystem.
import fs from "node:fs";
import path from "node:path";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import {
	CodingTools,
	type createEditTool,
	type createReadTool,
} from "@earendil-works/pi-durable/tools";
import { toolSurfaceNote } from "./tool-surface.ts";

/** What one suggestion may cost: the excerpt it may render, and the filesystem
 * work it may do to find a path. Every one of these is a hard bound. */
export interface SuggestionLimits {
	/** Lines an excerpt renders in total, context included. */
	readonly maxLines: number;
	/** Characters the appended suggestion may occupy. */
	readonly maxChars: number;
	/** Context lines rendered around a matched region. */
	readonly contextLines: number;
	/** Longest `oldText`, in lines, still worth scanning the file for. */
	readonly maxWindowLines: number;
	/** Occurrences listed for a non-unique `oldText`. */
	readonly maxDuplicateLines: number;
	/** Directory entries one path search may read, across the whole walk. */
	readonly maxEntries: number;
	/** Directory levels below the working directory the walk descends. */
	readonly maxDepth: number;
	/** Entries listed for a path that is a directory. */
	readonly maxDirectoryEntries: number;
}

export const TOOL_SUGGESTION_LIMITS: SuggestionLimits = {
	maxLines: 20,
	maxChars: 2048,
	contextLines: 3,
	maxWindowLines: 200,
	maxDuplicateLines: 20,
	maxEntries: 400,
	maxDepth: 3,
	maxDirectoryEntries: 10,
};

/** Longest file line an excerpt renders; a minified bundle must not fill it. */
const MAX_SUGGESTION_LINE_CHARS = 200;

/** Directories a path search never descends into: they are large, they are
 * generated or vendored, and a suggestion inside one is never the file the
 * model meant. */
const SKIPPED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".cache",
	".herdr-workflow",
]);

/** Ends a bounded text block rather than cutting a line silently. */
function boundText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The suggestion is appended to the tool's own error text, which stays first,
 * and the original error stays the cause. */
function hintError(error: unknown, hint: string): Error {
	return new Error(`${errorText(error)}\n${hint}`, { cause: error });
}

// ---------------------------------------------------------------------------
// Text: the nearest region, the occurrences, the overlapping edits
// ---------------------------------------------------------------------------

/** One line as the matcher compares it: Unicode-normalised, whitespace runs
 * collapsed to one space, leading and trailing whitespace dropped. Two lines
 * that differ only in indentation or spacing therefore compare equal — which is
 * what an `edit` that "must match exactly including all whitespace" rejects. */
export function normalizeMatchLine(line: string): string {
	return line.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** `oldText` as the lines it will be compared against, with a trailing newline
 * not counting as an extra empty line. */
function needleLines(oldText: string): readonly string[] {
	const lines = oldText.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.map(normalizeMatchLine);
}

function normalizedContent(content: string): string {
	return content.split("\n").map(normalizeMatchLine).join("\n");
}

/** The 1-based line `offset` falls on in `text`. */
function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++)
		if (text[i] === "\n") line++;
	return line;
}

export interface MatchWindow {
	/** 1-based, inclusive. */
	readonly startLine: number;
	/** 1-based, inclusive. */
	readonly endLine: number;
	/** Lines of `oldText` whose normalised form is in the file. */
	readonly matchedLines: number;
	/** Lines `oldText` has. */
	readonly totalLines: number;
}

/**
 * The file region closest to `oldText`, compared line by line after whitespace
 * normalisation, or `undefined` when nothing is close enough to suggest. A
 * window is accepted when at least half of `oldText`'s non-empty lines are in
 * the file; the earliest window wins a tie, so the suggestion is deterministic.
 */
export function nearestMatchWindow(
	content: string,
	oldText: string,
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): MatchWindow | undefined {
	const target = needleLines(oldText);
	if (target.length === 0 || target.length > limits.maxWindowLines)
		return undefined;
	const file = content.split("\n").map(normalizeMatchLine);
	if (target.length > file.length) return undefined;
	let best: MatchWindow | undefined;
	let bestScore = 0;
	for (let start = 0; start + target.length <= file.length; start++) {
		let matched = 0;
		let differing = 0;
		for (let index = 0; index < target.length; index++) {
			const want = target[index];
			if (want === undefined || want === "") continue;
			if (file[start + index] === want) matched++;
			else differing++;
		}
		if (matched === 0 || matched < differing) continue;
		if (matched > bestScore) {
			bestScore = matched;
			best = {
				startLine: start + 1,
				endLine: start + target.length,
				matchedLines: matched,
				totalLines: target.length,
			};
		}
	}
	return best;
}

function lineLabel(startLine: number, endLine: number): string {
	return startLine === endLine
		? `line ${startLine}`
		: `lines ${startLine}-${endLine}`;
}

/** The excerpt of a matched region: its line numbers, the region itself and a
 * few lines of context around it, each reading as a file line. */
export function renderMatchWindow(
	content: string,
	window: MatchWindow,
	displayPath: string,
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): string {
	const lines = content.split("\n");
	const first = Math.max(1, window.startLine - limits.contextLines);
	const last = Math.min(lines.length, window.endLine + limits.contextLines);
	const width = String(last).length;
	const shown: string[] = [];
	for (
		let number = first;
		number <= last && shown.length < limits.maxLines;
		number++
	) {
		const inside = number >= window.startLine && number <= window.endLine;
		const raw = lines[number - 1] ?? "";
		const text =
			raw.length > MAX_SUGGESTION_LINE_CHARS
				? `${raw.slice(0, MAX_SUGGESTION_LINE_CHARS)}…`
				: raw;
		shown.push(
			`${inside ? ">" : " "} ${String(number).padStart(width, " ")} | ${text}`,
		);
	}
	const header = `did you mean ${lineLabel(window.startLine, window.endLine)} of ${displayPath} (nearest match, ${window.matchedLines}/${window.totalLines} lines equal ignoring whitespace)?`;
	return boundText([header, ...shown].join("\n"), limits.maxChars);
}

/** The first occurrence of `oldText` in `content`, after normalisation, as a
 * half-open character range in the normalised text plus the lines it spans. */
export interface MatchRange {
	readonly start: number;
	readonly end: number;
	readonly startLine: number;
	readonly endLine: number;
}

export function matchRange(
	content: string,
	oldText: string,
): MatchRange | undefined {
	const haystack = normalizedContent(content);
	const needle = needleLines(oldText).join("\n");
	if (needle === "") return undefined;
	const start = haystack.indexOf(needle);
	if (start === -1) return undefined;
	return {
		start,
		end: start + needle.length,
		startLine: lineAt(haystack, start),
		endLine: lineAt(haystack, start + needle.length - 1),
	};
}

/** The 1-based lines `oldText` occurs at, bounded — the answer to "the text
 * must be unique" when it is not. */
export function matchingLineNumbers(
	content: string,
	oldText: string,
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): readonly number[] {
	const haystack = normalizedContent(content);
	const needle = needleLines(oldText).join("\n");
	if (needle === "") return [];
	const numbers: number[] = [];
	let from = 0;
	while (numbers.length < limits.maxDuplicateLines) {
		const found = haystack.indexOf(needle, from);
		if (found === -1) break;
		numbers.push(lineAt(haystack, found));
		from = found + needle.length;
	}
	return numbers;
}

export interface OverlapPair {
	readonly first: number;
	readonly second: number;
	readonly firstLine: number;
	readonly firstEndLine: number;
	readonly secondLine: number;
	readonly secondEndLine: number;
}

/** The edit indexes whose matched regions overlap, derived locally so the
 * suggestion can name them even when the tool's own message does not. */
export function overlappingEditIndexes(
	content: string,
	edits: readonly ReplaceTextEdit[],
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): readonly OverlapPair[] {
	const ranges = edits.map((edit) => matchRange(content, edit.oldText));
	const pairs: OverlapPair[] = [];
	for (let first = 0; first < ranges.length; first++) {
		const a = ranges[first];
		if (a === undefined) continue;
		for (let second = first + 1; second < ranges.length; second++) {
			const b = ranges[second];
			if (b === undefined) continue;
			if (a.start < b.end && b.start < a.end)
				pairs.push({
					first,
					second,
					firstLine: a.startLine,
					firstEndLine: a.endLine,
					secondLine: b.startLine,
					secondEndLine: b.endLine,
				});
			if (pairs.length >= limits.maxDuplicateLines) return pairs;
		}
	}
	return pairs;
}

export interface ReplaceTextEdit {
	readonly oldText: string;
	readonly newText: string;
}

export function renderOverlapSuggestion(
	pairs: readonly OverlapPair[],
	displayPath: string,
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): string {
	if (pairs.length === 0)
		return `did you mean: merge the overlapping edits into one edit, or target lines that do not touch, in ${displayPath}.`;
	const named = pairs
		.map(
			(pair) =>
				`edits[${pair.first}] (${lineLabel(pair.firstLine, pair.firstEndLine)}) and edits[${pair.second}] (${lineLabel(pair.secondLine, pair.secondEndLine)})`,
		)
		.join("; ");
	return boundText(
		`did you mean: ${named} overlap in ${displayPath} — merge each pair into one edit, or target lines that do not touch.`,
		limits.maxChars,
	);
}

/** pi-durable's own three edit failures, recognised by their message: the
 * suggestion is derived from this module, but *which* kind of failure happened
 * is the tool's own word. */
const NOT_FOUND_PATTERN =
	/could not find (?:the exact text in|edits\[\d+\] in)/i;
const DUPLICATE_PATTERN = /occurrences of (?:the text in|edits\[\d+\] in)/i;
const OVERLAP_PATTERN = /edits\[\d+\] and edits\[\d+\] overlap in /i;

/** Whether a failed `edit` message is one of the three text failures this
 * module can say something about. Cheap, so the caller reads the file only when
 * it is. */
export function isTextEditFailure(message: string): boolean {
	return (
		NOT_FOUND_PATTERN.test(message) ||
		DUPLICATE_PATTERN.test(message) ||
		OVERLAP_PATTERN.test(message)
	);
}

/** The edit index the message names, or 0 — the only edit a single-edit call
 * has, and a safe default for a message that names none. */
function failingEditIndex(message: string, count: number): number {
	const match = /edits\[(\d+)\]/.exec(message);
	const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	return Number.isInteger(parsed) && parsed >= 0 && parsed < count ? parsed : 0;
}

export interface EditFailureInput {
	readonly message: string;
	/** The path as the model wrote it — what the model reads back. */
	readonly displayPath: string;
	readonly edits: readonly ReplaceTextEdit[];
	/** The file's text; absent when it could not be read. */
	readonly content?: string | undefined;
}

/**
 * The suggestion a failed `edit` appends, or `undefined` when this module has
 * nothing better to say than the tool's own message. Pure: the caller supplies
 * the file's text.
 */
export function editFailureHint(
	input: EditFailureInput,
	limits: SuggestionLimits = TOOL_SUGGESTION_LIMITS,
): string | undefined {
	const { message, displayPath, edits, content } = input;
	if (content === undefined) return undefined;
	if (OVERLAP_PATTERN.test(message)) {
		return renderOverlapSuggestion(
			overlappingEditIndexes(content, edits, limits),
			displayPath,
			limits,
		);
	}
	const oldText = edits[failingEditIndex(message, edits.length)]?.oldText;
	if (oldText === undefined) return undefined;
	if (DUPLICATE_PATTERN.test(message)) {
		const numbers = matchingLineNumbers(content, oldText, limits);
		if (numbers.length === 0)
			return boundText(
				`did you mean: this text occurs more than once in ${displayPath} — add the surrounding lines to make it unique.`,
				limits.maxChars,
			);
		const more =
			numbers.length >= limits.maxDuplicateLines ? " (and possibly more)" : "";
		const lines = numbers.map((number) => `line ${number}`).join(", ");
		return boundText(
			`did you mean one of these? that text occurs at ${lines} of ${displayPath}${more} — add surrounding context to make it unique.`,
			limits.maxChars,
		);
	}
	if (NOT_FOUND_PATTERN.test(message)) {
		const window = nearestMatchWindow(content, oldText, limits);
		if (window === undefined) return undefined;
		return renderMatchWindow(content, window, displayPath, limits);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Paths: the nearest existing one, or the entries of a directory
// ---------------------------------------------------------------------------

export type PathKind = "file" | "directory";

export interface DirectoryEntry {
	readonly name: string;
	readonly kind: string;
}

/** The filesystem a path suggestion reads. Structural, so a fake environment
 * and a run's real execution environment both satisfy it. */
export interface SuggestionFs {
	/** What the path is, or `undefined` when nothing is there. */
	kind(path: string): Promise<PathKind | undefined>;
	/** The directory's entries; an unreadable directory answers with none. */
	list(path: string): Promise<readonly DirectoryEntry[]>;
	/** The file's text, or `undefined` when it cannot be read. */
	readText(path: string): Promise<string | undefined>;
}

export interface SuggestionDeps {
	readonly cwd: string;
	readonly fs: SuggestionFs;
	readonly limits: SuggestionLimits;
	/** The path as the run's environment resolves it, so a suggestion names the
	 * path the tool would actually open. */
	resolve(requested: string): Promise<string>;
}

export interface SuggestionOptions {
	readonly limits?: Partial<SuggestionLimits>;
	/** Whether this run's tool set contains `codemode`, so the `read`
	 * description names it only where the host registered it (tool-surface.ts). */
	readonly codemodeRegistered?: boolean;
}

export interface PathCandidate {
	readonly path: string;
	readonly kind: PathKind;
}

/** Closest first: fewest segments, then shortest, then alphabetical, so the
 * suggestion is the file a reader would expect and never depends on the order a
 * directory happened to be listed in. */
export function rankPathCandidates(
	candidates: readonly PathCandidate[],
): readonly PathCandidate[] {
	const depth = (value: string): number => value.split(/[/\\]+/).length;
	return [...candidates].sort(
		(a, b) =>
			depth(a.path) - depth(b.path) ||
			a.path.length - b.path.length ||
			(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
	);
}

/** The path as a reader expects it: relative to the working directory whenever
 * that is the shorter form, absolute otherwise (a path outside the subtree is
 * clearer in full than as a chain of `..`). */
function displayPath(cwd: string, absolute: string): string {
	const relative = path.relative(cwd, absolute);
	if (relative === "") return ".";
	return relative.length <= absolute.length ? relative : absolute;
}

/** The directories above `cwd`, closest first. */
function ancestorDirectories(cwd: string, maxDepth: number): readonly string[] {
	const ancestors: string[] = [];
	let current = path.dirname(cwd);
	for (let depth = 0; depth < maxDepth; depth++) {
		if (current === cwd) break;
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return ancestors;
}

/** A bounded breadth-first walk of `cwd`'s own subtree: each directory with the
 * entries read from it, shallowest first, stopping at the entry cap. */
async function* walkDirectories(
	deps: SuggestionDeps,
): AsyncGenerator<{ directory: string; entries: readonly DirectoryEntry[] }> {
	const { fs: files, limits } = deps;
	let level = [deps.cwd];
	let depth = 0;
	let visited = 0;
	while (
		level.length > 0 &&
		depth < limits.maxDepth &&
		visited < limits.maxEntries
	) {
		const next: string[] = [];
		for (const directory of level) {
			if (visited >= limits.maxEntries) break;
			const entries = await files.list(directory);
			visited += entries.length;
			yield { directory, entries };
			for (const entry of entries) {
				if (entry.kind !== "directory") continue;
				if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
				if (next.length >= limits.maxEntries) continue;
				next.push(path.join(directory, entry.name));
			}
		}
		level = next;
		depth++;
	}
}

export interface PathSuggestion {
	/** The path as the model wrote it. */
	readonly requested: string;
	readonly kind: PathKind;
	/** The existing path, relative to the working directory when it is inside. */
	readonly path: string;
	/** The directory's entries, when the suggested path is a directory. */
	readonly entries?: readonly DirectoryEntry[];
}

interface PathSearchOptions {
	/** Read the entries of a directory that is itself the suggestion. */
	readonly withDirectoryEntries?: boolean;
}

async function directorySuggestion(
	absolute: string,
	requested: string,
	deps: SuggestionDeps,
	options: PathSearchOptions,
): Promise<PathSuggestion> {
	return {
		requested,
		kind: "directory",
		path: displayPath(deps.cwd, absolute),
		...(options.withDirectoryEntries === false
			? {}
			: { entries: await deps.fs.list(absolute) }),
	};
}

/**
 * The nearest existing path for a path that is not there: the same path under
 * each ancestor and each descendant directory of the working directory (the
 * wrong-root mistake), then the closest same-named file inside the subtree.
 * Bounded by {@link SuggestionLimits} — a search that reads no more than
 * `maxEntries` directory entries — and `undefined` when nothing is close.
 */
export async function nearestExistingPath(
	requested: string,
	deps: SuggestionDeps,
	options: PathSearchOptions = {},
): Promise<PathSuggestion | undefined> {
	const absolute = path.isAbsolute(requested)
		? requested
		: await deps.resolve(requested);
	const kind = await deps.fs.kind(absolute);
	if (kind === "directory")
		return directorySuggestion(absolute, requested, deps, options);
	if (kind === "file") return undefined;
	const relative = !path.isAbsolute(requested);
	if (relative)
		for (const ancestor of ancestorDirectories(
			deps.cwd,
			deps.limits.maxDepth,
		)) {
			const candidate = path.join(ancestor, requested);
			const found = await deps.fs.kind(candidate);
			if (found === "directory")
				return directorySuggestion(candidate, requested, deps, options);
			if (found === "file")
				return {
					requested,
					kind: "file",
					path: displayPath(deps.cwd, candidate),
				};
		}
	const basename = path.basename(requested);
	const named: PathCandidate[] = [];
	for await (const { directory, entries } of walkDirectories(deps)) {
		if (relative) {
			const candidate = path.join(directory, requested);
			const found = await deps.fs.kind(candidate);
			if (found === "directory")
				return directorySuggestion(candidate, requested, deps, options);
			if (found === "file")
				return {
					requested,
					kind: "file",
					path: displayPath(deps.cwd, candidate),
				};
		}
		for (const entry of entries)
			if (entry.kind !== "directory" && entry.name === basename)
				named.push({ path: path.join(directory, entry.name), kind: "file" });
	}
	const closest = rankPathCandidates(named)[0];
	if (closest === undefined) return undefined;
	return { requested, kind: "file", path: displayPath(deps.cwd, closest.path) };
}

export function renderPathSuggestion(
	suggestion: PathSuggestion,
	deps: SuggestionDeps,
): string {
	if (suggestion.kind === "directory") {
		const entries = suggestion.entries ?? [];
		if (entries.length === 0)
			return boundText(
				`did you mean a file inside ${suggestion.path}? that path is a directory and it is empty.`,
				deps.limits.maxChars,
			);
		const shown = entries
			.slice(0, deps.limits.maxDirectoryEntries)
			.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`);
		const more =
			entries.length > shown.length
				? ` (and ${entries.length - shown.length} more)`
				: "";
		return boundText(
			`did you mean a file inside ${suggestion.path}? that path is a directory; its first entries are ${shown.join(", ")}${more}.`,
			deps.limits.maxChars,
		);
	}
	const note =
		suggestion.path === suggestion.requested
			? ""
			: ` (${suggestion.requested} resolves from the run's working directory ${deps.cwd})`;
	return boundText(
		`did you mean ${suggestion.path}?${note}`,
		deps.limits.maxChars,
	);
}

/** Whether a failure message is plausibly about the path itself: this module
 * suggests a path only for those, so an unrelated failure is never answered
 * with a guess about a path that exists. */
const PATH_FAILURE_PATTERN =
	/enoent|no such file|eisdir|enotdir|is a directory|not a directory|is_directory|not_directory|not_found|path is not a file/i;

export function isPathFailure(message: string): boolean {
	return PATH_FAILURE_PATTERN.test(message);
}

/** The path hint for a failure that names a path, or `undefined` when the path
 * is fine and the failure was something else. */
export async function pathFailureHint(
	requested: string,
	deps: SuggestionDeps,
): Promise<string | undefined> {
	const suggestion = await nearestExistingPath(requested, deps);
	return suggestion === undefined
		? undefined
		: renderPathSuggestion(suggestion, deps);
}

/** The hint for a *missing* path on a surface where a directory is a legitimate
 * target (`grep`): a directory that is there is no failure at all, so only a
 * path that is not there produces text. */
export async function missingPathHint(
	requested: string,
	deps: SuggestionDeps,
): Promise<string | undefined> {
	const suggestion = await nearestExistingPath(requested, deps, {
		withDirectoryEntries: false,
	});
	if (suggestion === undefined || suggestion.kind === "directory")
		return undefined;
	return renderPathSuggestion(suggestion, deps);
}

// ---------------------------------------------------------------------------
// The run's environment, and the tools that use it
// ---------------------------------------------------------------------------

interface ResultLike<TValue> {
	readonly ok: boolean;
	readonly value?: TValue;
}

/** The parts of a run's execution environment the suggestions read, read
 * structurally so a test's fake environment and a real one both fit. */
interface ExecutionEnvLike {
	readonly cwd?: string;
	absolutePath?(path: string, context?: unknown): Promise<ResultLike<string>>;
	fileInfo?(
		path: string,
		context?: unknown,
	): Promise<ResultLike<{ kind?: string }>>;
	listDir?(
		path: string,
		context?: unknown,
	): Promise<ResultLike<readonly DirectoryEntry[]>>;
	readTextFile?(path: string, context?: unknown): Promise<ResultLike<string>>;
}

function nodeKind(target: string): PathKind | undefined {
	try {
		return fs.statSync(target).isDirectory() ? "directory" : "file";
	} catch {
		return undefined;
	}
}

/**
 * The suggestion dependencies of one tool call, read from the run's own
 * execution environment where it offers them — so a suggestion names paths and
 * text the tool would really have opened — and from this process's own
 * filesystem otherwise (the durable host runs its runs in this process, so the
 * two are the same namespace; a fake environment in a test simply gets no
 * suggestions rather than reaching for the real tree). Never throws: a
 * suggestion must not turn one tool failure into another.
 */
export function suggestionDeps(
	env: unknown,
	context: unknown,
	options: SuggestionOptions = {},
): SuggestionDeps {
	const target = (env ?? {}) as ExecutionEnvLike;
	const limits: SuggestionLimits = {
		...TOOL_SUGGESTION_LIMITS,
		...options.limits,
	};
	const cwd =
		typeof target.cwd === "string" && target.cwd.length > 0
			? target.cwd
			: process.cwd();
	const fileInfo =
		typeof target.fileInfo === "function"
			? target.fileInfo.bind(target)
			: undefined;
	const listDir =
		typeof target.listDir === "function"
			? target.listDir.bind(target)
			: undefined;
	const readTextFile =
		typeof target.readTextFile === "function"
			? target.readTextFile.bind(target)
			: undefined;
	const absolutePath =
		typeof target.absolutePath === "function"
			? target.absolutePath.bind(target)
			: undefined;
	const fsFacade: SuggestionFs = {
		async kind(value) {
			if (fileInfo === undefined) return nodeKind(value);
			try {
				const info = await fileInfo(value, context);
				if (!info.ok) return undefined;
				return info.value?.kind === "directory" ? "directory" : "file";
			} catch {
				return undefined;
			}
		},
		async list(value) {
			if (listDir === undefined) {
				try {
					return fs
						.readdirSync(value, { withFileTypes: true })
						.map((entry) => ({
							name: entry.name,
							kind: entry.isDirectory() ? "directory" : "file",
						}));
				} catch {
					return [];
				}
			}
			try {
				const listed = await listDir(value, context);
				return listed.ok ? (listed.value ?? []) : [];
			} catch {
				return [];
			}
		},
		async readText(value) {
			if (readTextFile === undefined) {
				try {
					return fs.readFileSync(value, "utf8");
				} catch {
					return undefined;
				}
			}
			try {
				const read = await readTextFile(value, context);
				return read.ok ? read.value : undefined;
			} catch {
				return undefined;
			}
		},
	};
	return {
		cwd,
		fs: fsFacade,
		limits,
		async resolve(requested) {
			if (absolutePath !== undefined) {
				try {
					const resolved = await absolutePath(requested, context);
					if (resolved.ok && typeof resolved.value === "string")
						return resolved.value;
				} catch {
					/* fall back to this process's own resolution */
				}
			}
			return path.resolve(cwd, requested);
		},
	};
}

/** pi-durable's `edit` registration, the shape this module wraps. */
export type EditTool = ReturnType<typeof createEditTool>;
/** pi-durable's `read` registration. */
export type ReadTool = ReturnType<typeof createReadTool>;
type EditArgs = Parameters<EditTool["execute"]>[0];
type EditApi = Parameters<EditTool["execute"]>[1];
type ReadArgs = Parameters<ReadTool["execute"]>[0];
type ReadApi = Parameters<ReadTool["execute"]>[1];

/** The suggestion an `edit` failure appends: the tool's own message decides
 * which kind of failure it was, and everything the suggestion names is read
 * from the file and the run's environment here, never from the model. */
async function editCallHint(input: {
	readonly args: EditArgs;
	readonly api: EditApi;
	readonly context: unknown;
	readonly error: unknown;
	readonly options: SuggestionOptions;
}): Promise<string | undefined> {
	const message = errorText(input.error);
	const deps = suggestionDeps(input.api?.env, input.context, input.options);
	if (isPathFailure(message)) return pathFailureHint(input.args.path, deps);
	if (!isTextEditFailure(message)) return undefined;
	const edits = Array.isArray(input.args.edits)
		? input.args.edits
		: ([] as readonly ReplaceTextEdit[]);
	if (edits.length === 0) return undefined;
	const content = await deps.fs.readText(await deps.resolve(input.args.path));
	return editFailureHint(
		{ message, displayPath: input.args.path, edits, content },
		deps.limits,
	);
}

/**
 * pi-durable's `edit` tool with a locally derived suggestion appended to a
 * failure's message. The execution, the error text, the failure kind and the
 * result shape stay exactly pi-durable's; only a failure this module can say
 * something about gains a line.
 */
export function createSuggestingEditTool(
	base: EditTool,
	options: SuggestionOptions = {},
): EditTool {
	return {
		...base,
		async execute(args, api, context) {
			try {
				return await base.execute(args, api, context);
			} catch (error) {
				const hint = await editCallHint({ args, api, context, error, options });
				if (hint === undefined) throw error;
				throw hintError(error, hint);
			}
		},
	};
}

/**
 * pi-durable's `read` tool with the same treatment for a path that is not there
 * (or is a directory): the error text stays first and the suggestion follows.
 */
export function createSuggestingReadTool(
	base: ReadTool,
	options: SuggestionOptions = {},
): ReadTool {
	return {
		...base,
		// The description states the inspection split where the tool is chosen,
		// not only in the protocol document (efficiency backlog item 14): every
		// existing contract of pi-durable's own description is kept, and the note
		// is appended after it.
		description: [base.description, toolSurfaceNote(options)]
			.filter((part) => typeof part === "string" && part.length > 0)
			.join(" "),
		async execute(args: ReadArgs, api: ReadApi, context) {
			try {
				return await base.execute(args, api, context);
			} catch (error) {
				const message = errorText(error);
				if (!isPathFailure(message)) throw error;
				const deps = suggestionDeps(api?.env, context, options);
				const hint = await pathFailureHint(args.path, deps);
				if (hint === undefined) throw error;
				throw hintError(error, hint);
			}
		},
	};
}

/**
 * pi-durable's `read` and `edit` with the suggestions above, installed by the
 * host next to `boundedCodingTools()`. Tool *selection* is by name, and the
 * host installs this registration after the coding tools, so the composed tool
 * of each of those names is the suggesting one wherever a run selects it.
 */
export function suggestingCodingTools(
	options: SuggestionOptions = {},
): Extension {
	const tools = (CodingTools.tools ?? [])
		.filter((tool) => tool.name === "read" || tool.name === "edit")
		.map((tool) =>
			tool.name === "edit"
				? createSuggestingEditTool(tool as EditTool, options)
				: createSuggestingReadTool(tool as ReadTool, options),
		);
	return defineExtension({ name: "coding-tool-suggestions", tools });
}
