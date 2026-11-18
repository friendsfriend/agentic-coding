import fs from "node:fs";
import { git } from "./git.ts";

export function featureBranch(name: string, ticket?: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
		throw new Error("Branch name must be a lowercase kebab-case name");
	if (ticket !== undefined && !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(ticket))
		throw new Error("Ticket must contain letters, digits and hyphens");
	return `feature/${ticket ? `${ticket}-` : ""}${name}`;
}

/** Feature worktree creation uses Worktrunk. As in v1, automation disables
 * hooks, prompts and directory switching. No removal/force or shell escape hatch. */
export async function ensureFeatureWorktree(
	repository: string,
	branch: string,
	base = "HEAD",
	location?: string,
): Promise<{ path: string; branch: string }> {
	const environment = { ...process.env };
	for (const key of Object.keys(environment))
		if (key.startsWith("GIT_")) delete environment[key];
	const run = async (args: string[]) => {
		const child = Bun.spawn(
			[
				process.env.WORKTRUNK_BIN_PATH ?? "wt",
				"-C",
				repository,
				...(location
					? ["--config-set", `worktree-path=${JSON.stringify(location)}`]
					: []),
				...args,
			],
			{
				cwd: repository,
				env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			throw new Error(`Worktrunk failed: ${error.slice(0, 4000)}`);
		if (output.length > 1_000_000)
			throw new Error("Worktrunk response too large");
		return JSON.parse(output);
	};
	// Resolve before creating: replay never creates another branch/worktree, and
	// a name already checked out elsewhere is reused without resetting its HEAD.
	const listed = await run(["list", "--format", "json"]);
	if (!Array.isArray(listed.items))
		throw new Error("Invalid Worktrunk list response");
	const existing = listed.items.find(
		(item: { branch?: string }) => item.branch === branch,
	);
	let target = existing?.worktree?.path;
	if (!target) {
		const refs = await git(repository, [
			"for-each-ref",
			"--format=%(refname)",
			`refs/heads/${branch}`,
		]);
		const reply = await run([
			"switch",
			...(refs.trim() ? [] : ["--create", "--base", base]),
			branch,
			"--no-cd",
			"--no-hooks",
			"-y",
			"--format",
			"json",
		]);
		target = reply.path;
	}
	if (typeof target !== "string")
		throw new Error("Worktrunk returned no worktree path");
	const resolved = fs.realpathSync(target);
	if ((await git(resolved, ["branch", "--show-current"])).trim() !== branch)
		throw new Error("Worktree branch identity mismatch");
	const common = async (cwd: string) =>
		(
			await git(cwd, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			])
		).trim();
	if ((await common(resolved)) !== (await common(repository)))
		throw new Error("Worktree repository identity mismatch");
	return { path: resolved, branch };
}
