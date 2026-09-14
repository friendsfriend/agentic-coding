// Live filesystem/Git boundary for the configured-project catalog.
//
// The projection itself is pure (`config.ts`); this module answers its bounded
// read-only questions about a checkout. It never creates, migrates or writes
// anything — availability observation must not mutate the environment.
import fs from "node:fs";
import path from "node:path";
import type { CatalogObservation } from "./config.ts";

/** `git rev-parse --path-format=absolute --git-common-dir` with the older
 * relative-common-dir form as fallback, so every linked worktree of one
 * repository resolves to the same canonical root. */
export function resolveCanonicalRoot(
	checkout: string,
): { root: string } | { error: string } {
	if (!checkout) return { error: "no checkout path" };
	const absolute = Bun.spawnSync(
		[
			"git",
			"-C",
			checkout,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let commonDir =
		absolute.exitCode === 0 ? absolute.stdout.toString().trim() : "";
	if (!commonDir) {
		const relative = Bun.spawnSync(
			["git", "-C", checkout, "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (relative.exitCode !== 0) return { error: "not a Git repository" };
		commonDir = relative.stdout.toString().trim();
		if (!commonDir)
			return { error: "Git common directory could not be resolved" };
		if (!path.isAbsolute(commonDir))
			commonDir = path.resolve(checkout, commonDir);
	}
	const resolved = path.resolve(commonDir);
	if (path.basename(resolved) === ".git")
		return { root: path.dirname(resolved) };
	return { root: resolved };
}

/** Bounded OpenSpec-configuration read; creates nothing. */
export function openspecConfigured(root: string): boolean {
	if (!root) return false;
	try {
		return fs.statSync(path.join(root, "openspec", "config.yaml")).isFile();
	} catch {
		return false;
	}
}

export const liveCatalogObservation: CatalogObservation = {
	pathKind(target) {
		try {
			return fs.statSync(target).isDirectory() ? "directory" : "not-directory";
		} catch {
			return "missing";
		}
	},
	resolveCanonicalRoot,
	openspecConfigured,
};
