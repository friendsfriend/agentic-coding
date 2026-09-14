// Git capability for the Bun backend, ported from `server/pkg/git/repository.go`
// (`port-git-providers-and-ai-to-bun`, tasks 2.2-2.4).
//
// Differences from the Go implementation, each deliberate:
//   - Every operation runs native `git` argv. The Go version mixed go-git with
//     native git (only the instrumented path used native git); argv avoids the
//     go-git worktree limitations the Go code worked around and never
//     interpolates user data into a shell.
//   - `git reset --hard`/`switch` do not touch ignored files, so the Go
//     implementation's ignored-file backup dance is unnecessary here.
//   - Linked worktrees are created with `git worktree add` instead of
//     worktrunk (`wt`); the path layout, tracking-branch behavior and
//     primary-worktree protection are the observable contract and are pinned
//     by the cross-runtime fixtures in `test/fixtures/integrations/git`.
//   - `push` names `HEAD` explicitly instead of relying on `push.default` and
//     a configured upstream.
// Credentials travel as `-c` config argv (never a shell string) and are
// redacted from every diagnostic and recorded command.
import fs from "node:fs";
import path from "node:path";

export interface GitApp {
	readonly ident: string;
	readonly repositoryPath: string;
	readonly localDirectoryPath: string;
	readonly branch: string;
	readonly mainWorktreeBranch?: string;
}

export interface WorktreeInfo {
	readonly branch: string;
	readonly path: string;
	readonly isMain: boolean;
	readonly active: boolean;
}

export interface GitCredentials {
	readonly username: string;
	readonly token: string;
}

/** Resolves per-URL credentials; an absent resolver means "no credentials". */
export type GitAuthResolver = (repositoryUrl: string) => GitCredentials;

export interface GitCommandResult {
	readonly command: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export class GitError extends Error {
	readonly code = "git";
	constructor(message: string) {
		super(message);
		this.name = "GitError";
	}
}

export interface GitRepositoryOptions {
	readonly auth?: GitAuthResolver;
	readonly logger?: (message: string) => void;
}

export class GitRepository {
	private readonly auth?: GitAuthResolver;
	private readonly logger: (message: string) => void;

	constructor(options: GitRepositoryOptions = {}) {
		this.auth = options.auth;
		this.logger = options.logger ?? (() => {});
	}

	// ---- Command boundary ----

	/**
	 * Run one `git` invocation in `dir`. `config` entries are `-c` values (only
	 * ever a credential header) and are redacted from the recorded command, so
	 * a token can never reach a log, an event or a run tree.
	 */
	run(
		dir: string,
		args: readonly string[],
		config: readonly string[] = [],
	): GitCommandResult {
		const displayConfig = config.map((entry) => {
			const separator = entry.indexOf("=");
			return separator < 0
				? "<redacted>"
				: `${entry.slice(0, separator)}=<redacted>`;
		});
		const result = Bun.spawnSync(
			["git", "-C", dir, ...config.flatMap((entry) => ["-c", entry]), ...args],
			{ stdout: "pipe", stderr: "pipe" },
		);
		return {
			command: ["git", "-C", dir, ...displayConfig, ...args].join(" "),
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			exitCode: result.exitCode ?? 1,
		};
	}

	/** Run argv and fail with the recorded command plus stderr on a non-zero
	 * exit, so a caller never has to re-derive the diagnostic. */
	private must(
		dir: string,
		args: readonly string[],
		config: readonly string[] = [],
	): string {
		const result = this.run(dir, args, config);
		if (result.exitCode !== 0)
			throw new GitError(
				`${result.command} failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`,
			);
		return result.stdout;
	}

	/** Credential config for a repository URL; empty without credentials. Public
	 * so the private Git adapter applies the same credential boundary. */
	credentialConfig(repositoryUrl: string): string[] {
		const credentials = this.auth?.(repositoryUrl);
		if (!credentials || credentials.username === "" || credentials.token === "")
			return [];
		const basic = Buffer.from(
			`${credentials.username}:${credentials.token}`,
			"utf8",
		).toString("base64");
		return [`http.extraheader=Authorization: Basic ${basic}`];
	}

