// Browser snapshots (`add-agent-browser-sessions`,
// `improve-browser-agent-loop`).
//
// The canonical snapshot is Playwright's public AI form:
// `page.ariaSnapshot({ mode: "ai" })` (or the locator form for `within`). It
// returns `[ref=eN]` markers and iframe refs such as `[ref=f1e3]`, includes
// shadow-DOM and iframe content, and makes those refs actionable through
// `page.getByRef()` without touching the page. `capturePageSnapshot`,
// `captureLocatorSnapshot` and `boundSnapshotText` are the shared bounded read.
//
// The one-release legacy DOM walker was removed in the release after AI became
// the default (`improve-browser-agent-loop`, tasks 8.7/8.8): there is exactly
// one snapshot contract now, and nothing here injects attributes into a page.

import { BrowserPoolError } from "./errors.ts";

/** The default depth of an AI snapshot. */
export const SNAPSHOT_DEFAULT_DEPTH = 10;
/** The maximum depth the tree walks below `body`, and the absolute AI cap. */
export const SNAPSHOT_MAX_DEPTH = 14;
/** The default character cap for one snapshot result. */
export const SNAPSHOT_DEFAULT_CHARS = 20_000;
/** The absolute character cap for one snapshot result. */
export const SNAPSHOT_MAX_CHARS = 40_000;

/** What one snapshot read needs from the Playwright page or locator. A
 * structural type keeps this module free of a Playwright import: the driver
 * owns the real objects, and a test can pass a source that returns text. */
export interface AriaSnapshotSource {
	ariaSnapshot(options: {
		mode?: "ai" | "default";
		depth?: number;
		timeout?: number;
	}): Promise<string>;
}

/** One bounded AI snapshot read. `chars`/`maxChars` and `truncated` describe
 * the text actually returned, while `depth` is the cap the read used. */
export interface AriaSnapshotResult {
	readonly text: string;
	readonly chars: number;
	readonly truncated: boolean;
	readonly depth: number;
	readonly maxChars: number;
}

/** How many snapshot states one session keeps for `diff: true`. The current
 * state is the newest entry; the oldest is evicted when a fifth arrives. */
export const SNAPSHOT_HISTORY_CAPACITY = 4;

/** One parsed snapshot node. `ref` is absent for structural/text-only nodes;
 * only nodes with a ref are actionable. `depth` is the indentation of the line
 * in the snapshot, retained so a scoped read can be related to its parent. */
export interface SnapshotNode {
	readonly ref?: string;
	readonly role: string;
	readonly name?: string;
	readonly text?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly depth: number;
}

/** One node in an observation/diff. The shape is deliberately the same as the
 * find result: a model can use a returned ref without a second tree read. */
export interface SnapshotDeltaEntry {
	readonly ref?: string;
	readonly role: string;
	readonly name?: string;
	readonly text?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
}

/** A bounded change set between two snapshot states. The arrays hold at most
 * `SNAPSHOT_DELTA_CAP` entries each; `totals` always reports the full counts. */
export interface SnapshotDelta {
	readonly added: readonly SnapshotDeltaEntry[];
	readonly removed: readonly SnapshotDeltaEntry[];
	readonly changed: readonly SnapshotDeltaEntry[];
	readonly totals: {
		readonly added: number;
		readonly removed: number;
		readonly changed: number;
	};
	readonly truncated: boolean;
}

/** The most changed nodes one category of a structured delta carries. */
export const SNAPSHOT_DELTA_CAP = 50;
/** The most changed-node lines one observation text carries. */
export const SNAPSHOT_OBSERVATION_LINES = 20;
/** The most characters one observation text carries. */
export const SNAPSHOT_OBSERVATION_CHARS = 1_500;

