import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { inspectStagedCandidate } from "./definition-candidate.ts";
import type { Draft, SourceDraft } from "./definition-draft-data.ts";
import { within } from "./path-within.ts";

const definitionName = "environments.json",
	fileMode = 0o400,
	directoryMode = 0o500,
	readableMode = 0o700;
/** Fresh private staging directory outside every authorized repository. */
function stagingRoot(config: Config) {
	if (process.platform === "win32")
		throw new Error("Staged trees require POSIX modes and file identity");
	const state = fs.realpathSync(config.stateDir),
		stateStat = fs.lstatSync(state);
	if (
		!stateStat.isDirectory() ||
		stateStat.isSymbolicLink() ||
		(stateStat.mode & 0o077) !== 0 ||
		config.repositories.some((repo) => within(repo, state))
	)
		throw new Error(
			"Staged trees require a private state directory outside every authorized repository",
		);
	const root = path.join(state, "native", "staging");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const created = fs.lstatSync(root);
	if (
		!created.isDirectory() ||
		created.isSymbolicLink() ||
		(created.mode & 0o077) !== 0
	)
		throw new Error("Staging root is not an ordinary private directory");
	return fs.realpathSync(root);
}
function stagedFiles(draft: Draft) {
	const files = [
		{ relative: definitionName, content: draft.content },
		...((draft.sources ?? []) as SourceDraft[]).map((source) => ({
			relative: source.file,
			content: source.content,
		})),
	];
	if (new Set(files.map((file) => file.relative)).size !== files.length)
		throw new Error("Staged sources collide at one tree path");
	for (const file of files)
		if (
			!file.relative ||
			path.isAbsolute(file.relative) ||
			file.relative.split("/").some((part) => !part || part === "..")
		)
			throw new Error("Unsupported staged tree path");
	return files;
}
function write(root: string, relative: string, content: string) {
	const destination = path.join(root, relative);
	if (!within(root, destination) || destination === root)
		throw new Error("Staged tree path escapes its root");
	fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
	fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
	return destination;
}
function ancestors(root: string, relative: string) {
	const parts = relative.split("/").slice(0, -1),
		directories = [root];
	for (const part of parts)
		directories.push(path.join(directories.at(-1) ?? root, part));
	return directories;
}
function ordinaryDirectory(directory: string) {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("Staged tree directory is not ordinary");
}
/** Mode-pin children first so a read-only tree still permits cleanup afterwards. */
function pin(root: string, destination: string) {
	fs.chmodSync(destination, fileMode);
	const directories = ancestors(root, path.relative(root, destination));
	for (const directory of directories.slice(1).reverse())
		fs.chmodSync(directory, directoryMode);
}
function record(destination: string, expected: string) {
	const fd = fs.openSync(
		destination,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1)
			throw new Error("Staged tree file is not an ordinary single-link file");
		const bytes = Buffer.alloc(Buffer.byteLength(expected) + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		const content = bytes.subarray(0, length);
		if (
			length !== opened.size ||
			content.toString("utf8") !== expected ||
			digest(content.toString("base64")) !==
				digest(Buffer.from(expected).toString("base64"))
		)
			throw new Error("Staged tree content changed during verification");
		return { digest: digest(content.toString("base64")), bytes: length };
	} finally {
		fs.closeSync(fd);
	}
}
function verify(root: string, files: { relative: string; content: string }[]) {
	return files
		.map((file) => {
			for (const directory of ancestors(root, file.relative))
				ordinaryDirectory(directory);
			const observed = record(path.join(root, file.relative), file.content);
			return { pathDigest: digest(file.relative), ...observed };
		})
		.sort((a, b) => a.pathDigest.localeCompare(b.pathDigest));
}
/** Cleanup must un-pin directories before unlinking their children. Each
 * directory is re-verified with lstat before chmod so a swapped symlink is
 * never followed; removal re-checks the root immediately before unlinking. */
function discard(root: string) {
	const pinned = fs.lstatSync(root);
	if (!pinned.isDirectory() || pinned.isSymbolicLink())
		throw new Error("Unsafe tree root");
	const walk = (directory: string) => {
		const current = fs.lstatSync(directory);
		if (!current.isDirectory() || current.isSymbolicLink())
			throw new Error("Unsafe tree entry");
		try {
			fs.chmodSync(directory, readableMode);
		} catch {
			/* Best-effort unpin; removal is retried by the caller's own cleanup. */
		}
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Unsafe tree entry");
			if (entry.isDirectory()) walk(child);
			else {
				const leaf = fs.lstatSync(child);
				if (leaf.isSymbolicLink() || !leaf.isFile())
					throw new Error("Unsafe tree entry");
			}
		}
	};
	try {
		walk(root);
	} catch {
		/* A partially written tree is still removed below when reachable. */
	}
	const rechecked = fs.lstatSync(root);
	if (!rechecked.isDirectory() || rechecked.isSymbolicLink())
		throw new Error("Unsafe tree root");
	fs.rmSync(root, { recursive: true, force: true });
}

