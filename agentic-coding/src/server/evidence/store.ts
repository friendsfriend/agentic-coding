// The evidence store (add-workflow-evidence-store): one workflow's evidence
// directory, its `manifest.json`, and every check that bounds what may enter.
//
// The store is deliberate about three properties the change asks for:
//
// * **Copy-in with path safety.** An attach only ever *reads* a source file that
//   resolves, by `realpath`, inside one of the workflow's own roots (its
//   checkout or its data directory). The destination is derived from a fresh
//   ULID, never from the caller's path, so a caller cannot choose where its
//   bytes land.
// * **Caps refuse, never evict.** Evidence the agent chose to keep is never
//   silently deleted: an attach that would exceed the per-file or per-workflow
//   cap fails with `evidence-quota` and every earlier entry stays.
// * **The manifest is written atomically.** The file is copied in first, then
//   one `manifest.json` is replaced whole through `writeAtomicPrivateFile`, so a
//   reader never sees a half-written manifest and an interrupted attach leaves
//   at most an unreferenced file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	EvidenceEntry,
	EvidenceKind,
	EvidenceManifest,
} from "../../contracts/environment.ts";
import {
	EVIDENCE_REQUEST_PREFIX,
	evidenceFileAt,
	isPlainEvidenceName,
	type WorkflowEvidenceScope,
	withEvidenceRootLock,
} from "../../workflow/runtime/evidence-store.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureDirectoryRelative,
	openSecureFile,
	secureDirectoryNames,
	writeAtomicPrivateFile,
} from "../../workflow/secure-fs.ts";

/** The manifest file inside one workflow's evidence directory. */
export const EVIDENCE_MANIFEST_FILE = "manifest.json";

/** Per-file cap for every kind except video. */
export const EVIDENCE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Per-file cap for a video: a screen recording is legitimately larger. */
export const EVIDENCE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** Per-workflow cap across every non-pinned entry. */
export const EVIDENCE_QUOTA_BYTES = 1024 * 1024 * 1024;

/** How much of a file the content check reads. PNG/JPEG/WebM/MP4/ZIP headers
 * all sit in the first bytes, and a longer read would cost the whole file's
 * memory for no further evidence. */
const CONTENT_HEAD_BYTES = 4096;
/** Copy chunk: one window per read, so a 100 MB video never enters memory. */
const COPY_CHUNK_BYTES = 1024 * 1024;
/** Bounded directory listing for a read of the root. */
const MAX_DIRECTORY_ENTRIES = 20_000;
/** Most entries one workflow's manifest may hold. A manifest is read and
 * rewritten on every attach, so entry count is a bound of its own: without it,
 * a run could keep the file growing with arbitrarily small attachments. */
const MAX_MANIFEST_ENTRIES = 10_000;

/** The refusals this store can answer with. `evidence-quota` covers both the
 * per-file and the per-workflow cap, as the change's spec names one code for
 * "over a cap". */
export type EvidenceRefusalCode =
	| "evidence-path"
	| "evidence-kind"
	| "evidence-quota"
	| "evidence-missing"
	| "evidence-manifest"
	// `add-stage-flow-evidence`: a journal at its per-file cap and a stored
	// screenshot past the stage's own bound. Both are evidence refusals the
	// browser route answers with, in the same vocabulary as the rest.
	| "stage-journal-full"
	| "stage-screenshot-limit";

/** A bounded, typed refusal: the route layer maps `status` and `code` onto the
 * wire, and the agent tool reports `code: message`. */