const SNAPSHOT_LINE = /^(\s*)-\s+([A-Za-z][\w-]*)(.*)$/;
const SNAPSHOT_NAME = /^\s+"((?:[^"\\]|\\.)*)"/;
const SNAPSHOT_REF = /\[ref=((?:f\d+)*e\d+)\]/;
const SNAPSHOT_STATE_FLAGS = [
	"checked",
	"disabled",
	"expanded",
	"pressed",
	"selected",
] as const;

/** Parse the YAML-shaped AI snapshot into the compact node map used by diff,
 * find and action observations. The parser is intentionally narrow: it reads
 * the role, quoted name, ref, state flags and the text after a colon, which is
 * the public contract the Playwright fixture exercises. Raw text remains the
 * canonical output; this map is only a derived view. */
export function parseSnapshotNodes(text: string): SnapshotNode[] {
	const nodes: SnapshotNode[] = [];
	for (const line of text.split("\n")) {
		const match = SNAPSHOT_LINE.exec(line);
		if (!match) continue;
		const indent = match[1] ?? "";
		const role = match[2] ?? "generic";
		let rest = match[3] ?? "";
		const nameMatch = SNAPSHOT_NAME.exec(rest);
		const name = nameMatch?.[1];
		if (nameMatch) rest = rest.slice(nameMatch[0].length);
		const ref = SNAPSHOT_REF.exec(rest)?.[1];
		const flags = new Set<string>();
		for (const flag of SNAPSHOT_STATE_FLAGS)
			if (rest.includes(`[${flag}]`)) flags.add(flag);
		if (rest.includes(`[checked=false]`)) flags.delete("checked");
		// The text after the colon is the node's own value. A generic/text node
		// often carries no quoted name, so the value is its only readable handle.
		const colon = rest.indexOf(":");
		const body =
			colon >= 0
				? rest
						.slice(colon + 1)
						.replace(/^\s+/, "")
						.replace(/\s+$/, "")
				: "";
		const cleanedBody = body.replace(/\s*\[[^\]]+\]\s*/g, " ").trim();
		nodes.push({
			...(ref ? { ref } : {}),
			role,
			...(name === undefined || name === ""
				? {}
				: { name: unescapeName(name) }),
			...(cleanedBody === "" ? {} : { text: cleanedBody.slice(0, 500) }),
			...(flags.has("checked") ? { checked: true } : {}),
			...(flags.has("disabled") ? { disabled: true } : {}),
			depth: Math.floor(indent.length / 2),
		});
	}
	return nodes;
}