export { discard as discardStagedTree, stagingRoot };

function contentDigest(content: string) {
	return digest(Buffer.from(content).toString("base64"));
}
/** Deterministic identity of the saved bytes alone: no filesystem, no source
 * content read and no runtime observation. Promotion compares this exact
 * identity, so a durable receipt can be checked without retaining the tree. */
export function stagedTreeIdentity(draft: Draft) {
	const entries = stagedFiles(draft)
		.map((file) => ({
			pathDigest: digest(file.relative),
			digest: contentDigest(file.content),
			bytes: Buffer.byteLength(file.content),
		}))
		.sort((a, b) => a.pathDigest.localeCompare(b.pathDigest));
	return {
		treeDigest: digest(JSON.stringify(entries)),
		entries,
		fileCount: entries.length,
		bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
	};
}
export type StagedTreeIdentity = ReturnType<typeof stagedTreeIdentity>;
const scope = {
	kind: "staged-tree" as const,
	sourceContentsChecked: false as const,
	runtimeChecked: false as const,
	dependenciesExpanded: false as const,
	bindContentsChecked: false as const,
	baseFreshnessChecked: false as const,
	publicationAllowed: false as const,
	executionAllowed: false as const,
};
/** Retained trees live in one bounded private directory, addressed by digest. */
function retainedRoot(config: Config) {
	const base = stagingRoot(config),
		root = path.join(base, "trees");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const created = fs.lstatSync(root);
	if (
		!created.isDirectory() ||
		created.isSymbolicLink() ||
		(created.mode & 0o077) !== 0
	)
		throw new Error("Retained tree root is not an ordinary private directory");
	return root;
}
/** Reuse checks the bounded expected layout as well as each saved byte. A
 * directory name is not evidence that its contents still match its digest. */
function verifyRetained(
	root: string,
	files: { relative: string; content: string }[],
) {
	const children = new Map<string, Set<string>>();
	for (const file of files) {
		const directories = ancestors(root, file.relative);
		for (const [index, directory] of directories.entries()) {
			const names = children.get(directory) ?? new Set<string>();
			names.add(path.basename(directories[index + 1] ?? file.relative));
			children.set(directory, names);
		}
	}
	for (const [directory, names] of children) {
		ordinaryDirectory(directory);
		const entries = fs.readdirSync(directory);
		if (
			entries.length !== names.size ||
			entries.some((name) => !names.has(name))
		)
			throw new Error(
				"Retained tree layout changed; explicit release required",
			);
	}
	return verify(root, files);
}
/** Move one verified tree into the retained root under its digest. An existing
 * directory needs this draft's recorded claim AND fresh byte/layout verification;
 * equal bytes without ownership are never adopted, including after a crash. */
function retainStagedTree(
	config: Config,
	assembled: string,
	identity: StagedTreeIdentity,
	files: { relative: string; content: string }[],
	ownedName: string | undefined,
) {
	const treeDigest = identity.treeDigest;
	if (!/^[a-f0-9]{64}$/.test(treeDigest))
		throw new Error("Retained trees are addressed by their verified digest");
	const root = retainedRoot(config),
		destination = path.join(root, treeDigest);
	let existing = false;
	try {
		fs.lstatSync(destination);
		existing = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing) {
		if (ownedName !== treeDigest)
			throw new Error(
				"Unowned retained tree cannot be adopted; inspect metadata and explicitly release its digest first",
			);
		if (
			JSON.stringify(verifyRetained(destination, files)) !==
			JSON.stringify(identity.entries)
		)
			throw new Error(
				"Retained tree content changed; explicit release required",
			);
		discard(assembled);
		return destination;
	}
	try {
		fs.renameSync(assembled, destination);
	} catch {
		throw new Error(
			"Retained tree could not be moved; the assembled tree was discarded",
		);
	}
	return destination;
}
/** Delete exactly one retained tree by its recorded digest; nothing is inferred. */
export function releaseStagedTree(config: Config, name: string) {
	if (!/^[a-f0-9]{64}$/.test(name))
		throw new Error("Retained tree release requires the recorded digest");
	const root = retainedRoot(config),
		destination = path.join(root, name);
	if (!within(root, destination) || destination === root)
		throw new Error("Retained tree path escapes its root");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { name, released: false as const };
		throw new Error("Retained tree is unavailable");
	}
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("Retained tree is not an ordinary directory");
	discard(destination);
	try {
		fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { name, released: true as const };
		throw error;
	}
	throw new Error(
		"Retained tree removal did not complete; inspect before retry",
	);
}
/** Names only: inspection never reads retained tree content. */
export function retainedStagedTrees(config: Config) {
	const root = retainedRoot(config);
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => entry.name)
		.filter((name) => /^[a-f0-9]{64}$/.test(name))
		.sort();
}
/** Ephemeral or retained private tree from saved text only: assembled, verified,
 * and either kept under its digest or discarded. */