export class EvidenceError extends Error {
	readonly code: EvidenceRefusalCode;
	readonly status: number;
	constructor(code: EvidenceRefusalCode, message: string, status = 400) {
		super(message);
		this.name = "EvidenceError";
		this.code = code;
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 48 bits of time, then 80 bits of randomness, in Crockford base 32.
 * Lexical order is time order, so the manifest sorts by id into creation order
 * and a file name never needs a separate timestamp. 26 characters, the id
 * alphabet a file name and a URL path segment both accept.
 */
export function evidenceId(
	now: number = Date.now(),
	random: Uint8Array = randomBytes(16),
): string {
	let time = "";
	let remaining = Math.max(0, Math.floor(now));
	for (let index = 0; index < 10; index++) {
		time = `${CROCKFORD[remaining % 32]}${time}`;
		remaining = Math.floor(remaining / 32);
	}
	let tail = "";
	for (const byte of random) tail += CROCKFORD[byte % 32];
	return `${time}${tail.slice(0, 16).padEnd(16, "0")}`;
}

// ---------------------------------------------------------------------------
// Kind, extension and content
// ---------------------------------------------------------------------------

type EvidenceFormat = "png" | "jpeg" | "webp" | "webm" | "mp4" | "zip";

interface KindRule {
	/** The formats this kind's content may be, when it has magic bytes. */
	readonly formats?: readonly EvidenceFormat[];
	/** The extensions this kind accepts. Absent means any safe extension. */
	readonly extensions?: readonly string[];
	/** The content must be text (no NUL, decodable UTF-8). */
	readonly text?: boolean;
	/** Used when the source names no extension this kind accepts. */
	readonly defaultExtension: string;
}

const TEXT_EXTENSIONS = [
	"sh",
	"bash",
	"zsh",
	"fish",
	"py",
	"rb",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"go",
	"rs",
	"java",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"pl",
	"ps1",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"log",
	"txt",
	"csv",
	"tsv",
	"sql",
	"html",
	"css",
	"xml",
	"md",
	"diff",
	"patch",
];

/** The extension each magic-bearing format conventionally carries, so a `.png`
 * that is really a JPEG is refused rather than stored under a lying name. */
const FORMATS_BY_EXTENSION: Readonly<Record<string, EvidenceFormat>> = {
	png: "png",
	jpg: "jpeg",
	jpeg: "jpeg",
	webp: "webp",
	webm: "webm",
	mp4: "mp4",
	zip: "zip",
};

const KIND_RULES: Readonly<Record<EvidenceKind, KindRule>> = {
	screenshot: {
		formats: ["png", "jpeg", "webp"],
		extensions: ["png", "jpg", "jpeg", "webp"],
		defaultExtension: "",
	},
	video: {
		formats: ["webm", "mp4"],
		extensions: ["webm", "mp4"],
		defaultExtension: "",
	},
	trace: { formats: ["zip"], extensions: ["zip"], defaultExtension: "" },
	script: { text: true, extensions: TEXT_EXTENSIONS, defaultExtension: "txt" },
	log: { text: true, extensions: TEXT_EXTENSIONS, defaultExtension: "log" },
	other: { defaultExtension: "bin" },
};

/** The per-file cap of one kind. */
export function evidenceFileMaxBytes(kind: EvidenceKind): number {
	return kind === "video" ? EVIDENCE_VIDEO_MAX_BYTES : EVIDENCE_FILE_MAX_BYTES;
}

function startsWithBytes(head: Buffer, signature: readonly number[]): boolean {
	if (head.length < signature.length) return false;
	for (let index = 0; index < signature.length; index++)
		if (head[index] !== signature[index]) return false;
	return true;
}

/** The format the content's own bytes declare. */
export function detectEvidenceFormat(head: Buffer): EvidenceFormat | undefined {
	if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "png";
	if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return "jpeg";
	if (
		head.length >= 12 &&
		head.toString("latin1", 0, 4) === "RIFF" &&
		head.toString("latin1", 8, 12) === "WEBP"
	)
		return "webp";
	if (startsWithBytes(head, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
	if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp")
		return "mp4";
	// ZIP local file, empty archive, and spanned-archive headers.
	if (
		startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) ||
		startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06]) ||
		startsWithBytes(head, [0x50, 0x4b, 0x07, 0x08])
	)
		return "zip";
	return undefined;
}

/** Whether a bounded head reads as text: no NUL byte, and decodable UTF-8. A
 * window that ends mid-sequence is trimmed rather than called binary, because
 * the head is a window on a file that continues. */
function looksLikeText(head: Buffer): boolean {
	if (head.includes(0)) return false;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let trim = 0; trim < 4 && trim <= head.length; trim++) {
		const window = trim === 0 ? head : head.subarray(0, head.length - trim);
		try {
			decoder.decode(window);
			return true;
		} catch {
			// One fewer byte may end the window on a character boundary.
		}
	}
	return false;
}

