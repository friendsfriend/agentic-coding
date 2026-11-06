import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import type { TaskInfo } from "../state.ts";

const candidates = [
	"package.json",
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Dockerfile",
	"Containerfile",
	"compose.yaml",
	"compose.yml",
	"docker-compose.yaml",
	"docker-compose.yml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"Makefile",
];
const lockManagers: Record<string, string> = {
	"bun.lock": "bun",
	"bun.lockb": "bun",
	"package-lock.json": "npm",
	"pnpm-lock.yaml": "pnpm",
	"yarn.lock": "yarn",
};
type Evidence = {
	path: string;
	state: "regular" | "symlink-not-followed" | "nonregular" | "unavailable";
	bytes?: number;
	digest?: string;
	contentsRead: boolean;
};
type Suggestion = {
	script: string;
	action: "run" | "build" | "test";
	runtime: "shell";
	invocation: string[];
	source: string;
	trusted: false;
};
const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

function sameFile(a: fs.Stats, b: fs.Stats) {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}
function rootIdentity(root: string) {
	const stat = fs.lstatSync(root);
	if (!stat.isDirectory() || fs.realpathSync(root) !== root)
		throw new Error("Discovery root changed or is not a canonical directory");
	return stat;
}
function readManifest(root: string, initialRoot: fs.Stats, evidence: Evidence) {
	const file = path.join(root, "package.json");
	const before = fs.lstatSync(file);
	if (!before.isFile() || before.size > 65536)
		throw new Error("Manifest is not a bounded regular file");
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd),
			currentRoot = rootIdentity(root);
		if (
			!opened.isFile() ||
			!sameFile(before, opened) ||
			currentRoot.dev !== initialRoot.dev ||
			currentRoot.ino !== initialRoot.ino
		)
			throw new Error("Discovery source changed");
		const buffer = Buffer.alloc(65537);
		let length = 0;
		while (length < buffer.length) {
			const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (!n) break;
			length += n;
		}
		if (
			length > 65536 ||
			!sameFile(opened, fs.fstatSync(fd)) ||
			!sameFile(opened, fs.lstatSync(file))
		)
			throw new Error("Discovery source changed or exceeded its limit");
		const afterRoot = rootIdentity(root);
		if (afterRoot.dev !== initialRoot.dev || afterRoot.ino !== initialRoot.ino)
			throw new Error("Discovery root changed");
		evidence.contentsRead = true;
		evidence.digest = digest(buffer.subarray(0, length));
		return record(JSON.parse(buffer.subarray(0, length).toString("utf8")));
	} finally {
		fs.closeSync(fd);
	}
}

/** Read-only root hints, never validation, authorization or executable definitions.
 * No traversal, link following, private configuration reads, CLI or engine probes.
 * Filesystem identity checks detect ordinary replacement; this is not an OS sandbox. */