export function assembleStagedTree(
	config: Config,
	draft: Draft,
	options?: { retain?: boolean; ownedName?: string; temporaryKey?: string },
) {
	const candidate = inspectStagedCandidate(config, draft);
	if (!candidate.accepted)
		return {
			...scope,
			accepted: false,
			isolatedTreeChecked: false as const,
			treeRetained: false as const,
			candidateDigest: candidate.candidateDigest,
			treeDigest: null,
			entries: [],
			fileCount: 0,
			bytes: 0,
			message:
				"No isolated tree assembled: the saved candidate is incomplete, unsupported, orphaned or refused. Save/complete every declared Compose target and re-check the candidate first. No files, source text or parser errors retained.",
		};
	let root: string | undefined,
		retained = false;
	try {
		const files = stagedFiles(draft),
			identity = stagedTreeIdentity(draft),
			base = stagingRoot(config);
		if (options?.temporaryKey) {
			if (!/^[a-f0-9]{64}$/.test(options.temporaryKey))
				throw new Error("Invalid assembly identity");
			const temporary = path.join(base, `tree-${options.temporaryKey}`);
			// An existing directory is never adopted or discarded by this attempt.
			fs.mkdirSync(temporary, { mode: 0o700 });
			root = temporary;
		} else root = fs.mkdtempSync(path.join(base, "tree-"));
		if (!within(base, root) || root === base)
			throw new Error("Staging directory left the private staging root");
		for (const file of files) write(root, file.relative, file.content);
		for (const file of files) pin(root, path.join(root, file.relative));
		const entries = verify(root, files);
		// The written tree must be exactly the identity promotion will require.
		if (JSON.stringify(entries) !== JSON.stringify(identity.entries))
			throw new Error("Staged tree content changed during verification");
		if (options?.retain) {
			retainStagedTree(config, root, identity, files, options.ownedName);
			retained = true;
		}
		return {
			...scope,
			accepted: true,
			isolatedTreeChecked: true as const,
			treeRetained: options?.retain === true,
			candidateDigest: candidate.candidateDigest,
			...identity,
			message: options?.retain
				? "Isolated tree assembled from saved JSON and staged source text in a private state directory outside every authorized repository, mode-pinned, re-read and digest-verified, then retained under its own digest for inspection. Paths, source text, services, commands and values are withheld as path digests, content digests and byte counts. The retained tree grants no repository write, live source/bind read, base refresh, runtime call, review or publication authority, and promotion still requires the recorded digest identity rather than the directory. It is released by a superseding verified tree, draft deletion or explicit digest-addressed release."
				: "Ephemeral isolated tree assembled from saved JSON and staged source text in a private state directory outside every authorized repository, mode-pinned, re-read and digest-verified, then discarded. Paths, source text, services, commands and values are withheld as path digests, content digests and byte counts. No repository write, live source/bind read, base refresh, runtime call, review or publication; tree identity is neither readiness nor promotion authority.",
		};
	} catch {
		return {
			...scope,
			accepted: false,
			isolatedTreeChecked: false as const,
			treeRetained: false as const,
			candidateDigest: candidate.candidateDigest,
			treeDigest: null,
			entries: [],
			fileCount: 0,
			bytes: 0,
			message:
				"No isolated tree verified: non-private/unavailable staging root, colliding/unsupported path, unwritable tree or content mismatch. Any partial tree was discarded; paths, source text and filesystem errors withheld. No repository write, runtime call or publication.",
		};
	} finally {
		if (root && !retained) discard(root);
	}
}
