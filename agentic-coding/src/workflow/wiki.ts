import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./effects.ts";

export type WikiFrontmatter = Record<string, unknown>;
export interface WikiDocument {
	id?: string;
	path?: string;
	frontmatter: WikiFrontmatter;
	body: string;
}
export interface WikiSource {
	resource: string;
	[key: string]: unknown;
}
export interface WikiWriteInput extends WikiFrontmatter {
	body?: string;
	changeId?: string;
	generatedBy?: string;
}
export interface WikiConcept extends WikiDocument {
	id: string;
	path: string;
	status: string;
	trust: TrustTier;
	stale: boolean;
	/** 1-based body lines without an inline source citation. */
	uncitedLines: number[];
	/** Inline citation ids with no matching declared source. */
	unknownCitations: string[];
}
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export interface WikiSearchHit {
	id: string;
	title: string;
	tags: string[];
	status: string;
	trust: TrustTier;
	stale: boolean;
	/** Number of body prose lines without an inline source citation. */
	uncited: number;
	snippet: string;
	score: number;
}

/** A temporary, line-anchored review comment from the home Wiki view. */
export interface WikiReviewComment {
	conceptId: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
}

export function validateWikiReviewComments(
	comments: readonly WikiReviewComment[],
): WikiReviewComment[] {
	if (!comments.length || comments.length > 100)
		throw new Error("wiki review requires between 1 and 100 comments");
	const normalized = comments.map((comment, index) => {
		const conceptId = comment.conceptId?.replaceAll("\\", "/").trim();
		if (
			!conceptId ||
			path.isAbsolute(conceptId) ||
			conceptId.split("/").includes("..")
		)
			throw new Error(`wiki comment ${index} requires a safe concept`);
		if (RESERVED.has(path.posix.basename(`${conceptId}.md`)))
			throw new Error(`wiki comment ${index} targets a reserved file`);
		if (!Number.isInteger(comment.line) || comment.line < 1)
			throw new Error(`wiki comment ${index} requires a 1-based line`);
		if (!comment.body?.trim() || comment.body.length > 4096)
			throw new Error(`wiki comment ${index} requires a bounded body`);
		if (
			(comment.startLine !== undefined &&
				(!Number.isInteger(comment.startLine) || comment.startLine < 1)) ||
			(comment.endLine !== undefined &&
				(!Number.isInteger(comment.endLine) || comment.endLine < 1)) ||
			(comment.startLine !== undefined &&
				comment.endLine !== undefined &&
				comment.startLine > comment.endLine)
		)
			throw new Error(`wiki comment ${index} has an invalid line range`);
		return {
			conceptId,
			line: comment.line,
			...(comment.startLine === undefined
				? {}
				: { startLine: comment.startLine }),
			...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
			body: comment.body.trim(),
		};
	});
	// The assignment includes this context twice (dedicated and generic input).
	// Keep both copies plus pinned instructions below renderAssignment's 96 KiB
	// hard limit.
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 40 * 1024)
		throw new Error("wiki review comments exceed the 40 KiB input bound");
	return normalized;
}

export type WikiTreeNode = {
	kind: "directory" | "concept";
	id: string;
	label: string;
	depth: number;
	children: WikiTreeNode[];
};

/** Build a deterministic tree without reading note bodies. */
export function buildWikiTree(
	concepts: readonly Pick<WikiConcept, "id">[],
): WikiTreeNode[] {
	const root: WikiTreeNode[] = [];
	const directories = new Map<string, WikiTreeNode>();
	for (const concept of concepts) {
		const id = concept.id.replaceAll("\\", "/").replace(/\.md$/, "");
		if (!id || RESERVED.has(`${id}.md`)) continue;
		const parts = id.split("/").filter(Boolean);
		if (!parts.length || RESERVED.has(`${parts[parts.length - 1]}.md`))
			continue;
		let siblings = root;
		let prefix = "";
		for (const [index, part] of parts.entries()) {
			prefix = prefix ? `${prefix}/${part}` : part;
			const leaf = index === parts.length - 1;
			if (leaf) {
				siblings.push({
					kind: "concept",
					id,
					label: `${part}.md`,
					depth: index,
					children: [],
				});
				continue;
			}
			let directory = directories.get(prefix);
			if (!directory) {
				directory = {
					kind: "directory",
					id: prefix,
					label: part,
					depth: index,
					children: [],
				};
				directories.set(prefix, directory);
				siblings.push(directory);
			}
			siblings = directory.children;
		}
	}
	const sort = (nodes: WikiTreeNode[]): void => {
		nodes.sort(
			(a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind),
		);
		for (const node of nodes) sort(node.children);
	};
	sort(root);
	return root;
}

