import fs from "node:fs";
import path from "node:path";
import { digest } from "./config.ts";

export async function git(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", "--no-optional-locks", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const [output, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args[0]} failed: ${error.trim()}`);
	return output;
}
export function contained(root: string, requested: string): string {
	const target = path.resolve(root, requested);
	const relative = path.relative(root, target);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		relative.split(path.sep).includes(".git")
	)
		throw new Error("Path outside task workspace");
	// Validate existing ancestors too: deleted paths are valid review targets.
	let existing = target;
	while (!fs.existsSync(existing)) existing = path.dirname(existing);
	const actual = fs.realpathSync(existing);
	if (actual !== root && !actual.startsWith(`${root}${path.sep}`))
		throw new Error("Symlink leaves task workspace");
	return target;
}
export async function prepareWorkspace(
	repository: string,
	stateDir: string,
	id: number,
	baseCommit: string,
): Promise<string> {
	const target = path.join(stateDir, "worktrees", String(id));
	const branch = `agentic-coding-v2/task-${digest(stateDir).slice(0, 8)}-${id}`;
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	if (fs.existsSync(target)) {
		if (
			fs.realpathSync(
				(await git(target, ["rev-parse", "--show-toplevel"])).trim(),
			) !== fs.realpathSync(target) ||
			(await git(target, ["branch", "--show-current"])).trim() !== branch
		)
			throw new Error("Workspace identity mismatch");
		const expected = (
			await git(repository, ["rev-parse", "--git-common-dir"])
		).trim();
		const found = (await git(target, ["rev-parse", "--git-common-dir"])).trim();
		if (
			fs.realpathSync(path.resolve(repository, expected)) !==
			fs.realpathSync(path.resolve(target, found))
		)
			throw new Error("Workspace belongs to another repository");
		return fs.realpathSync(target);
	}
	await git(repository, ["worktree", "add", "-b", branch, target, baseCommit]);
	return fs.realpathSync(target);
}
export async function gitOverview(workspace: string) {
	try {
		return {
			workspace,
			status: await git(workspace, ["status", "--short", "--branch"]),
			error: null,
		};
	} catch (error) {
		return { workspace, status: null, error: String(error) };
	}
}
export async function captureReview(
	workspace: string,
	requested: string,
): Promise<{ snapshot: string; digest: string }> {
	const target = contained(workspace, requested);
	const relative = path.relative(workspace, target) || ".";
	let snapshot = await git(workspace, [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--binary",
		"HEAD",
		"--",
		relative,
	]);
	const untracked = await git(workspace, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		relative,
	]);
	for (const name of untracked.split("\0").filter(Boolean).sort()) {
		const file = contained(workspace, name);
		if (fs.lstatSync(file).isSymbolicLink())
			throw new Error(
				"Symlink review requires an explicit non-symlink artifact",
			);
		if (fs.statSync(file).size > 512_000)
			throw new Error("Review file exceeds 512 KB limit");
		const bytes = fs.readFileSync(file);
		if (bytes.includes(0))
			throw new Error(
				"Untracked binary review is not supported; use attach_image for screenshots",
			);
		snapshot += `\n--- /dev/null\n+++ ${name}\n${bytes
			.toString("utf8")
			.split("\n")
			.map((line) => `+${line}`)
			.join("\n")}\n`;
	}
	if (!snapshot) snapshot = `No changes against HEAD for ${relative}.\n`;
	if (Buffer.byteLength(snapshot) > 1_000_000)
		throw new Error("Review exceeds 1 MB; select a smaller path");
	return { snapshot, digest: digest(snapshot) };
}
