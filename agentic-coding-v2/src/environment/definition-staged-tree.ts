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
/** Cleanup must un-pin directories before unlinking their children. */
function discard(root: string) {
	const walk = (directory: string) => {
		try {
			fs.chmodSync(directory, readableMode);
		} catch {
			/* Best-effort unpin; removal is retried by the caller's own cleanup. */
		}
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
			if (entry.isDirectory() && !entry.isSymbolicLink())
				walk(path.join(directory, entry.name));
	};
	try {
		walk(root);
	} catch {
		/* A partially written tree is still removed below when reachable. */
	}
	fs.rmSync(root, { recursive: true, force: true });
}
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
/** Ephemeral private tree from saved text only: assembled, verified, discarded. */
export function assembleStagedTree(config: Config, draft: Draft) {
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
	let root: string | undefined;
	try {
		const files = stagedFiles(draft),
			base = stagingRoot(config);
		root = fs.mkdtempSync(path.join(base, "tree-"));
		if (!within(base, root) || root === base)
			throw new Error("Staging directory left the private staging root");
		for (const file of files) write(root, file.relative, file.content);
		for (const file of files) pin(root, path.join(root, file.relative));
		const entries = verify(root, files);
		return {
			...scope,
			accepted: true,
			isolatedTreeChecked: true as const,
			treeRetained: false as const,
			candidateDigest: candidate.candidateDigest,
			treeDigest: digest(JSON.stringify(entries)),
			entries,
			fileCount: entries.length,
			bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
			message:
				"Ephemeral isolated tree assembled from saved JSON and staged source text in a private state directory outside every authorized repository, mode-pinned, re-read and digest-verified, then discarded. Paths, source text, services, commands and values are withheld as path digests, content digests and byte counts. No repository write, live source/bind read, base refresh, runtime call, review or publication; tree identity is neither readiness nor promotion authority.",
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
		if (root) discard(root);
	}
}