	// ---- Paths ----

	/** `$DEVENV_HOME/{ident}/{ident}` — the primary worktree. */
	primaryWorktreeDir(app: GitApp): string {
		return path.join(path.dirname(app.localDirectoryPath), app.ident);
	}

	/** `$DEVENV_HOME/{ident}/{ident}.{sanitized-branch}` — worktrunk's default
	 * path template, reproduced natively. */
	linkedWorktreeDir(app: GitApp, branch: string): string {
		const safe = branch.replaceAll("/", "-").replaceAll("\\", "-");
		return path.join(
			path.dirname(app.localDirectoryPath),
			`${app.ident}.${safe}`,
		);
	}

	// ---- Reads ----

	/** Remote branch names (`git ls-remote --heads`). */
	getBranches(repositoryUrl: string): string[] {
		const stdout = this.must(
			".",
			["ls-remote", "--heads", repositoryUrl],
			this.credentialConfig(repositoryUrl),
		);
		const branches: string[] = [];
		for (const line of stdout.split("\n")) {
			const ref = line.split("\t")[1]?.trim() ?? "";
			if (!ref.startsWith("refs/heads/")) continue;
			branches.push(ref.slice("refs/heads/".length));
		}
		return branches;
	}

	getLocalBranches(app: GitApp): string[] {
		const stdout = this.must(app.localDirectoryPath, [
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}

	/** The branch HEAD points at, read from the worktree's HEAD file. A linked
	 * worktree keeps `.git` as a `gitdir:` pointer file. */
	getCurrentBranch(app: GitApp): string {
		if (app.localDirectoryPath === "") return "";
		return currentBranchAtPath(app.localDirectoryPath);
	}

	/** `x` when there is no checkout, `error` when Git cannot report, otherwise
	 * `+added ~changed -removed` or `✓`. */
	getStatus(app: GitApp): string {
		if (app.localDirectoryPath === "") return "x";
		if (!fs.existsSync(path.join(app.localDirectoryPath, ".git"))) return "x";
		const result = this.run(app.localDirectoryPath, [
			"status",
			"--porcelain",
			"-z",
		]);
		if (result.exitCode !== 0) return "error";
		let added = 0;
		let changed = 0;
		let removed = 0;
		const entries = result.stdout.split("\0");
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry === "") continue;
			const x = entry[0];
			const y = entry[1];
			if (x === "R" || x === "C" || y === "R" || y === "C") i += 1; // rename/copy source entry
			// Removed wins over added wins over changed, matching the Go counts.
			if (x === "D" || y === "D") removed += 1;
			else if (x === "?" || x === "A") added += 1;
			else if (x === "M" || y === "M") changed += 1;
		}
		const parts: string[] = [];
		if (added > 0) parts.push(`+${added}`);
		if (changed > 0) parts.push(`~${changed}`);
		if (removed > 0) parts.push(`-${removed}`);
		return parts.length > 0 ? parts.join(" ") : "✓";
	}

	// ---- Mutations ----

	fetch(app: GitApp): void {
		this.must(
			app.localDirectoryPath,
			["fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"],
			this.credentialConfig(app.repositoryPath),
		);
	}

	/** Fetch the current branch and hard-reset onto its remote ref. */
	pull(app: GitApp): void {
		const branch = this.must(app.localDirectoryPath, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]).trim();
		this.fetch(app);
		this.must(app.localDirectoryPath, ["reset", "--hard", `origin/${branch}`]);
	}

	push(app: GitApp): void {
		this.must(
			app.localDirectoryPath,
			["push", "origin", "HEAD"],
			this.credentialConfig(app.repositoryPath),
		);
	}