/** The extension this kind stores the file under: the source's own when it is
 * a safe token the kind accepts, otherwise the kind's default. A magic-bearing
 * kind with neither is refused rather than stored under a guessed name. */
export function evidenceExtension(source: string, kind: EvidenceKind): string {
	const raw = path.extname(source).replace(/^\./, "").toLowerCase();
	const rule = KIND_RULES[kind];
	if (
		/^[a-z0-9]{1,8}$/.test(raw) &&
		(!rule.extensions || rule.extensions.includes(raw))
	)
		return raw;
	if (rule.extensions)
		throw new EvidenceError(
			"evidence-kind",
			`kind ${kind} accepts ${rule.extensions.join(", ")} files; received ${JSON.stringify(source)}`,
		);
	return rule.defaultExtension;
}

/** Check a bounded content head against the declared kind, and answer the
 * format the bytes declare (for a trace or an image, so the caller can report
 * what was stored). */
function checkContent(
	kind: EvidenceKind,
	extension: string,
	head: Buffer,
): EvidenceFormat | undefined {
	const rule = KIND_RULES[kind];
	if (rule.text && !looksLikeText(head))
		throw new EvidenceError(
			"evidence-kind",
			`kind ${kind} stores text; the content is not text`,
		);
	if (!rule.formats) return undefined;
	const format = detectEvidenceFormat(head);
	if (!format || !rule.formats.includes(format))
		throw new EvidenceError(
			"evidence-kind",
			`kind ${kind} accepts ${rule.formats.join(", ")} content; the file's bytes are not one of them`,
		);
	const expected = FORMATS_BY_EXTENSION[extension];
	if (expected && expected !== format)
		throw new EvidenceError(
			"evidence-kind",
			`the file is a ${format} named .${extension}`,
		);
	return format;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** One request directory name under the workflow's evidence root. A request id
 * is a file-name component, so it is validated as one and may never traverse. */
export function evidenceRequestDirectory(requestId: string): string {
	if (
		requestId.length === 0 ||
		requestId.length > 64 ||
		hasControlCharacters(requestId) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestId) ||
		requestId === "." ||
		requestId === ".."
	)
		throw new EvidenceError(
			"evidence-path",
			`requestId must be 1-64 letters, digits, dots, dashes or underscores`,
		);
	return `${EVIDENCE_REQUEST_PREFIX}${requestId}`;
}

/** Whether one absolute, already-resolved source path is inside a root. */
function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** One relative path inside the evidence root. Every component is a plain
 * name: a manifest that somehow named `../` would be refused, not followed. */