export function flattenWikiTree(
	nodes: readonly WikiTreeNode[],
	expanded: ReadonlySet<string> = new Set(),
): WikiTreeNode[] {
	return nodes.flatMap((node) => [
		node,
		...(node.kind === "directory" && expanded.has(node.id)
			? flattenWikiTree(node.children, expanded)
			: []),
	]);
}

const RESERVED = new Set(["index.md", "log.md"]);

/** Digest the bundle contents while excluding the operational workflow area and
 * optionally the concepts that the current review is allowed to edit. */
export function wikiBundleFingerprint(
	root = wikiRoot(),
	excludedConcepts: ReadonlySet<string> = new Set(),
): string {
	const base = path.resolve(root);
	const hash = createHash("sha256");
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".herdr-workflow") continue;
			const file = path.join(directory, entry.name);
			const relative = path.relative(base, file).split(path.sep).join("/");
			const conceptId = relative.replace(/\.md$/, "");
			if (excludedConcepts.has(conceptId)) continue;
			if (entry.isDirectory()) walk(file);
			else if (entry.isSymbolicLink())
				hash.update(`link:${relative}:${fs.readlinkSync(file)}\\0`);
			else if (entry.isFile()) {
				const content = fs.readFileSync(file);
				hash.update(`file:${relative}:${content.length}:`);
				hash.update(content);
				hash.update("\\0");
			}
		}
	};
	walk(base);
	return hash.digest("hex");
}
export function wikiConceptFingerprint(
	concept: string,
	root = wikiRoot(),
): string | undefined {
	const file = path.join(
		path.resolve(root),
		`${concept.replaceAll("/", path.sep)}.md`,
	);
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}
const ACTOR =
	/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|human:[^\s/]+|process:[^\s/]+)$/;
const STATUS = new Set(["draft", "stable", "deprecated"]);
const CHANGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const TOMBSTONE = "<!-- okf tombstone: concept did not exist -->\n";