	/**
	 * Switch to `branch`, cloning first when the checkout does not exist yet.
	 * A branch that only exists on the remote becomes a local tracking branch;
	 * a branch that exists nowhere is created from the current HEAD.
	 */
	checkout(app: GitApp, branch: string): void {
		const dir = app.localDirectoryPath;
		if (!fs.existsSync(path.join(dir, ".git"))) {
			this.must(
				".",
				["clone", "--branch", branch, app.repositoryPath, dir],
				this.credentialConfig(app.repositoryPath),
			);
			return;
		}
		this.assertClean(app, "repository has uncommitted changes");
		if (this.localBranchExists(app, branch)) {
			this.must(dir, ["switch", branch]);
			return;
		}
		if (this.remoteBranchExists(app, branch)) {
			this.must(dir, ["switch", "-c", branch, "--track", `origin/${branch}`]);
			return;
		}
		this.must(dir, ["switch", "-c", branch]);
	}

	/**
	 * Ensure the checkout exists on its configured branch and is up to date.
	 * Returns an empty string: the Go implementation only ever reported a
	 * resolved branch from the worktree clone path, never from here.
	 */
	updateOrCreateRepo(app: GitApp): string {
		if (!isDirectory(app.localDirectoryPath)) this.checkout(app, app.branch);
		if (!fs.existsSync(path.join(app.localDirectoryPath, ".git")))
			throw new GitError("directory exists but is not a git repository");
		this.switchAndPullBranch(app);
		return "";
	}

	private switchAndPullBranch(app: GitApp): void {
		const dir = app.localDirectoryPath;
		this.assertClean(app, "repository has local changes");
		if (!this.localBranchExists(app, app.branch)) {
			if (!this.remoteBranchExists(app, app.branch))
				throw new GitError(
					`failed to get remote reference for branch ${app.branch}`,
				);
			this.must(dir, [
				"switch",
				"-c",
				app.branch,
				"--track",
				`origin/${app.branch}`,
			]);
		}
		this.fetch(app);
		this.must(dir, ["reset", "--hard", `origin/${app.branch}`]);
		this.must(dir, ["switch", app.branch]);
	}

	// ---- Worktrees ----

	listWorktrees(app: GitApp): WorktreeInfo[] {
		const primaryDir = this.primaryWorktreeDir(app);
		if (!fs.existsSync(path.join(primaryDir, ".git"))) return [];
		const stdout = this.must(primaryDir, ["worktree", "list", "--porcelain"]);
		const activePath = app.localDirectoryPath;
		const results: WorktreeInfo[] = [];
		let current = { path: "", branch: "" };
		let isFirst = true;
		const flush = () => {
			if (current.path === "") return;
			results.push({
				branch: current.branch,
				path: current.path,
				isMain: isFirst,
				active: current.path === activePath,
			});
			current = { path: "", branch: "" };
			isFirst = false;
		};
		for (const rawLine of stdout.split("\n")) {
			const line = rawLine.trim();
			if (line === "") {
				flush();
				continue;
			}
			if (line.startsWith("worktree "))
				current.path = line.slice("worktree ".length);
			else if (line.startsWith("branch refs/heads/"))
				current.branch = line.slice("branch refs/heads/".length);
		}
		flush();
		return results;
	}

	/**
	 * Create (or reuse) the linked worktree for `branch` and return its path.
	 * A branch already checked out in the primary worktree resolves to the
	 * primary worktree itself, so a workflow pin is never retargeted.
	 */
	addWorktree(app: GitApp, branch: string): string {
		const primaryDir = this.primaryWorktreeDir(app);
		const targetDir = this.linkedWorktreeDir(app, branch);
		if (isDirectory(targetDir)) return targetDir;

		if (!fs.existsSync(path.join(primaryDir, ".git"))) {
			const mainBranch =
				app.mainWorktreeBranch && app.mainWorktreeBranch !== ""
					? app.mainWorktreeBranch
					: app.branch;
			fs.mkdirSync(path.dirname(primaryDir), { recursive: true, mode: 0o755 });
			this.cloneIntoPrimaryWorktree(app, primaryDir, mainBranch);
		}
		if (currentBranchAtPath(primaryDir) === branch) {
			this.logger(
				`[INFO] devenv: branch ${JSON.stringify(branch)} is the primary worktree for ${JSON.stringify(app.ident)}, skipping linked worktree creation`,
			);
			return primaryDir;
		}
		if (!this.localBranchExists(app, branch)) {
			// The UI lists remote branches through `ls-remote`, which creates no
			// local remote-tracking ref; fetch so `worktree add` can create the
			// tracking branch it needs.
			try {
				this.fetch(app);
			} catch (error) {
				this.logger(
					`[WARN] devenv: fetch before worktree add failed: ${message(error)}`,
				);
			}
		}
		this.must(primaryDir, ["worktree", "add", targetDir, branch]);
		return targetDir;
	}

