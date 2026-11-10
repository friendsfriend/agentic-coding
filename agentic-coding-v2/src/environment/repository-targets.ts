import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import type { TaskInfo } from "../state.ts";
import type { Action } from "./selection.ts";

export type RepositoryTargetHint = {
	profile: string;
	action: Action;
	invocation: string[];
	source: string;
	trusted: false;
	readiness?: "process-start-only";
};
const names = [
	"package.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package-lock.json",
	"go.mod",
	"Cargo.toml",
	"pom.xml",
	"gradlew",
	"build.gradle",
	"build.gradle.kts",
	"pyproject.toml",
	"uv.lock",
	"Makefile",
	"makefile",
	"justfile",
	"Justfile",
	"Taskfile.yml",
	"Taskfile.yaml",
	"Taskfile",
];
const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
function rootIdentity(root: string) {
	const stat = fs.lstatSync(root);
	if (!stat.isDirectory() || fs.realpathSync(root) !== root)
		throw new Error(
			"Repository target discovery requires canonical directories",
		);
	return `${stat.dev}:${stat.ino}`;
}
function stamp(stat: fs.Stats) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
/** Fixed public repository filenames only. Invocations are untrusted metadata,
 * never executed or promoted here. v1 precedence/fallback is explicit migration
 * compatibility, not the default policy of native discovery. */