/** A concept that has not been refreshed for this long is treated as outdated. */
export const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Inline citation marker `[^source-id]`; the id matches a declared source. */
const CITATION = /\[\^([A-Za-z0-9][A-Za-z0-9._-]*)\]/g;
const FENCE = /^\s{0,3}(?:```|~~~)/;
const ATX_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^\s{0,3}>/;

/** A table delimiter row such as `| :--- | ---: |`, decided by splitting cells
 * instead of a backtracking-prone regex over untrusted body lines. */
function isTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return false;
	const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
	return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/** Coverage of a concept body's inline citations. `uncitedLines` are 1-based
 * body line numbers for prose lines that carry no `[^id]` marker. */
export interface WikiCitationReport {
	cited: number;
	total: number;
	uncitedLines: number[];
	citedIds: string[];
}

/** Markdown structure that is not a citable statement. */
function isStructuralLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return true;
	if (
		ATX_HEADING.test(line) ||
		SETEXT_UNDERLINE.test(line) ||
		THEMATIC_BREAK.test(line) ||
		BLOCKQUOTE.test(line)
	)
		return true;
	return isTableSeparator(line);
}

/** Extract inline `[^id]` citations and report which prose lines lack one. */
export function citationReport(body: string): WikiCitationReport {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const exempt = new Array<boolean>(lines.length).fill(false);
	let inFence = false;
	for (const [index, line] of lines.entries()) {
		if (FENCE.test(line)) {
			exempt[index] = true;
			inFence = !inFence;
			continue;
		}
		if (inFence || isStructuralLine(line)) exempt[index] = true;
	}
	// A setext heading is the text line directly above its underline.
	for (let index = 1; index < lines.length; index++)
		if (SETEXT_UNDERLINE.test(lines[index] ?? "")) exempt[index - 1] = true;
	const uncitedLines: number[] = [];
	const citedIds: string[] = [];
	let total = 0;
	for (const [index, line] of lines.entries()) {
		if (exempt[index]) continue;
		total += 1;
		const ids = [...line.matchAll(CITATION)].flatMap((match) =>
			match[1] ? [match[1]] : [],
		);
		if (ids.length) citedIds.push(...ids);
		else uncitedLines.push(index + 1);
	}
	return {
		cited: total - uncitedLines.length,
		total,
		uncitedLines,
		citedIds,
	};
}

function declaredSourceIds(frontmatter: WikiFrontmatter): Set<string> {
	const values = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
	const ids = new Set<string>();
	for (const item of values) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const id = (item as Record<string, unknown>).id;
		if (typeof id === "string" && id.trim()) ids.add(id.trim());
	}
	return ids;
}

/** The freshness horizon for a write: `stale_after`, or the last update plus
 * the two-week window when the field is absent. */
export function defaultStaleAfter(now = new Date()): string {
	return new Date(now.getTime() + STALE_AFTER_DAYS * DAY_MS).toISOString();
}

function isHttpUrl(value: unknown): value is string {
	return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** Stamp every URL source with the instant it was asserted/accessed. */
function stampSourceAccess(sources: unknown, at: string): unknown[] {
	return (Array.isArray(sources) ? sources : []).map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const source = item as Record<string, unknown>;
		return isHttpUrl(source.resource) ? { ...source, accessed: at } : source;
	});
}

/** Enforce that a written concept carries identifiable sources and cites every
 * prose line. */
export function assertCitations(
	frontmatter: WikiFrontmatter,
	body: string,
): void {
	const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
	if (!sources.length) throw new Error("write requires at least one source");
	for (const [index, item] of sources.entries()) {
		const id =
			item && typeof item === "object" && !Array.isArray(item)
				? (item as Record<string, unknown>).id
				: undefined;
		if (typeof id !== "string" || !id.trim())
			throw new Error(`sources[${index}] requires an id`);
	}
	const declared = declaredSourceIds(frontmatter);
	const report = citationReport(body);
	const unknown = [
		...new Set(report.citedIds.filter((id) => !declared.has(id))),
	];
	if (unknown.length)
		throw new Error(`citation has no matching source: ${unknown.join(", ")}`);
	if (report.uncitedLines.length)
		throw new Error(
			`body line ${report.uncitedLines.slice(0, 5).join(", ")} requires a source citation`,
		);
}

function freshness(frontmatter: WikiFrontmatter): number | undefined {
	const candidates: number[] = [];
	const generated = frontmatter.generated;
	if (generated && typeof generated === "object" && !Array.isArray(generated)) {
		const at = (generated as Record<string, unknown>).at;
		if (typeof at === "string" && !Number.isNaN(Date.parse(at)))
			candidates.push(Date.parse(at));
	}
	for (const list of [frontmatter.verified, frontmatter.sources]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const value =
				(item as Record<string, unknown>).at ??
				(item as Record<string, unknown>).accessed;
			if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
				candidates.push(Date.parse(value));
		}
	}
	return candidates.length ? Math.max(...candidates) : undefined;
}

function expand(value: string): string {
	return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Resolve the shared wiki root without requiring a repository or workflow. */
export function wikiRoot(ignoreEnvironment = false): string {
	const configured = ignoreEnvironment
		? loadConfig().wiki?.root
		: process.env.HERDR_WIKI_DIR || loadConfig().wiki?.root;
	return path.resolve(expand(configured || "~/.config/agentic-coding/wiki"));
}

export function ensureBundle(root = wikiRoot()): string {
	fs.mkdirSync(root, { recursive: true });
	const index = path.join(root, "index.md");
	if (!fs.existsSync(index))
		fs.writeFileSync(index, '---\nokf_version: "0.2"\n---\n\n', {
			mode: 0o600,
		});
	return root;
}

/** Resolve a concept id to a path while preventing bundle escapes. */
export function conceptPath(rel: string, root = wikiRoot()): string {
	if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
		throw new Error("concept path must stay inside the wiki bundle");
	const normalized = rel.replaceAll("\\", "/");
	const withExtension = normalized.endsWith(".md")
		? normalized
		: `${normalized}.md`;
	if (RESERVED.has(path.posix.basename(withExtension)))
		throw new Error(`${path.posix.basename(withExtension)} is reserved`);
	const resolvedRoot = path.resolve(ensureBundle(root));
	const resolved = path.resolve(resolvedRoot, ...withExtension.split("/"));
	if (
		resolved !== resolvedRoot &&
		!resolved.startsWith(`${resolvedRoot}${path.sep}`)
	)
		throw new Error("concept path must stay inside the wiki bundle");
	let current = resolvedRoot;
	for (const part of withExtension.split("/")) {
		current = path.join(current, part);
		try {
			if (fs.lstatSync(current).isSymbolicLink())
				throw new Error("symbolic links are not allowed in wiki paths");
		} catch (error) {
			if (error instanceof Error && error.message.includes("symbolic links"))
				throw error;
		}
	}
	return resolved;
}

export function parseDocument(text: string): WikiDocument {
	const match = text.match(
		/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)$/m,
	);
	if (!match) throw new Error("document has no YAML frontmatter");
	let frontmatter: unknown;
	try {
		frontmatter = Bun.YAML.parse(match[1] ?? "");
	} catch (error) {
		throw new Error(`invalid YAML frontmatter: ${String(error)}`);
	}
	if (
		!frontmatter ||
		typeof frontmatter !== "object" ||
		Array.isArray(frontmatter)
	)
		throw new Error("frontmatter must be a mapping");
	return { frontmatter: frontmatter as WikiFrontmatter, body: match[2] ?? "" };
}

function scalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(String(value));
}
function inlineMap(value: Record<string, unknown>): string {
	return `{ ${Object.entries(value)
		.map(([key, item]) => `${key}: ${scalar(item)}`)
		.join(", ")} }`;
}
function renderValue(
	lines: string[],
	key: string,
	value: unknown,
	indent = "",
): void {
	if (Array.isArray(value)) {
		if (!value.length) {
			lines.push(`${indent}${key}: []`);
			return;
		}
		lines.push(`${indent}${key}:`);
		for (const item of value) {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const entries = Object.entries(item);
				if (!entries.length) lines.push(`${indent}  - {}`);
				else {
					const [firstKey, firstValue] = entries[0] ?? ["", null];
					if (firstValue && typeof firstValue === "object") {
						lines.push(`${indent}  -`);
						renderValue(lines, firstKey, firstValue, `${indent}    `);
					} else {
						lines.push(`${indent}  - ${firstKey}: ${scalar(firstValue)}`);
						for (const [child, childValue] of entries.slice(1))
							renderValue(lines, child, childValue, `${indent}    `);
					}
				}
			} else lines.push(`${indent}  - ${scalar(item)}`);
		}
		return;
	}
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		if (
			Object.values(object).every(
				(item) => item === null || typeof item !== "object",
			)
		)
			lines.push(`${indent}${key}: ${inlineMap(object)}`);
		else {
			lines.push(`${indent}${key}:`);
			for (const [child, childValue] of Object.entries(object))
				renderValue(lines, child, childValue, `${indent}  `);
		}
		return;
	}
	lines.push(`${indent}${key}: ${scalar(value)}`);
}

/** Render the producer's known shapes in diff-friendly block style. */
export function renderDocument(
	frontmatter: WikiFrontmatter,
	body: string,
): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter))
		if (value !== undefined) renderValue(lines, key, value);
	lines.push("---", body.replace(/^\n+/, ""));
	return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

export function checkConformance(doc: WikiDocument): boolean {
	try {
		return (
			typeof doc.frontmatter.type === "string" &&
			Boolean(doc.frontmatter.type.trim())
		);
	} catch {
		return false;
	}
}

function iso(value: unknown, field: string): void {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ||
		Number.isNaN(Date.parse(value))
	)
		throw new Error(
			`${field} must be an ISO 8601 timestamp with an explicit UTC offset`,
		);
}
function actor(value: unknown, field: string): void {
	if (typeof value !== "string" || !ACTOR.test(value))
		throw new Error(`${field} has an invalid actor`);
}

export function validateProducerFields(input: WikiWriteInput): void {
	for (const field of ["type", "title", "description"])
		if (typeof input[field] !== "string" || !String(input[field]).trim())
			throw new Error(`${field} is required`);
	if (
		input.status !== undefined &&
		(typeof input.status !== "string" || !STATUS.has(input.status))
	)
		throw new Error("status must be draft, stable, or deprecated");
	for (const field of ["stale_after"])
		if (input[field] !== undefined) iso(input[field], field);
	for (const field of ["generated"]) {
		if (input[field] === undefined) continue;
		if (
			!input[field] ||
			typeof input[field] !== "object" ||
			Array.isArray(input[field])
		)
			throw new Error(`${field} must be a mapping`);
		const value = input[field] as Record<string, unknown>;
		actor(value.by, `${field}.by`);
		if (value.at !== undefined) iso(value.at, `${field}.at`);
	}
	if (input.generatedBy !== undefined) actor(input.generatedBy, "generatedBy");
	if (input.verified !== undefined) {
		const values = Array.isArray(input.verified)
			? input.verified
			: [input.verified];
		for (const [index, item] of values.entries()) {
			if (!item || typeof item !== "object" || Array.isArray(item))
				throw new Error(`verified[${index}] must be a mapping`);
			const value = item as Record<string, unknown>;
			actor(value.by, `verified[${index}].by`);
			if (value.at !== undefined) iso(value.at, `verified[${index}].at`);
		}
	}
	if (input.sources !== undefined) {
		if (!Array.isArray(input.sources))
			throw new Error("sources must be a list");
		for (const [index, item] of input.sources.entries()) {
			const source =
				item && typeof item === "object" && !Array.isArray(item)
					? (item as Record<string, unknown>)
					: undefined;
			if (
				!source ||
				typeof source.resource !== "string" ||
				!source.resource.trim()
			)
				throw new Error(`sources[${index}] requires resource`);
		}
	}
}

function frontmatterOf(doc: WikiDocument | WikiFrontmatter): WikiFrontmatter {
	const candidate = doc as WikiDocument;
	return candidate.frontmatter && typeof candidate.frontmatter === "object"
		? candidate.frontmatter
		: (doc as WikiFrontmatter);
}
export function trustTier(doc: WikiDocument | WikiFrontmatter): TrustTier {
	const frontmatter = frontmatterOf(doc);
	if (frontmatter.verified === undefined) return "unverified";
	const values: unknown[] = Array.isArray(frontmatter.verified)
		? frontmatter.verified
		: [frontmatter.verified];
	return values.some(
		(item: unknown) =>
			item &&
			typeof item === "object" &&
			String((item as Record<string, unknown>).by ?? "").startsWith("human:"),
	)
		? "human-reviewed"
		: "machine-confirmed";
}
export function effectiveStatus(doc: WikiDocument | WikiFrontmatter): string {
	const frontmatter = frontmatterOf(doc);
	return typeof frontmatter.status === "string" && frontmatter.status
		? frontmatter.status
		: "stable";
}
export function isStale(
	doc: WikiDocument | WikiFrontmatter,
	now = new Date(),
): boolean {
	const frontmatter = frontmatterOf(doc);
	const explicit =
		typeof frontmatter.stale_after === "string" &&
		!Number.isNaN(Date.parse(frontmatter.stale_after))
			? Date.parse(frontmatter.stale_after)
			: undefined;
	if (explicit !== undefined) return now.getTime() >= explicit;
	// A concept with no explicit horizon is outdated once its last update or
	// source access is older than the two-week window.
	const baseline = freshness(frontmatter);
	return (
		baseline !== undefined &&
		now.getTime() >= baseline + STALE_AFTER_DAYS * DAY_MS
	);
}

function readPath(file: string, root = wikiRoot()): WikiConcept | undefined {
	try {
		const document = parseDocument(fs.readFileSync(file, "utf8"));
		if (!checkConformance(document)) return undefined;
		const id = path
			.relative(ensureBundle(root), file)
			.split(path.sep)
			.join("/")
			.replace(/\.md$/, "");
		const report = citationReport(document.body);
		const declared = declaredSourceIds(document.frontmatter);
		return {
			...document,
			id,
			path: file,
			status: effectiveStatus(document),
			trust: trustTier(document),
			stale: isStale(document),
			uncitedLines: report.uncitedLines,
			unknownCitations: [
				...new Set(report.citedIds.filter((cited) => !declared.has(cited))),
			],
		};
	} catch {
		return undefined;
	}
}
function conceptFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const output: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) output.push(...conceptFiles(file));
		else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!RESERVED.has(entry.name)
		)
			output.push(file);
	}
	return output;
}

export function listConcepts(
	filters: { tag?: string; type?: string } = {},
	root = wikiRoot(),
): WikiConcept[] {
	const concepts = conceptFiles(ensureBundle(root)).flatMap((file) => {
		const concept = readPath(file, root);
		return concept ? [concept] : [];
	});
	return concepts
		.filter((concept) => {
			const tags = Array.isArray(concept.frontmatter.tags)
				? concept.frontmatter.tags.map(String)
				: [];
			return (
				(!filters.tag || tags.includes(filters.tag)) &&
				(!filters.type || concept.frontmatter.type === filters.type)
			);
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}
export function readConcept(id: string, root = wikiRoot()): WikiConcept {
	const file = conceptPath(id, root);
	const concept = readPath(file, root);
	if (!concept) throw new Error(`invalid or missing concept: ${id}`);
	return concept;
}

function snippet(text: string, terms: string[]): string {
	const lower = text.toLowerCase();
	const index = Math.max(
		0,
		terms
			.map((term) => lower.indexOf(term))
			.filter((item) => item >= 0)
			.sort((a, b) => a - b)[0] ?? 0,
	);
	return text
		.replace(/\s+/g, " ")
		.slice(Math.max(0, index - 60), index + 180)
		.trim();
}
export function searchConcepts(terms: string[], limit = 20): WikiSearchHit[] {
	const wanted = terms.map((term) => term.toLowerCase()).filter(Boolean);
	if (!wanted.length) return [];
	return listConcepts()
		.map((concept) => {
			const title = String(concept.frontmatter.title ?? "");
			const tags = Array.isArray(concept.frontmatter.tags)
				? concept.frontmatter.tags.map(String)
				: [];
			const headings = concept.body.match(/^#{1,6} .+$/gm)?.join(" ") ?? "";
			const searchable = `${title} ${tags.join(" ")} ${headings} ${concept.body}`;
			const score = wanted.reduce(
				(total, term) =>
					total +
					(title.toLowerCase().includes(term) ? 4 : 0) +
					(tags.some((tag) => tag.toLowerCase().includes(term)) ? 3 : 0) +
					(headings.toLowerCase().includes(term) ? 2 : 0) +
					(concept.body.toLowerCase().includes(term) ? 1 : 0),
				0,
			);
			return {
				id: concept.id,
				title,
				tags,
				status: concept.status,
				trust: concept.trust,
				stale: concept.stale,
				uncited: concept.uncitedLines.length,
				snippet: snippet(searchable, wanted),
				score,
			};
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(0, limit));
}

function changeFor(input: WikiWriteInput): string | undefined {
	return (
		input.changeId ||
		process.env.HERDR_CHANGE_ID ||
		// Wiki-only and research workflows have no planner to record a change
		// id; their snapshot/verify identity is the workflow id.
		process.env.HERDR_WORKFLOW_ID
	);
}
function snapshotRoot(changeId: string, baseDir: string): string {
	if (!CHANGE_ID.test(changeId)) throw new Error("invalid change id");
	const base = path.resolve(baseDir);
	const root = path.resolve(base, ".herdr-workflow", changeId, "wiki-snapshot");
	if (!root.startsWith(`${base}${path.sep}`))
		throw new Error("invalid snapshot root");
	let current = base;
	for (const part of [".herdr-workflow", changeId, "wiki-snapshot"]) {
		current = path.join(current, part);
		try {
			if (fs.lstatSync(current).isSymbolicLink())
				throw new Error("symbolic links are not allowed in snapshots");
		} catch (error) {
			if (error instanceof Error && error.message.includes("symbolic links"))
				throw error;
		}
	}
	return root;
}
function ensureSnapshotParent(root: string, file: string): void {
	const relative = path.relative(root, path.dirname(file));
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("snapshot path escapes root");
	let current = root;
	for (const part of relative ? relative.split(path.sep) : []) {
		current = path.join(current, part);
		fs.mkdirSync(current, { recursive: true });
		if (fs.lstatSync(current).isSymbolicLink())
			throw new Error("symbolic links are not allowed in snapshots");
	}
	try {
		if (fs.lstatSync(file).isSymbolicLink())
			throw new Error("symbolic links are not allowed in snapshots");
	} catch (error) {
		if (error instanceof Error && error.message.includes("symbolic links"))
			throw error;
	}
}
function workflowSnapshotBase(): string {
	return process.env.HERDR_WORKFLOW_TARGET === "wiki://centralized" ||
		process.env.HERDR_WORKFLOW_TARGET === "research://standalone"
		? path.join(path.dirname(wikiRoot()), ".agentic-coding-workflow")
		: process.cwd();
}
export function snapshotOnFirstTouch(
	changeId: string,
	concept: string,
	baseDir = process.cwd(),
	root = wikiRoot(),
): string {
	const safeConcept = concept.replaceAll("\\", "/");
	const source = conceptPath(safeConcept, root);
	const destination = path.join(
		snapshotRoot(changeId, baseDir),
		`${safeConcept.replaceAll("/", path.sep)}.md`,
	);
	ensureSnapshotParent(snapshotRoot(changeId, baseDir), destination);
	if (fs.existsSync(destination)) return destination;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	let prior = TOMBSTONE;
	try {
		prior = fs.readFileSync(source, "utf8");
	} catch {}
	fs.writeFileSync(destination, prior, { mode: 0o600 });
	return destination;
}
export function snapshotList(
	changeId: string,
	baseDir = process.cwd(),
): string[] {
	const root = snapshotRoot(changeId, baseDir);
	if (!fs.existsSync(root)) return [];
	const result: string[] = [];
	for (const file of conceptFiles(root))
		result.push(
			path.relative(root, file).split(path.sep).join("/").replace(/\.md$/, ""),
		);
	return result.sort();
}
export function snapshotRead(
	changeId: string,
	concept: string,
	baseDir = process.cwd(),
	root = wikiRoot(),
): string | undefined {
	const safeConcept = conceptPath(concept.replaceAll("\\", "/"), root);
	const conceptId = path
		.relative(ensureBundle(root), safeConcept)
		.split(path.sep)
		.join("/")
		.replace(/\.md$/, "");
	const snapshotDir = snapshotRoot(changeId, baseDir);
	const file = path.join(
		snapshotDir,
		`${conceptId.replaceAll("/", path.sep)}.md`,
	);
	if (!file.startsWith(`${snapshotDir}${path.sep}`) || !fs.existsSync(file))
		return undefined;
	if (
		file !==
		path.resolve(
			baseDir,
			".herdr-workflow",
			changeId,
			"wiki-snapshot",
			`${conceptId.replaceAll("/", path.sep)}.md`,
		)
	)
		return undefined;
	return fs.readFileSync(file, "utf8");
}

export function writeConcept(
	concept: string,
	input: WikiWriteInput,
	root = wikiRoot(),
): WikiConcept {
	validateProducerFields(input);
	const file = conceptPath(concept, root);
	const existing = fs.existsSync(file)
		? parseDocument(fs.readFileSync(file, "utf8"))
		: undefined;
	const frontmatter: WikiFrontmatter = {
		...(existing?.frontmatter ?? {}),
		...input,
	};
	delete frontmatter.body;
	delete frontmatter.changeId;
	delete frontmatter.generatedBy;
	const body = input.body ?? existing?.body ?? "";
	const changeId = changeFor(input);
	const now = new Date();
	const at = now.toISOString();
	if (changeId) {
		const sources = Array.isArray(frontmatter.sources)
			? [...frontmatter.sources]
			: [];
		if (
			!sources.some(
				(source) =>
					source &&
					typeof source === "object" &&
					(source as Record<string, unknown>).id === changeId,
			)
		)
			sources.push({
				id: changeId,
				resource: `openspec://changes/${changeId}`,
			});
		frontmatter.sources = sources;
	}
	// URL evidence is timestamped on write, matching the concept's update time.
	frontmatter.sources = stampSourceAccess(frontmatter.sources, at);
	frontmatter.stale_after =
		typeof input.stale_after === "string"
			? input.stale_after
			: defaultStaleAfter(now);
	if (
		existing?.frontmatter.verified !== undefined ||
		["wiki", "research-wiki", "planner", "consolidator"].includes(
			process.env.HERDR_ROLE ?? "",
		)
	) {
		frontmatter.status = "draft";
		delete frontmatter.verified;
	}
	frontmatter.generated = {
		...(existing?.frontmatter.generated as Record<string, unknown> | undefined),
		by:
			input.generatedBy ??
			(existing?.frontmatter.generated as Record<string, unknown> | undefined)
				?.by ??
			"process:herdr",
		at,
	};
	validateProducerFields(frontmatter as WikiWriteInput);
	assertCitations(frontmatter, body);
	if (changeId)
		snapshotOnFirstTouch(changeId, concept, workflowSnapshotBase(), root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const realRoot = fs.realpathSync(ensureBundle(root));
	const realParent = fs.realpathSync(path.dirname(file));
	if (
		realParent !== realRoot &&
		!realParent.startsWith(`${realRoot}${path.sep}`)
	)
		throw new Error("wiki path resolves outside the bundle");
	conceptPath(concept, root);
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, renderDocument(frontmatter, body), {
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
		throw error;
	}
	return readConcept(concept, root);
}

