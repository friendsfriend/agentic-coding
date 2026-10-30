import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
export interface LocalGitLabProject {
	readonly host: string;
	readonly project: string;
	readonly repository: string;
}
/** Only configured GitLab hosts are classified as GitLab; a random Git remote
 * or a guessed namespace must never expand collection scope. */
export function gitLabRemote(
	remote: string,
	hosts: readonly string[],
): { host: string; project: string } | undefined {
	let host: string, project: string;
	try {
		if (/^[^/@\s]+@[^:/\s]+:.+$/.test(remote)) {
			const colon = remote.indexOf(":");
			host = remote.slice(remote.indexOf("@") + 1, colon).toLowerCase();
			project = remote.slice(colon + 1);
		} else {
			const url = new URL(remote);
			if (
				!["https:", "ssh:"].includes(url.protocol) ||
				url.password ||
				url.search ||
				url.hash
			)
				return undefined;
			host = url.host.toLowerCase();
			project = url.pathname.slice(1);
		}
		project = project.replace(/\.git$/, "").replace(/\/$/, "");
		if (
			!hosts.some((candidate) => candidate.toLowerCase() === host) ||
			!/^[\w.-]+(?:\/[\w.-]+)+$/.test(project) ||
			project.split("/").some((part) => part === "." || part === "..")
		)
			return undefined;
		return { host, project };
	} catch {
		return undefined;
	}
}
export async function discoverLocalGitLabProjects(options: {
	roots: readonly string[];
	hosts: readonly string[];
	maxDepth?: number;
	maxDirectories?: number;
	remotes?: (repository: string) => Promise<readonly string[]>;
}): Promise<{
	projects: LocalGitLabProject[];
	truncated: boolean;
	diagnostics: string[];
}> {
	const projects = new Map<string, LocalGitLabProject>(),
		visited = new Set<string>(),
		diagnostics: string[] = [];
	const maxDepth = options.maxDepth ?? 4,
		maxDirectories = options.maxDirectories ?? 1000;
	if (
		!Number.isSafeInteger(maxDepth) ||
		maxDepth < 0 ||
		!Number.isSafeInteger(maxDirectories) ||
		maxDirectories < 1
	)
		throw new Error("Invalid repository discovery budget.");
	let truncated = false,
		entriesRead = 0;
	const runGit = promisify(execFile);
	const remotes =
		options.remotes ??
		(async (repository: string) => {
			let output: string;
			try {
				const result = await runGit(
					"git",
					[
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"core.fsmonitor=false",
						"-C",
						repository,
						"config",
						"--get-regexp",
						"^remote\\..*\\.url$",
					],
					{ encoding: "utf8", maxBuffer: 64_000, timeout: 5000 },
				);
				output = result.stdout;
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === 1
				)
					return [];
				throw new Error(
					"Repository remotes unavailable or exceeded read budget.",
				);
			}
			return output
				.split("\n")
				.filter(Boolean)
				.map((line) => line.slice(line.indexOf(" ") + 1));
		});
	async function walk(directory: string, depth: number): Promise<void> {
		let canonical: string;
		try {
			canonical = fs.realpathSync(directory);
		} catch {
			diagnostics.push("repository-root-unavailable");
			return;
		}
		if (visited.has(canonical)) return;
		if (visited.size >= maxDirectories) {
			truncated = true;
			return;
		}
		visited.add(canonical);
		try {
			if (fs.existsSync(path.join(canonical, ".git"))) {
				for (const remote of await remotes(canonical)) {
					const project = gitLabRemote(remote, options.hosts);
					if (project)
						projects.set(`${project.host}/${project.project}`, {
							...project,
							repository: canonical,
						});
				}
				return;
			}
			const directory = fs.opendirSync(canonical);
			try {
				for (
					let entry = directory.readSync();
					entry;
					entry = directory.readSync()
				) {
					if (++entriesRead > maxDirectories * 100) {
						truncated = true;
						break;
					}
					if (
						!entry.isDirectory() ||
						entry.isSymbolicLink() ||
						entry.name.startsWith(".") ||
						entry.name === "node_modules"
					)
						continue;
					if (depth >= maxDepth || visited.size >= maxDirectories) {
						truncated = true;
						break;
					}
					await walk(path.join(canonical, entry.name), depth + 1);
				}
			} finally {
				directory.closeSync();
			}
		} catch {
			diagnostics.push("repository-enumeration-or-remotes-unavailable");
		}
	}
	for (const root of options.roots) {
		if (
			!path.isAbsolute(root) ||
			path.parse(root).root === path.resolve(root)
		) {
			diagnostics.push("unsafe-or-unbounded-discovery-root-denied");
			continue;
		}
		await walk(root, 0);
	}
	return {
		projects: [...projects.values()].sort((a, b) =>
			`${a.host}/${a.project}`.localeCompare(`${b.host}/${b.project}`),
		),
		truncated,
		diagnostics: [...new Set(diagnostics)],
	};
}