	removeWorktree(app: GitApp, branch: string): void {
		if (branch === (app.mainWorktreeBranch ?? ""))
			throw new GitError(
				`cannot remove the primary worktree (branch ${JSON.stringify(branch)})`,
			);
		const primaryDir = this.primaryWorktreeDir(app);
		const targetDir = this.linkedWorktreeDir(app, branch);
		this.must(primaryDir, ["worktree", "remove", "--force", targetDir]);
		this.run(primaryDir, ["worktree", "prune"]);
	}

	/** Clone the remote into the primary worktree, falling back to the remote's
	 * default branch when the configured branch does not exist there. */
	private cloneIntoPrimaryWorktree(
		app: GitApp,
		targetDir: string,
		branch: string,
	): string {
		fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
		const config = this.credentialConfig(app.repositoryPath);
		const result = this.run(
			".",
			["clone", "--branch", branch, app.repositoryPath, targetDir],
			config,
		);
		if (result.exitCode !== 0) {
			this.logger(
				`[WARN] devenv: branch ${JSON.stringify(branch)} not found on remote for ${JSON.stringify(app.ident)}, cloning remote default branch`,
			);
			this.must(".", ["clone", app.repositoryPath, targetDir], config);
			return this.resolveHeadBranch(app);
		}
		return branch;
	}

	private resolveHeadBranch(app: GitApp): string {
		const result = this.run(app.localDirectoryPath, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		if (result.exitCode !== 0) return "";
		const branch = result.stdout.trim();
		return branch === "HEAD" ? "" : branch;
	}

	// ---- Local helpers ----

	private assertClean(app: GitApp, reason: string): void {
		const result = this.run(app.localDirectoryPath, ["status", "--porcelain"]);
		if (result.exitCode !== 0)
			throw new GitError(
				`${result.command} failed: ${firstLine(result.stderr)}`,
			);
		if (result.stdout.trim() !== "") throw new GitError(reason);
	}

	private localBranchExists(app: GitApp, branch: string): boolean {
		const result = this.run(app.localDirectoryPath, [
			"branch",
			"--list",
			"--format=%(refname:short)",
			branch,
		]);
		return result.stdout.trim() !== "";
	}

	private remoteBranchExists(app: GitApp, branch: string): boolean {
		const result = this.run(app.localDirectoryPath, [
			"branch",
			"--remote",
			"--list",
			"--format=%(refname:short)",
			`origin/${branch}`,
		]);
		return result.stdout.trim() !== "";
	}
}

/** The HEAD file of a primary worktree or a linked worktree, or `null` when
 * the path is not a Git checkout. */
export function headFilePath(localDirectoryPath: string): string | null {
	const gitPath = path.join(localDirectoryPath, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(gitPath);
	} catch {
		return null;
	}
	if (stat.isDirectory()) return path.join(gitPath, "HEAD");
	let pointer: string;
	try {
		pointer = fs.readFileSync(gitPath, "utf8").trim();
	} catch {
		return null;
	}
	if (!pointer.startsWith("gitdir: ")) return null;
	const gitDir = pointer.slice("gitdir: ".length);
	return path.join(
		path.isAbsolute(gitDir) ? gitDir : path.join(localDirectoryPath, gitDir),
		"HEAD",
	);
}

/** The branch name a checkout's HEAD file points at, or `""`. */
export function currentBranchAtPath(dir: string): string {
	const headFile = headFilePath(dir);
	if (headFile === null) return "";
	try {
		const head = fs.readFileSync(headFile, "utf8").trim();
		return head.startsWith("ref: refs/heads/")
			? head.slice("ref: refs/heads/".length)
			: "";
	} catch {
		return "";
	}
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
