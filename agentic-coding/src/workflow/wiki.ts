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
}
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export interface WikiSearchHit {
	id: string;
	title: string;
	tags: string[];
	status: string;
	trust: TrustTier;
	stale: boolean;
	snippet: string;
	score: number;
}

const RESERVED = new Set(["index.md", "log.md"]);
const ACTOR =
	/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|human:[^\s/]+|process:[^\s/]+)$/;
const STATUS = new Set(["draft", "stable", "deprecated"]);
const CHANGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const TOMBSTONE = "<!-- okf tombstone: concept did not exist -->\n";

function expand(value: string): string {
	return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Resolve the shared wiki root without requiring a repository or workflow. */
export function wikiRoot(): string {
	const configured = process.env.HERDR_WIKI_DIR || loadConfig().wiki?.root;
	return path.resolve(expand(configured || "~/.config/agentic-coding/wiki"));
}

export function ensureBundle(): string {
	const root = wikiRoot();
	fs.mkdirSync(root, { recursive: true });
	const index = path.join(root, "index.md");
	if (!fs.existsSync(index))
		fs.writeFileSync(index, '---\nokf_version: "0.2"\n---\n\n', {
			mode: 0o600,
		});
	return root;
}

/** Resolve a concept id to a path while preventing bundle escapes. */
export function conceptPath(rel: string): string {
	if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
		throw new Error("concept path must stay inside the wiki bundle");
	const normalized = rel.replaceAll("\\", "/");
	const withExtension = normalized.endsWith(".md")
		? normalized
		: `${normalized}.md`;
	if (RESERVED.has(path.posix.basename(withExtension)))
		throw new Error(`${path.posix.basename(withExtension)} is reserved`);
	const root = path.resolve(ensureBundle());
	const resolved = path.resolve(root, ...withExtension.split("/"));
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
		throw new Error("concept path must stay inside the wiki bundle");
	let current = root;
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
	return (
		typeof frontmatter.stale_after === "string" &&
		!Number.isNaN(Date.parse(frontmatter.stale_after)) &&
		now.getTime() >= Date.parse(frontmatter.stale_after)
	);
}

function readPath(file: string): WikiConcept | undefined {
	try {
		const document = parseDocument(fs.readFileSync(file, "utf8"));
		if (!checkConformance(document)) return undefined;
		const id = path
			.relative(ensureBundle(), file)
			.split(path.sep)
			.join("/")
			.replace(/\.md$/, "");
		return {
			...document,
			id,
			path: file,
			status: effectiveStatus(document),
			trust: trustTier(document),
			stale: isStale(document),
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
): WikiConcept[] {
	const concepts = conceptFiles(ensureBundle()).flatMap((file) => {
		const concept = readPath(file);
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
export function readConcept(id: string): WikiConcept {
	const file = conceptPath(id);
	const concept = readPath(file);
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
				snippet: snippet(searchable, wanted),
				score,
			};
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(0, limit));
}

function changeFor(input: WikiWriteInput): string | undefined {
	return input.changeId || process.env.HERDR_CHANGE_ID;
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
export function snapshotOnFirstTouch(
	changeId: string,
	concept: string,
	baseDir = process.cwd(),
): string {
	const safeConcept = concept.replaceAll("\\", "/");
	const source = conceptPath(safeConcept);
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
): string | undefined {
	const safeConcept = conceptPath(concept.replaceAll("\\", "/"));
	const conceptId = path
		.relative(wikiRoot(), safeConcept)
		.split(path.sep)
		.join("/")
		.replace(/\.md$/, "");
	const root = snapshotRoot(changeId, baseDir);
	const file = path.join(root, `${conceptId.replaceAll("/", path.sep)}.md`);
	if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file))
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
): WikiConcept {
	validateProducerFields(input);
	const file = conceptPath(concept);
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
	const changeId = changeFor(input);
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
	if (
		existing?.frontmatter.verified !== undefined ||
		["wiki", "planner", "consolidator"].includes(process.env.HERDR_ROLE ?? "")
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
		at: new Date().toISOString(),
	};
	validateProducerFields(frontmatter as WikiWriteInput);
	if (changeFor(input))
		snapshotOnFirstTouch(changeFor(input) as string, concept);
	const body = input.body ?? existing?.body ?? "";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const realRoot = fs.realpathSync(wikiRoot());
	const realParent = fs.realpathSync(path.dirname(file));
	if (
		realParent !== realRoot &&
		!realParent.startsWith(`${realRoot}${path.sep}`)
	)
		throw new Error("wiki path resolves outside the bundle");
	conceptPath(concept);
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
	return readConcept(concept);
}

export function verifyConcept(
	concept: string,
	verifyingActor: string,
	validatedContent?: string,
	promote = true,
): WikiConcept {
	actor(verifyingActor, "actor");
	const file = conceptPath(concept);
	const content = validatedContent ?? fs.readFileSync(file, "utf8");
	const current = parseDocument(content);
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
		verified.push({ by: verifyingActor, at: new Date().toISOString() });
	const generated =
		current.frontmatter.generated &&
		typeof current.frontmatter.generated === "object"
			? (current.frontmatter.generated as Record<string, unknown>)
			: {};
	const frontmatter = {
		...current.frontmatter,
		verified,
		status: promote ? "stable" : "draft",
		generated: { ...generated, at: new Date().toISOString() },
	};
	validateProducerFields(frontmatter);
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
	return readConcept(concept);
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