export function verifyConcept(
	concept: string,
	verifyingActor: string,
	validatedContent?: string,
	promote = true,
	root = wikiRoot(),
): WikiConcept {
	actor(verifyingActor, "actor");
	const file = conceptPath(concept, root);
	const content = validatedContent ?? fs.readFileSync(file, "utf8");
	const current = parseDocument(content);
	const now = new Date();
	const verified = Array.isArray(current.frontmatter.verified)
		? [...current.frontmatter.verified]
		: current.frontmatter.verified
			? [current.frontmatter.verified]
			: [];
	if (
		!verified.some(
			(item) =>
				item &&
				typeof item === "object" &&
				(item as Record<string, unknown>).by === verifyingActor,
		)
	)
		verified.push({ by: verifyingActor, at: now.toISOString() });
	const generated =
		current.frontmatter.generated &&
		typeof current.frontmatter.generated === "object"
			? (current.frontmatter.generated as Record<string, unknown>)
			: {};
	const frontmatter = {
		...current.frontmatter,
		verified,
		status: promote ? "stable" : "draft",
		stale_after: defaultStaleAfter(now),
		generated: { ...generated, at: now.toISOString() },
	};
	validateProducerFields(frontmatter);
	// Promotion is also a write: a fact may only be promoted once its sources
	// are identifiable and every prose line cites one, closing the bypass where
	// previously stored uncited content could be marked stable.
	assertCitations(frontmatter, current.body);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, renderDocument(frontmatter, current.body), {
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
		throw error;
	}
	return readConcept(concept, root);
}

export function appendLog(dir: string, entry: string): string {
	if (!entry.trim()) throw new Error("log entry is required");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "log.md");
	const today = new Date().toISOString().slice(0, 10);
	const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const sections = [
		...old.matchAll(
			/^## (\d{4}-\d{2}-\d{2})[ \t]*$([\s\S]*?)(?=^## \d{4}-\d{2}-\d{2}[ \t]*$|$)/gm,
		),
	].map((match) => ({ date: match[1] ?? "", body: (match[2] ?? "").trim() }));
	const current = sections.find((section) => section.date === today);
	if (current) current.body = `- ${entry.trim()}\n${current.body}`.trim();
	else sections.push({ date: today, body: `- ${entry.trim()}` });
	sections.sort((a, b) => b.date.localeCompare(a.date));
	const result = `${sections.map((section) => `## ${section.date}\n\n${section.body}`).join("\n\n")}\n`;
	fs.writeFileSync(file, result, { mode: 0o600 });
	return file;
}

export { TOMBSTONE };
