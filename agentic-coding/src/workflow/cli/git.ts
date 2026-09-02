// Thin `git -C <repo>` exec wrapper shared by the CLI. Moved verbatim out of
// cli.ts (split-workflow-god-modules).
export function runGit(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			(result.stderr.toString() || result.stdout.toString()).trim(),
		);
	return result.stdout.toString().trim();
}