function unescapeName(value: string): string {
	return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function entryOf(node: SnapshotNode): SnapshotDeltaEntry {
	return {
		...(node.ref === undefined ? {} : { ref: node.ref }),
		role: node.role,
		...(node.name === undefined ? {} : { name: node.name }),
		...(node.text === undefined ? {} : { text: node.text }),
		...(node.checked === undefined ? {} : { checked: node.checked }),
		...(node.disabled === undefined ? {} : { disabled: node.disabled }),
	};
}

function sameNode(left: SnapshotNode, right: SnapshotNode): boolean {
	return (
		left.role === right.role &&
		(left.name ?? "") === (right.name ?? "") &&
		(left.text ?? "") === (right.text ?? "") &&
		(left.checked ?? false) === (right.checked ?? false) &&
		(left.disabled ?? false) === (right.disabled ?? false)
	);
}

/** Roles whose accessible name *is* their text. A re-render that only changes
 * the text can change the ref too, so exact role+name matching would report a
 * removal plus an addition instead of one changed node. */
const CONTENT_NAME_ROLES = new Set([
	"caption",
	"cell",
	"code",
	"columnheader",
	"heading",
	"label",
	"link",
	"listitem",
	"paragraph",
	"rowheader",
	"text",
]);

/** A deterministic diff by ref. A ref that disappears and a new ref with the
 * same role/name and value are treated as the same node (a re-render changed
 * only its handle); a changed value is reported under the new ref. */
export function diffSnapshotNodes(
	before: readonly SnapshotNode[],
	after: readonly SnapshotNode[],
): SnapshotDelta {
	const oldNodes = before.filter((node) => node.ref !== undefined);
	const newNodes = after.filter((node) => node.ref !== undefined);
	const oldByRef = new Map(oldNodes.map((node) => [node.ref as string, node]));
	const matchedOld = new Set<SnapshotNode>();
	const added: SnapshotDeltaEntry[] = [];
	const changed: SnapshotDeltaEntry[] = [];
	for (const node of newNodes) {
		const ref = node.ref as string;
		const sameRef = oldByRef.get(ref);
		if (sameRef) {
			matchedOld.add(sameRef);
			if (!sameNode(sameRef, node)) changed.push(entryOf(node));
			continue;
		}
		// Refs are not stable across every re-render. Match an otherwise identical
		// unmatched node by role + accessible name before calling this an addition.
		const fallback = oldNodes.find(
			(old) =>
				!matchedOld.has(old) &&
				old.role === node.role &&
				(old.name ?? "") === (node.name ?? ""),
		);
		if (fallback) {
			matchedOld.add(fallback);
			if (!sameNode(fallback, node)) changed.push(entryOf(node));
			continue;
		}
		// A text-bearing node's name is its value, so a value edit changes both
		// the name and (often) the ref. Match such a node by role alone and report
		// a change, rather than a removal plus an addition.
		const contentFallback = CONTENT_NAME_ROLES.has(node.role)
			? oldNodes.find((old) => !matchedOld.has(old) && old.role === node.role)
			: undefined;
		if (contentFallback) {
			matchedOld.add(contentFallback);
			changed.push(entryOf(node));
			continue;
		}
		added.push(entryOf(node));
	}
	const removed = oldNodes
		.filter((node) => !matchedOld.has(node))
		.map((node) => entryOf(node));
	return {
		added: added.slice(0, SNAPSHOT_DELTA_CAP),
		removed: removed.slice(0, SNAPSHOT_DELTA_CAP),
		changed: changed.slice(0, SNAPSHOT_DELTA_CAP),
		totals: {
			added: added.length,
			removed: removed.length,
			changed: changed.length,
		},
		truncated:
			added.length > SNAPSHOT_DELTA_CAP ||
			removed.length > SNAPSHOT_DELTA_CAP ||
			changed.length > SNAPSHOT_DELTA_CAP,
	};
}

/** One delta line, in the compact `+/-/~ role "name" [ref=eN]: text` form. */
export function formatDeltaEntry(
	entry: SnapshotDeltaEntry,
	marker: "+" | "-" | "~",
): string {
	const name = entry.name ? ` "${entry.name}"` : "";
	const ref = entry.ref ? ` [ref=${entry.ref}]` : "";
	const text = entry.text ? `: ${entry.text.slice(0, 160)}` : "";
	return `${marker} ${entry.role}${name}${ref}${text}`;
}

export interface SnapshotObservationInput {
	readonly url: string;
	readonly title?: string;
	readonly delta?: SnapshotDelta;
	readonly navigation?: boolean;
	readonly snapshotRequired?: boolean;
	/** True when the action was a selector action with no prior state to diff. */
	readonly noBaseline?: boolean;
}

/** The bounded text view of one action: URL/title, a changed summary and at
 * most 20 changed-node lines, capped at 1,500 characters. */
export function formatSnapshotObservation(
	input: SnapshotObservationInput,
): string {
	const lines: string[] = [`url: ${input.url}`];
	if (input.title !== undefined && input.title !== "")
		lines.push(`title: ${input.title}`);
	if (input.navigation) {
		lines.push("navigated to a new document");
		lines.push("take a browser_snapshot for the new refs");
		return boundObservation(lines);
	}
	if (input.noBaseline) {
		lines.push("no previous snapshot to diff");
		lines.push("take a browser_snapshot for the current refs");
		return boundObservation(lines);
	}
	const delta = input.delta;
	if (
		!delta ||
		delta.totals.added + delta.totals.removed + delta.totals.changed === 0
	) {
		lines.push("changed: none");
		if (input.snapshotRequired)
			lines.push("take a browser_snapshot for the current refs");
		return boundObservation(lines);
	}
	lines.push(
		`changed: +${delta.totals.added} -${delta.totals.removed} ~${delta.totals.changed}`,
	);
	const entries: string[] = [];
	for (const entry of delta.added) entries.push(formatDeltaEntry(entry, "+"));
	for (const entry of delta.removed) entries.push(formatDeltaEntry(entry, "-"));
	for (const entry of delta.changed) entries.push(formatDeltaEntry(entry, "~"));
	for (const line of entries.slice(0, SNAPSHOT_OBSERVATION_LINES))
		lines.push(line);
	if (entries.length > SNAPSHOT_OBSERVATION_LINES || delta.truncated)
		lines.push("delta truncated; take a browser_snapshot for the full state");
	if (input.snapshotRequired)
		lines.push("take a browser_snapshot for the current refs");
	return boundObservation(lines);
}

function boundObservation(lines: readonly string[]): string {
	let text = "";
	for (const line of lines) {
		const next = text === "" ? line : `${text}\n${line}`;
		if (next.length > SNAPSHOT_OBSERVATION_CHARS) {
			if (text === "") return line.slice(0, SNAPSHOT_OBSERVATION_CHARS);
			return `${text}\n…`;
		}
		text = next;
	}
	return text;
}

export interface SnapshotFindFilter {
	readonly query: string;
	readonly role?: string;
	readonly name?: string;
	readonly limit: number;
}

/** Search a parsed node map without returning the tree. The ref is part of a
 * result only when the node has one; text-only nodes are still findable. */
export function findSnapshotNodes(
	nodes: readonly SnapshotNode[],
	filter: SnapshotFindFilter,
): {
	readonly matches: readonly SnapshotNode[];
	readonly total: number;
	readonly truncated: boolean;
} {
	const query = filter.query.trim().toLowerCase();
	const role = filter.role?.trim().toLowerCase();
	const name = filter.name?.trim().toLowerCase();
	const matches = nodes.filter((node) => {
		if (role !== undefined && role !== "" && node.role.toLowerCase() !== role)
			return false;
		if (
			name !== undefined &&
			name !== "" &&
			!(node.name ?? "").toLowerCase().includes(name)
		)
			return false;
		if (query === "") return true;
		return (
			node.role.toLowerCase().includes(query) ||
			(node.name ?? "").toLowerCase().includes(query) ||
			(node.text ?? "").toLowerCase().includes(query)
		);
	});
	const limit = Math.max(1, Math.min(20, Math.trunc(filter.limit)));
	return {
		matches: matches.slice(0, limit),
		total: matches.length,
		truncated: matches.length > limit,
	};
}

export interface AriaSnapshotOptions {
	/** Defaults to `SNAPSHOT_DEFAULT_DEPTH` and is clamped to
	 * `SNAPSHOT_MAX_DEPTH`. */
	readonly depth?: number;
	/** Defaults to `SNAPSHOT_DEFAULT_CHARS` and is clamped to
	 * `SNAPSHOT_MAX_CHARS`. */
	readonly maxChars?: number;
	/** Playwright's own timeout for the snapshot call. The caller supplies the
	 * session's action budget so a stuck snapshot fails like a stuck action. */
	readonly timeoutMs?: number;
}

/** Clamp a caller-requested depth to the range the browser contract allows. */
export function boundedSnapshotDepth(depth: number | undefined): number {
	if (depth === undefined || !Number.isFinite(depth))
		return SNAPSHOT_DEFAULT_DEPTH;
	return Math.min(SNAPSHOT_MAX_DEPTH, Math.max(1, Math.trunc(depth)));
}

/** Clamp a caller-requested character cap to the range the browser contract
 * allows. */
export function boundedSnapshotChars(maxChars: number | undefined): number {
	if (maxChars === undefined || !Number.isFinite(maxChars))
		return SNAPSHOT_DEFAULT_CHARS;
	return Math.min(SNAPSHOT_MAX_CHARS, Math.max(1, Math.trunc(maxChars)));
}

/** Cut snapshot text at a line boundary so a truncated tree never ends in the
 * middle of a role/name/ref line. `chars` is the length of the returned text,
 * not the requested cap. */
export function boundSnapshotText(
	text: string,
	maxChars: number | undefined = SNAPSHOT_DEFAULT_CHARS,
): { text: string; chars: number; truncated: boolean; maxChars: number } {
	const cap = boundedSnapshotChars(maxChars);
	if (text.length <= cap)
		return { text, chars: text.length, truncated: false, maxChars: cap };
	const cut = text.slice(0, cap);
	const lineEnd = cut.lastIndexOf("\n");
	// A single line longer than the cap is still bounded; there is no earlier
	// line boundary to use, so the hard cut is the only safe answer.
	const bounded = lineEnd > 0 ? cut.slice(0, lineEnd) : cut;
	return {
		text: bounded,
		chars: bounded.length,
		truncated: true,
		maxChars: cap,
	};
}

/** Read the page's public AI snapshot through Playwright's page form. */
export async function capturePageSnapshot(
	page: AriaSnapshotSource,
	options: AriaSnapshotOptions = {},
): Promise<AriaSnapshotResult> {
	return captureAriaSnapshot(page, options);
}

/** Read a subtree through Playwright's locator form, which is how `within`
 * scopes a snapshot to a ref or selector. */
export async function captureLocatorSnapshot(
	locator: AriaSnapshotSource,
	options: AriaSnapshotOptions = {},
): Promise<AriaSnapshotResult> {
	return captureAriaSnapshot(locator, options);
}

async function captureAriaSnapshot(
	source: AriaSnapshotSource,
	options: AriaSnapshotOptions,
): Promise<AriaSnapshotResult> {
	// The public API is the contract. A runtime that lacks it fails explicitly
	// rather than producing a different ref grammar in the middle of one flow.
	if (typeof source.ariaSnapshot !== "function")
		throw new BrowserPoolError(
			"browser-snapshot-unsupported",
			"this browser runtime does not expose the public AI snapshot; upgrade playwright-core instead",
			501,
		);
	const depth = boundedSnapshotDepth(options.depth);
	const text = await source.ariaSnapshot({
		mode: "ai",
		depth,
		...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
	});
	const bounded = boundSnapshotText(text, options.maxChars);
	return { ...bounded, depth };
}

/** The ref grammar the public AI snapshot emits: an element ref (`e7`) and the
 * frame-prefixed form (`f1e3`). A nested prefix is accepted for forward
 * compatibility, even though current Playwright refs use one frame prefix. */
const SNAPSHOT_REF_PATTERN = /^(?:f\d+)*e\d+$/;
const SNAPSHOT_REF_MARKER = /\[ref=((?:f\d+)*e\d+)\]/g;

/** Every ref the text names, in order. The session uses this to accept only
 * refs a snapshot actually produced. */
export function snapshotRefs(text: string): string[] {
	// A Set, not `includes`, so the walk is linear in the refs found: the
	// snapshot is taken before every action.
	const refs = new Set<string>();
	for (const match of text.matchAll(SNAPSHOT_REF_MARKER)) {
		const ref = match[1];
		if (ref !== undefined) refs.add(ref);
	}
	return [...refs];
}

/** How many distinct refs one snapshot names. */
export function snapshotRefCount(text: string): number {
	return snapshotRefs(text).length;
}

/** Whether one string is a well-formed AI ref: `eN` or a frame-prefixed
 * `f1e3` (including a nested prefix for forward compatibility). */
export function isRef(value: string): boolean {
	return SNAPSHOT_REF_PATTERN.test(value);
}