export function discoverRepositoryTargets(
	config: Config,
	repository: string,
	owner?: TaskInfo,
	directory = ".",
	compatibility: "strict" | "v1" = "strict",
) {
	if (
		!config.repositories.includes(repository) ||
		(owner && owner.repository !== repository)
	)
		throw new Error(
			"Repository target discovery requires an authorized native repository/workspace",
		);
	if (
		directory !== "." &&
		(directory.length > 200 ||
			directory.split("/").length > 4 ||
			directory
				.split("/")
				.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(part)))
	)
		throw new Error("Invalid public discovery directory");
	let root = owner?.workspace ?? repository;
	rootIdentity(root);
	if (directory !== ".")
		for (const segment of directory.split("/")) {
			root = path.join(root, segment);
			rootIdentity(root);
		}
	const initial = rootIdentity(root),
		files = new Map<string, fs.Stats>(),
		blocked = new Set<string>(),
		findings: string[] = [],
		targets: RepositoryTargetHint[] = [],
		evidence: {
			path: string;
			bytes: number;
			digest?: string;
			contentsRead: boolean;
		}[] = [];
	for (const name of names) {
		try {
			const stat = fs.lstatSync(path.join(root, name));
			if (stat.isFile() && !stat.isSymbolicLink()) {
				files.set(name, stat);
				evidence.push({ path: name, bytes: stat.size, contentsRead: false });
			} else {
				blocked.add(name);
				findings.push(`${name}: nonregular/symlink input was not followed`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				blocked.add(name);
				findings.push(`${name}: source unavailable`);
			}
		}
	}
	const read = (name: string) => {
		const before = files.get(name),
			file = path.join(root, name);
		if (!before || before.size > 65536)
			throw new Error("Public metadata exceeds its bound");
		const fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const opened = fs.fstatSync(fd);
			if (
				!opened.isFile() ||
				stamp(before) !== stamp(opened) ||
				rootIdentity(root) !== initial
			)
				throw new Error("Public metadata changed");
			const buffer = Buffer.alloc(65537);
			let length = 0;
			while (length < buffer.length) {
				const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
				if (!n) break;
				length += n;
			}
			if (
				length > 65536 ||
				stamp(opened) !== stamp(fs.fstatSync(fd)) ||
				stamp(opened) !== stamp(fs.lstatSync(file)) ||
				rootIdentity(root) !== initial
			)
				throw new Error("Public metadata changed or exceeded its bound");
			const entry = evidence.find((entry) => entry.path === name);
			if (entry) {
				entry.contentsRead = true;
				entry.digest = digest(buffer.subarray(0, length));
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, length),
			);
		} finally {
			fs.closeSync(fd);
		}
	};
	const add = (
		profile: string,
		action: Action,
		invocation: string[],
		source: string,
	) =>
		targets.push({
			profile,
			action,
			invocation,
			source,
			trusted: false,
			...(action === "run" ? { readiness: "process-start-only" as const } : {}),
		});
	const actions = ["build", "test", "run"] as const;
	if (files.has("package.json")) {
		try {
			const manifest = object(JSON.parse(read("package.json")));
			if (!manifest) throw new Error("Object required");
			const scripts = object(manifest.scripts) ?? {};
			const declaration =
				typeof manifest.packageManager === "string"
					? /^(bun|npm|pnpm|yarn)(?:@[A-Za-z0-9.+_-]{1,128})?$/.exec(
							manifest.packageManager,
						)?.[1]
					: undefined;
			const locks = [
				...new Set(
					[
						["bun.lock", "bun"],
						["bun.lockb", "bun"],
						["pnpm-lock.yaml", "pnpm"],
						["yarn.lock", "yarn"],
						["package-lock.json", "npm"],
					].flatMap(([file, manager]) =>
						file && manager && files.has(file) ? [manager] : [],
					),
				),
			];
			let manager: string | undefined;
			if (
				[
					"bun.lock",
					"bun.lockb",
					"pnpm-lock.yaml",
					"yarn.lock",
					"package-lock.json",
				].some((name) => blocked.has(name))
			)
				findings.push(
					"Nonregular package-manager evidence requires explicit reconciliation; no package target inferred",
				);
			else if (manifest.packageManager !== undefined && !declaration)
				findings.push(
					"Unrecognized package manager; no package target inferred",
				);
			else if (compatibility === "v1") {
				manager = declaration ?? locks[0] ?? "npm";
				if (!declaration && !locks.length)
					findings.push(
						"Explicit v1 migration compatibility uses the v1 npm fallback; this is not native strict discovery policy",
					);
				if (locks.some((lock) => lock !== manager))
					findings.push(
						"Explicit v1 migration compatibility preserves declared/lock precedence despite competing locks",
					);
			} else if (
				locks.length > 1 ||
				(declaration && locks.some((lock) => lock !== declaration))
			)
				findings.push(
					"Conflicting package-manager evidence; explicit selection required",
				);
			else manager = declaration ?? locks[0];
			if (manager)
				for (const action of actions) {
					const script =
						action === "run"
							? typeof scripts.dev === "string"
								? "dev"
								: "start"
							: action;
					if (typeof scripts[script] === "string")
						add(
							`package-${manager}`,
							action,
							manager === "yarn" ? [manager, script] : [manager, "run", script],
							"package.json",
						);
					else if (action === "test" && manager === "bun")
						add("package-bun", "test", ["bun", "test"], "package.json");
				}
		} catch {
			findings.push(
				"package.json unavailable, malformed, replaced or above 64 KiB; values withheld",
			);
		}
	}
	if (files.has("go.mod"))
		for (const action of actions)
			add(
				"go",
				action,
				["go", action, action === "run" ? "." : "./..."],
				"go.mod",
			);
	if (files.has("Cargo.toml"))
		for (const action of actions)
			add("cargo", action, ["cargo", action], "Cargo.toml");
	if (files.has("pom.xml")) {
		add("maven", "build", ["mvn", "package"], "pom.xml");
		add("maven", "test", ["mvn", "test"], "pom.xml");
	}
	let gradle: string | undefined;
	for (const name of ["gradlew", "build.gradle", "build.gradle.kts"]) {
		if (blocked.has(name)) break;
		if (files.has(name)) {
			gradle = name;
			break;
		}
	}
	if (gradle)
		for (const action of actions)
			add(
				"gradle",
				action,
				[gradle === "gradlew" ? "./gradlew" : "gradle", action],
				gradle,
			);
	if (files.has("pyproject.toml")) {
		const command = files.has("uv.lock") ? "uv" : "poetry";
		add(command, "build", [command, "build"], "pyproject.toml");
		add(command, "test", [command, "run", "pytest"], "pyproject.toml");
	}
	for (const recipe of [
		{ files: ["Makefile", "makefile"], command: "make", prefix: "" },
		{ files: ["justfile", "Justfile"], command: "just", prefix: "" },
		{
			files: ["Taskfile.yml", "Taskfile.yaml", "Taskfile"],
			command: "task",
			prefix: "  ",
		},
	]) {
		for (const name of recipe.files) {
			if (blocked.has(name)) break;
			if (!files.has(name)) continue;
			try {
				const lines = read(name).split(/\r?\n/);
				const found = actions.filter((action) =>
					lines.some((line) => line.startsWith(`${recipe.prefix}${action}:`)),
				);
				if (!found.length) continue;
				for (const action of found)
					add(recipe.command, action, [recipe.command, action], name);
				break;
			} catch {
				findings.push(
					`${name}: public recipe metadata unavailable, replaced or above 64 KiB; values withheld`,
				);
				break;
			}
		}
	}
	if (rootIdentity(root) !== initial)
		throw new Error("Repository changed during target discovery");
	return {
		compatibility,
		targets,
		evidence,
		findings,
		authority: "untrusted-read-only-observations",
		executed: false,
		written: false,
	};
}