export function discoverDefinitions(
	config: Config,
	repository: string,
	owner?: TaskInfo,
	directory = ".",
) {
	if (
		!config.repositories.includes(repository) ||
		(owner && owner.repository !== repository)
	)
		throw new Error(
			"Discovery requires an explicitly authorized repository; skill tasks may inspect only their own repository",
		);
	const base = owner?.workspace ?? repository;
	if (
		directory !== "." &&
		(typeof directory !== "string" ||
			directory.length > 200 ||
			directory.split("/").length > 4 ||
			directory
				.split("/")
				.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(part)))
	)
		throw new Error(
			"Discovery directory requires at most four public relative path segments, without traversal or dotfiles",
		);
	const root = directory === "." ? base : path.join(base, directory);
	let initialRoot: fs.Stats;
	try {
		rootIdentity(base);
		let parent = base;
		if (directory !== ".")
			for (const segment of directory.split("/")) {
				parent = path.join(parent, segment);
				rootIdentity(parent);
			}
		initialRoot = rootIdentity(root);
	} catch {
		throw new Error("Discovery source is unavailable or changed");
	}
	const evidence: Evidence[] = [],
		findings: string[] = [],
		suggestions: Suggestion[] = [];
	let manifest: Record<string, unknown> | null = null;
	for (const name of candidates) {
		const file = path.join(root, name);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				evidence.push({
					path: name,
					state: "unavailable",
					contentsRead: false,
				});
			continue;
		}
		const entry: Evidence = {
			path: name,
			state: stat.isSymbolicLink()
				? "symlink-not-followed"
				: stat.isFile()
					? "regular"
					: "nonregular",
			...(stat.isFile() ? { bytes: stat.size } : {}),
			contentsRead: false,
		};
		evidence.push(entry);
		if (name === "package.json" && entry.state === "regular") {
			try {
				manifest = readManifest(root, initialRoot, entry);
				if (!manifest)
					findings.push(
						"package.json must contain a JSON object; no suggestions inferred.",
					);
			} catch {
				findings.push(
					"package.json was unreadable, malformed, replaced or exceeded 64 KiB; values/errors are withheld.",
				);
			}
		}
	}
	try {
		const current = rootIdentity(root);
		if (current.dev !== initialRoot.dev || current.ino !== initialRoot.ino)
			throw new Error("changed");
	} catch {
		throw new Error("Discovery root changed during inspection");
	}
	const locks = [
		...new Set(
			evidence
				.filter((file) => file.state === "regular")
				.flatMap((file) =>
					lockManagers[file.path] ? [lockManagers[file.path]] : [],
				),
		),
	];
	const declared =
		typeof manifest?.packageManager === "string"
			? /^(bun|npm|pnpm|yarn)@[A-Za-z0-9.+_-]{1,128}$/.exec(
					manifest.packageManager,
				)?.[1]
			: undefined;
	let manager: string | null = null;
	if (manifest && manifest.packageManager !== undefined && !declared)
		findings.push(
			"Unrecognized packageManager declaration; no package-script invocations inferred.",
		);
	else if (
		locks.length > 1 ||
		(declared && locks.some((manager) => manager !== declared))
	)
		findings.push(
			"Conflicting package-manager evidence; choose explicitly before authoring targets.",
		);
	else manager = declared ?? locks[0] ?? null;
	if (manifest && !manager && !findings.length)
		findings.push(
			"No unambiguous package-manager evidence; no npm/Bun default is invented.",
		);
	if (manifest && manager) {
		const scripts = record(manifest.scripts);
		if (manifest.scripts !== undefined && !scripts)
			findings.push(
				"Package scripts must be an object; no script bodies are returned.",
			);
		for (const [name, body] of Object.entries(scripts ?? {}).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			if (
				!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(name) ||
				typeof body !== "string" ||
				!body.trim()
			)
				continue;
			const action = /^(dev|start|serve)(:|$)/.test(name)
				? "run"
				: /^build(:|$)/.test(name)
					? "build"
					: /^test(:|$)/.test(name)
						? "test"
						: null;
			if (action)
				suggestions.push({
					script: name,
					action,
					runtime: "shell",
					invocation: [manager, "run", name],
					source: "package.json",
					trusted: false,
				});
		}
	}
	const totalSuggestions = suggestions.length;
	suggestions.splice(24);
	const report = {
		source: {
			repository,
			root,
			directory,
			kind: owner ? "native-task-workspace" : "developer-checkout",
		},
		configuration: {
			file: path.join(config.configDir, "environments.json"),
			format: "native-environments-v1",
			written: false,
		},
		coverage:
			"Fixed manifest/lock/container/build-file names in one explicitly selected directory (root by default). Only package.json contents are read; no scripts are executed, and script bodies are withheld. Private .env/provider files are never inspected. Symlinks and other file contents are not followed/read. No recursive traversal or automatic nested-layout inference. Profiles, services, ports, readiness and compatibility are not inferred. Metadata may change immediately after observation; digests are observations, not approved validation or promotion authority. Not an OS sandbox.",
		evidence,
		packageManager: manager,
		suggestions,
		omittedSuggestions: totalSuggestions - suggestions.length,
		findings,
	};
	while (
		Buffer.byteLength(JSON.stringify(report)) > 12000 &&
		suggestions.length
	) {
		suggestions.pop();
		report.omittedSuggestions++;
	}
	if (Buffer.byteLength(JSON.stringify(report)) > 12000)
		throw new Error("Discovery metadata exceeds the bounded response budget");
	return report;
}