function requireRelativeEvidenceFile(file: string): string {
	const components = file.split("/");
	if (components.length > 2)
		throw new EvidenceError(
			"evidence-manifest",
			`manifest entry names a nested evidence file: ${JSON.stringify(file)}`,
			500,
		);
	if (!components.every(isPlainEvidenceName))
		throw new EvidenceError(
			"evidence-manifest",
			`manifest entry names an unsafe evidence file: ${JSON.stringify(file)}`,
			500,
		);
	return components.join("/");
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Version of the on-disk manifest this build reads. An unknown version is
 * refused rather than reinterpreted, so a manifest written by a newer layout is
 * reported as unreadable instead of being served as if it were this one — and an
 * attach can never downgrade its marker, because reading it refuses first. */
export const EVIDENCE_MANIFEST_VERSION = 1;

interface StoredManifest {
	readonly version: typeof EVIDENCE_MANIFEST_VERSION;
	readonly workflowId: string;
	readonly entries: EvidenceEntry[];
}

function requireEntry(value: unknown, workflowId: string): EvidenceEntry {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new EvidenceError(
			"evidence-manifest",
			`evidence manifest of ${workflowId} contains an entry that is not an object`,
			500,
		);
	const entry = value as Record<string, unknown>;
	for (const field of ["id", "kind", "file", "caption", "createdAt"])
		if (typeof entry[field] !== "string")
			throw new EvidenceError(
				"evidence-manifest",
				`evidence manifest of ${workflowId} contains an entry without ${field}`,
				500,
			);
	if (!KIND_RULES[entry.kind as EvidenceKind])
		throw new EvidenceError(
			"evidence-manifest",
			`evidence manifest of ${workflowId} names an unknown kind ${JSON.stringify(entry.kind)}`,
			500,
		);
	requireRelativeEvidenceFile(entry.file as string);
	return entry as unknown as EvidenceEntry;
}

function readManifestRecord(
	directory: number,
	scope: WorkflowEvidenceScope,
): { readonly entries: readonly unknown[] } {
	let fd: number | undefined;
	try {
		fd = openSecureFile(directory, EVIDENCE_MANIFEST_FILE);
	} catch {
		// No manifest yet: the workflow simply has no evidence.
		return { entries: [] };
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
			throw new EvidenceError(
				"evidence-manifest",
				`the evidence manifest of ${scope.workflowId} is not a bounded regular file`,
				500,
			);
		const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new EvidenceError(
				"evidence-manifest",
				`the evidence manifest of ${scope.workflowId} is not an object`,
				500,
			);
		const record = parsed as Record<string, unknown>;
		// A manifest written before the marker existed is the first layout, so
		// reading it as version 1 is exact rather than a guess.
		const version =
			record.version === undefined ? EVIDENCE_MANIFEST_VERSION : record.version;
		if (version !== EVIDENCE_MANIFEST_VERSION)
			throw new EvidenceError(
				"evidence-manifest",
				`the evidence manifest of ${scope.workflowId} is version ${JSON.stringify(record.version)}; this build reads version ${EVIDENCE_MANIFEST_VERSION}`,
				500,
			);
		if (!Array.isArray(record.entries))
			throw new EvidenceError(
				"evidence-manifest",
				`the evidence manifest of ${scope.workflowId} has no entries`,
				500,
			);
		if (record.entries.length > MAX_MANIFEST_ENTRIES)
			throw new EvidenceError(
				"evidence-manifest",
				`the evidence manifest of ${scope.workflowId} holds more than ${MAX_MANIFEST_ENTRIES} entries`,
				500,
			);
		return { entries: record.entries };
	} catch (error) {
		if (error instanceof EvidenceError) throw error;
		throw new EvidenceError(
			"evidence-manifest",
			`the evidence manifest of ${scope.workflowId} cannot be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
			500,
		);
	} finally {
		fs.closeSync(fd);
	}
}

function readManifest(
	directory: number,
	scope: WorkflowEvidenceScope,
): StoredManifest {
	const record = readManifestRecord(directory, scope);
	return {
		version: EVIDENCE_MANIFEST_VERSION,
		workflowId: scope.workflowId,
		entries: record.entries.map((entry) =>
			requireEntry(entry, scope.workflowId),
		),
	};
}

function writeManifest(directory: number, manifest: StoredManifest): void {
	writeAtomicPrivateFile(
		directory,
		EVIDENCE_MANIFEST_FILE,
		`${JSON.stringify(manifest, null, "\t")}\n`,
		0o600,
	);
}

// ---------------------------------------------------------------------------
// Directory access
// ---------------------------------------------------------------------------

/** Open the workflow's evidence directory (creating it when asked), without
 * following any symlinked component: the data root must already exist and is
 * the boundary the evidence root is opened inside. */
function openEvidenceDirectory(
	scope: WorkflowEvidenceScope,
	create: boolean,
): number {
	if (create) fs.mkdirSync(scope.dataRoot, { recursive: true, mode: 0o700 });
	return openSecureDirectory(scope.root, scope.dataRoot, create);
}

// One attach at a time per evidence root: read-modify-write of the manifest is
// only safe while one writer holds the directory. The lock itself lives with the
// root derivation (`withEvidenceRootLock`), because the workflow's deletion is a
// writer of the same root and an attach that ran after it would recreate what it
// removed.

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

export interface EvidenceAttachRequest {
	/** The file the caller produced. Absolute; resolved and re-checked against
	 * the workflow's own roots before anything is read. */
	readonly path: string;
	readonly kind: EvidenceKind;
	readonly caption: string;
	readonly requestId?: string;
	readonly step?: string;
	readonly role?: string;
	readonly app?: string;
	readonly url?: string;
	readonly poster?: string;
	readonly pinned?: boolean;
	/** The recording segment a kept video belongs to
	 * (`add-stage-flow-evidence`): the journal steps of that segment link to it. */
	readonly segment?: number;
	/** Test seam: the clock the id and `createdAt` are derived from. */
	readonly now?: () => Date;
	/** Test seam: the randomness the ULID is filled with. */
	readonly random?: () => Uint8Array;
	/** Re-check the precondition the caller verified before it awaited its own
	 * request body. Runs inside the root lock, so a workflow deleted while that
	 * body was being read refuses the attach instead of recreating its evidence
	 * root after the deletion. */
	readonly verify?: () => void;
}

interface SourceFile {
	readonly fd: number;
	readonly size: number;
	readonly extension: string;
}

/** Resolve an attach source and open it for reading, refusing anything outside
 * the workflow's roots, anything that is not a regular file, and anything over
 * its kind's per-file cap. */
function openSource(
	scope: WorkflowEvidenceScope,
	input: EvidenceAttachRequest,
): SourceFile {
	const requested = input.path;
	if (!path.isAbsolute(requested))
		throw new EvidenceError(
			"evidence-path",
			`an attach path must be absolute; received ${JSON.stringify(requested)}`,
		);
	let resolved: string;
	try {
		resolved = fs.realpathSync(path.resolve(requested));
	} catch {
		throw new EvidenceError(
			"evidence-path",
			`${JSON.stringify(requested)} does not resolve to a file`,
		);
	}
	const roots: string[] = [];
	for (const root of scope.attachRoots) {
		try {
			roots.push(fs.realpathSync(root));
		} catch {
			// A root that does not exist cannot contain the source.
		}
	}
	if (!roots.some((root) => inside(root, resolved)))
		throw new EvidenceError(
			"evidence-path",
			`${JSON.stringify(requested)} resolves outside the workflow's checkout and data directory`,
		);
	let evidenceRoot: string | undefined;
	try {
		evidenceRoot = fs.realpathSync(scope.root);
	} catch {
		// No evidence directory yet, so nothing can already be stored.
	}
	if (evidenceRoot !== undefined && inside(evidenceRoot, resolved))
		throw new EvidenceError(
			"evidence-path",
			`${JSON.stringify(requested)} is already stored evidence`,
		);
	let fd: number;
	try {
		// The real path is opened without following a symlink: the last component
		// could have been swapped for one between `realpath` and this open.
		fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		throw new EvidenceError(
			"evidence-path",
			`${JSON.stringify(requested)} cannot be read`,
		);
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile())
			throw new EvidenceError(
				"evidence-path",
				`${JSON.stringify(requested)} is not a regular file`,
			);
		const cap = evidenceFileMaxBytes(input.kind);
		if (stat.size > cap)
			throw new EvidenceError(
				"evidence-quota",
				`kind ${input.kind} is capped at ${cap} bytes per file; ${JSON.stringify(requested)} is ${stat.size}`,
				409,
			);
		const extension = evidenceExtension(resolved, input.kind);
		const head = Buffer.alloc(Math.min(CONTENT_HEAD_BYTES, stat.size));
		if (head.length > 0) {
			const read = fs.readSync(fd, head, 0, head.length, 0);
			checkContent(input.kind, extension, head.subarray(0, read));
		} else {
			checkContent(input.kind, extension, head);
		}
		return { fd, size: stat.size, extension };
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function copyIn(
	source: number,
	size: number,
	directory: number,
	name: string,
	cleanupPath: string,
): void {
	const destination = openSecureFile(
		directory,
		name,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);
	try {
		const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, size));
		let offset = 0;
		while (offset < size) {
			const want = Math.min(buffer.length, size - offset);
			const read = fs.readSync(source, buffer, 0, want, offset);
			if (read <= 0)
				throw new EvidenceError(
					"evidence-path",
					"the source file ended while it was being copied",
				);
			let written = 0;
			while (written < read)
				written += fs.writeSync(destination, buffer, written, read - written);
			offset += read;
		}
		fs.fchmodSync(destination, 0o600);
	} catch (error) {
		fs.closeSync(destination);
		try {
			fs.unlinkSync(cleanupPath);
		} catch {
			// The partial file is unreferenced: the manifest never named it.
		}
		throw error;
	}
	fs.closeSync(destination);
}

/** The bytes recorded against the workflow's quota: everything but the pinned
 * entries, which are kept regardless of how large they are. */
function recordedBytes(entries: readonly EvidenceEntry[]): number {
	let total = 0;
	for (const entry of entries) if (!entry.pinned) total += entry.bytes ?? 0;
	return total;
}

/**
 * Copy one file into a workflow's evidence store and record it in the manifest.
 * Resolves with the recorded entry. Throws `EvidenceError` when the source is
 * outside the workflow, the content does not match the declared kind, or the
 * per-file or per-workflow cap would be exceeded — in which case nothing is
 * stored and every earlier entry is untouched.
 */
export async function attachEvidence(
	scope: WorkflowEvidenceScope,
	input: EvidenceAttachRequest,
): Promise<EvidenceEntry> {
	// The request directory is a pure derivation, so it is computed before the
	// source is opened: nothing that can refuse an attach may sit between the open
	// and the try that owns the descriptor.
	const requestDirectory =
		input.requestId === undefined
			? undefined
			: evidenceRequestDirectory(input.requestId);
	const source = openSource(scope, input);
	// One owner for the source descriptor: every exit from here — including the
	// refusals that will keep growing — closes it exactly once.
	let sourceClosed = false;
	const closeSource = () => {
		if (sourceClosed) return;
		sourceClosed = true;
		fs.closeSync(source.fd);
	};
	try {
		return await withEvidenceRootLock(scope.root, async () => {
			let root: number | undefined;
			let directory: number | undefined;
			try {
				// The caller verified the workflow exists before its own await;
				// re-running that check under the lock is what keeps a deleted
				// workflow's evidence deleted (a delete holds the same lock).
				input.verify?.();
				root = openEvidenceDirectory(scope, true);
				// One owned descriptor either way: the root itself, or the request
				// subdirectory opened through it without following a component.
				directory =
					requestDirectory === undefined
						? openSecureDirectoryRelative(root, ".", false)
						: openSecureDirectoryRelative(root, requestDirectory, true);
				// The manifest is one file per workflow, at the root, whether the
				// bytes land beside it or in a debug request's subdirectory: a reader
				// asking for the request's entries must not need a second manifest.
				const manifest = readManifest(root, scope);
				if (manifest.entries.length >= MAX_MANIFEST_ENTRIES)
					throw new EvidenceError(
						"evidence-quota",
						`${scope.workflowId} already holds the maximum of ${MAX_MANIFEST_ENTRIES} evidence entries; nothing was evicted to make room`,
						409,
					);
				const recorded = recordedBytes(manifest.entries);
				if (recorded + source.size > EVIDENCE_QUOTA_BYTES)
					throw new EvidenceError(
						"evidence-quota",
						`${scope.workflowId} has ${recorded} of ${EVIDENCE_QUOTA_BYTES} evidence bytes recorded; ${source.size} more would exceed the cap`,
						409,
					);
				const at = input.now?.() ?? new Date();
				const id = evidenceId(at.getTime(), input.random?.());
				const name = `${id}.${source.extension}`;
				const relative =
					requestDirectory === undefined ? name : `${requestDirectory}/${name}`;
				copyIn(
					source.fd,
					source.size,
					directory,
					name,
					evidenceFileAt(scope.root, relative),
				);
				const entry: EvidenceEntry = {
					id,
					kind: input.kind,
					file: relative,
					caption: input.caption,
					createdAt: at.toISOString(),
					...(input.step ? { step: input.step } : {}),
					...(input.role ? { role: input.role } : {}),
					...(input.app ? { app: input.app } : {}),
					...(input.url ? { url: input.url } : {}),
					...(input.poster ? { poster: input.poster } : {}),
					...(input.segment === undefined ? {} : { segment: input.segment }),
					bytes: source.size,
					...(input.pinned ? { pinned: true } : {}),
				};
				const entries = [...manifest.entries, entry].sort((left, right) =>
					left.id.localeCompare(right.id),
				);
				writeManifest(root, {
					version: EVIDENCE_MANIFEST_VERSION,
					workflowId: scope.workflowId,
					entries,
				});
				return entry;
			} finally {
				if (directory !== undefined) closeSecureDirectory(directory);
				if (root !== undefined) closeSecureDirectory(root);
				closeSource();
			}
		});
	} finally {
		// The refusals above (and any future one) leave through this: the source
		// descriptor is opened once and closed once.
		closeSource();
	}
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The workflow's manifest, newest last, optionally narrowed to one debug
 * request's entries. A workflow with no evidence directory yet reads as an
 * empty manifest rather than an error: "nothing attached" is an answer.
 */
export function listEvidence(
	scope: WorkflowEvidenceScope,
	options: { requestId?: string } = {},
): EvidenceManifest {
	const requestDirectory =
		options.requestId === undefined
			? undefined
			: evidenceRequestDirectory(options.requestId);
	let directory: number | undefined;
	try {
		directory = openEvidenceDirectory(scope, false);
	} catch {
		return {
			workflowId: scope.workflowId,
			...(options.requestId === undefined
				? {}
				: { requestId: options.requestId }),
			entries: [],
			bytes: 0,
			quotaBytes: EVIDENCE_QUOTA_BYTES,
		};
	}
	try {
		const manifest = readManifest(directory, scope);
		const entries =
			requestDirectory === undefined
				? manifest.entries
				: manifest.entries.filter((entry) =>
						entry.file.startsWith(`${requestDirectory}/`),
					);
		return {
			workflowId: scope.workflowId,
			...(options.requestId === undefined
				? {}
				: { requestId: options.requestId }),
			entries,
			bytes: recordedBytes(manifest.entries),
			quotaBytes: EVIDENCE_QUOTA_BYTES,
		};
	} finally {
		closeSecureDirectory(directory);
	}
}

/** One recorded entry, by id. Only the entry that matched is validated, so a
 * per-file read costs one manifest parse rather than a validation pass over
 * every entry the workflow holds. */
export function evidenceEntry(
	scope: WorkflowEvidenceScope,
	id: string,
): EvidenceEntry | undefined {
	if (!/^[A-Za-z0-9]{26}$/.test(id)) return undefined;
	let directory: number | undefined;
	try {
		directory = openEvidenceDirectory(scope, false);
	} catch {
		return undefined;
	}
	try {
		const record = readManifestRecord(directory, scope);
		const found = record.entries.find(
			(candidate) =>
				candidate !== null &&
				typeof candidate === "object" &&
				(candidate as { id?: unknown }).id === id,
		);
		return found === undefined
			? undefined
			: requireEntry(found, scope.workflowId);
	} finally {
		closeSecureDirectory(directory);
	}
}

/** One stored evidence file, opened and verified. */
export interface OpenedEvidenceFile {
	/** The verified descriptor: read it, then close it. */
	readonly fd: number;
	readonly size: number;
}

/**
 * Open one recorded entry's file for reading: every component of the path is
 * opened without following a symlink, and `fstat` confirms a regular file. The
 * caller reads the returned descriptor and closes it — the name is never
 * re-opened, so a file swapped for a symlink after this check cannot be served
 * through the store's readers.
 */
export function openEvidenceFile(
	scope: WorkflowEvidenceScope,
	entry: EvidenceEntry,
): OpenedEvidenceFile | undefined {
	const relative = requireRelativeEvidenceFile(entry.file);
	const components = relative.split("/");
	const name = components[components.length - 1] as string;
	const parent = components.slice(0, -1).join("/");
	let root: number | undefined;
	try {
		root = openEvidenceDirectory(scope, false);
	} catch {
		return undefined;
	}
	let directory: number | undefined;
	let fd: number | undefined;
	try {
		directory =
			parent === ""
				? openSecureDirectoryRelative(root, ".", false)
				: openSecureDirectoryRelative(root, parent, false);
		fd = openSecureFile(directory, name);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return undefined;
		const opened: OpenedEvidenceFile = { fd, size: stat.size };
		// The caller owns the descriptor now; the `finally` must not close it.
		fd = undefined;
		return opened;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (directory !== undefined) closeSecureDirectory(directory);
		closeSecureDirectory(root);
	}
}

/** The names directly under the workflow's evidence directory: bounded, and
 * read through the no-follow directory descriptor rather than a caller path. */
export function evidenceDirectoryNames(scope: WorkflowEvidenceScope): string[] {
	let directory: number | undefined;
	try {
		directory = openEvidenceDirectory(scope, false);
	} catch {
		return [];
	}
	try {
		return secureDirectoryNames(directory, MAX_DIRECTORY_ENTRIES);
	} finally {
		closeSecureDirectory(directory);
	}
}
