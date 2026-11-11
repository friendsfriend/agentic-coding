import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import { git } from "../git.ts";
import { findProvider, providerToken } from "../providers/config.ts";
import { Refusal } from "../server/refusal.ts";
import type { Settings } from "../settings.ts";
import { Catalog, type TaskInfo, values } from "../state.ts";
import { validateProjects } from "./catalog.ts";
import { definitionByteLimit } from "./definition-limits.ts";
import { locked } from "./definition-promotion.ts";
import type { Environments } from "./manager.ts";
import type { Project } from "./model.ts";
import { within } from "./path-within.ts";

/** v1's ident rule (Go slugify) restricted to v2's identifier grammar. */
export function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type Clone = { state: "cloning" | "failed"; message?: string };

/** The restored v1 add-repository and remove-repository flows.
 *
 * Add mirrors v1: the app gets `$DEVENV_HOME/<ident>/<ident>`, is cloned at the
 * chosen branch and appears in the table at once. v2 additionally:
 * - authorizes the checkout in `config.json` and registers a definition-less
 *   project in `environments.json` (targets come later through the normal
 *   definition review);
 * - never adopts an existing directory;
 * - clones through the serving provider's HTTPS origin with the token only in
 *   a one-shot credential helper environment, never in an argument or config.
 *
 * Remove mirrors v1 (delete the definition and the local directory) but only
 * for a project v2 registered itself under `$DEVENV_HOME/<ident>/`, with a
 * clean checkout, no native run or task using it and no other project or
 * cluster referencing it. Anything else is refused, never forced. */
export class AppRegistry {
	private clones = new Map<string, Clone>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private config: Config,
		private environments: Environments,
		private settings: Settings,
		private store: () => Harness,
		private home = process.env.DEVENV_HOME ?? "",
	) {}
	/** Checkouts being cloned (or that failed) for the table. */
	pending() {
		return Object.fromEntries(this.clones);
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		// The developer sees the reason (paths and Git diagnostics, no secrets).
		const visible = () =>
			action().catch((error: unknown) => {
				throw error instanceof Refusal
					? error
					: new Refusal(
							String(error instanceof Error ? error.message : error).slice(
								0,
								600,
							),
						);
			});
		const next = this.queue.then(visible, visible);
		this.queue = next.catch(() => undefined);
		return next;
	}
	private root() {
		if (!this.home || !path.isAbsolute(this.home))
			throw new Refusal(
				"DEVENV_HOME is not set; v1 places repositories under $DEVENV_HOME/<ident>",
			);
		if (!fs.existsSync(this.home))
			throw new Refusal("DEVENV_HOME does not exist");
		return fs.realpathSync(this.home);
	}
	private catalogFile() {
		fs.mkdirSync(this.config.configDir, { recursive: true, mode: 0o700 });
		const directory = fs.realpathSync(this.config.configDir);
		const file = path.join(directory, "environments.json");
		if (fs.existsSync(file)) {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > definitionByteLimit)
				throw new Refusal(
					"environments.json must be a regular file of at most 256 KiB",
				);
		}
		return file;
	}
	private readCatalog(file: string) {
		if (!fs.existsSync(file))
			return { version: 1, projects: [] as Record<string, unknown>[] };
		const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
			version: number;
			projects: Record<string, unknown>[];
		};
		return data;
	}
	/** Validated atomic replace under the shared definition lock; the live
	 * catalog is updated in place only after the file verifies. */
	private writeCatalog(
		file: string,
		change: (projects: Record<string, unknown>[]) => Record<string, unknown>[],
	) {
		return locked(file, () => {
			const data = this.readCatalog(file);
			const next = { ...data, projects: change(data.projects) };
			const projects = validateProjects(this.config, next);
			const bytes = `${JSON.stringify(next, null, 2)}\n`;
			if (Buffer.byteLength(bytes) > definitionByteLimit)
				throw new Refusal("environments.json would exceed 256 KiB");
			const temp = path.join(
				path.dirname(file),
				`.environments.${digest(bytes).slice(0, 24)}.tmp`,
			);
			const fd = fs.openSync(
				temp,
				fs.constants.O_WRONLY |
					fs.constants.O_CREAT |
					fs.constants.O_EXCL |
					fs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				fs.writeFileSync(fd, bytes);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			try {
				fs.renameSync(temp, file);
			} finally {
				fs.rmSync(temp, { force: true });
			}
			if (digest(fs.readFileSync(file)) !== digest(bytes))
				throw new Refusal(
					"environments.json did not verify after the write; restart before further changes",
				);
			(this.environments.projects as Project[]).splice(
				0,
				this.environments.projects.length,
				...projects,
			);
		});
	}
	private authorize(repository: string, add: boolean) {
		const before = [...this.config.repositories];
		const saved = this.settings.updateRepositories((repositories) =>
			add
				? [...repositories, repository]
				: repositories.filter((item) => item !== repository),
		);
		this.config.repositories.splice(
			0,
			this.config.repositories.length,
			...saved,
		);
		// v1's implicit shared kind cluster serves every authorized repository.
		const same = (a: string[], b: string[]) =>
			a.length === b.length && a.every((item) => b.includes(item));
		const implicit = this.environments.clusters.find(
			(cluster) =>
				cluster.id === "devenv" &&
				cluster.provision &&
				same(cluster.repositories, before),
		);
		implicit?.repositories.splice(
			0,
			implicit.repositories.length,
			...this.config.repositories,
		);
	}
	async create(input: Record<string, unknown>) {
		const displayName = text(input.displayName, "display name", 128).trim();
		const url = text(input.repositoryURL, "repository URL", 2048).trim();
		const branch = text(input.branch, "branch", 200).trim();
		const provider = findProvider(
			this.config.providers,
			text(input.provider, "provider", 64),
		);
		const kind = input.definitionLocation === "libraries" ? "library" : "app";
		const ident = slugify(displayName);
		if (!/^[a-z][a-z0-9-]*$/.test(ident) || ident.length > 64)
			throw new Refusal(
				"displayName must start with a letter and contain letters or digits",
			);
		if (branch.startsWith("-") || /[\s~^:?*[\\]/.test(branch))
			throw new Refusal("Invalid branch name");
		let remote: URL;
		try {
			remote = new URL(url);
		} catch {
			throw new Refusal("Repository URL must be an HTTPS clone URL");
		}
		const api = new URL(provider.baseUrl);
		const sameHost =
			remote.hostname === api.hostname ||
			(provider.type === "github" &&
				api.hostname === "api.github.com" &&
				remote.hostname === "github.com");
		const loopback = remote.hostname === "127.0.0.1";
		if (
			!sameHost ||
			remote.username ||
			remote.password ||
			remote.search ||
			remote.hash ||
			(remote.protocol !== "https:" &&
				!(loopback && remote.protocol === "http:"))
		)
			throw new Refusal(
				`Repository URL must be an HTTPS clone URL served by provider "${provider.name}"`,
			);
		return this.serial(async () => {
			if (this.environments.projects.some((project) => project.id === ident))
				throw new Refusal(`app with ident "${ident}" already exists`);
			const root = this.root();
			const container = path.join(root, ident);
			const checkout = path.join(container, ident);
			if (fs.existsSync(container))
				throw new Refusal(
					`${container} already exists; existing directories are never adopted`,
				);
			const file = this.catalogFile();
			if (within(checkout, file))
				throw new Refusal("The checkout cannot contain the configuration");
			fs.mkdirSync(checkout, { recursive: true, mode: 0o755 });
			const repository = fs.realpathSync(checkout);
			this.clones.set(ident, { state: "cloning" });
			try {
				this.authorize(repository, true);
				this.writeCatalog(file, (projects) => [
					...projects,
					{ id: ident, kind, repository, targets: [] },
				]);
			} catch (error) {
				this.clones.delete(ident);
				if (this.config.repositories.includes(repository))
					this.authorize(repository, false);
				fs.rmSync(container, { recursive: true, force: true });
				throw error instanceof Refusal
					? error
					: new Refusal(
							error instanceof Error ? error.message : "Registration failed",
						);
			}
			void this.clone(ident, repository, url, branch, provider.name);
			return {
				ident,
				displayName: ident,
				repositoryPath: repository,
				localDirectoryPath: repository,
				branch,
				mainWorktreeBranch: branch,
				activeWorktree: branch,
				appType: kind === "library" ? "LIB" : "APP",
				provider: provider.name,
				sourceType: provider.type,
				containerBaseName: ident,
				status: "stopped",
			};
		});
	}
	private async clone(
		ident: string,
		repository: string,
		url: string,
		branch: string,
		providerName: string,
	) {
		try {
			const provider = findProvider(this.config.providers, providerName);
			const token = providerToken(provider);
			// v1 sent the provider credential as a Basic header; v2 hands it to a
			// one-shot credential helper through the environment only.
			const helper = token
				? [
						"-c",
						"credential.helper=",
						"-c",
						`credential.helper=!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "\${AC_CLONE_USER}" "\${AC_CLONE_TOKEN}"; }; f`,
					]
				: [];
			const child = Bun.spawn(
				[
					"git",
					"-c",
					`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
					...helper,
					"clone",
					"--branch",
					branch,
					"--single-branch",
					"--no-tags",
					"--",
					url,
					repository,
				],
				{
					stdout: "ignore",
					stderr: "pipe",
					env: {
						PATH: process.env.PATH ?? "",
						HOME: process.env.HOME ?? "",
						GIT_TERMINAL_PROMPT: "0",
						AC_CLONE_USER:
							provider.type === "gitlab"
								? "oauth2"
								: provider.username || "x-access-token",
						AC_CLONE_TOKEN: token,
					},
				},
			);
			const [error, code] = await Promise.all([
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0)
				throw new Error(
					(
						error.replaceAll(token || "\0", "<redacted>").trim() ||
						"git clone failed"
					).slice(0, 400),
				);
			// Fetch every branch later (v1 tracked the remote fully).
			await git(repository, [
				"config",
				"remote.origin.fetch",
				"+refs/heads/*:refs/remotes/origin/*",
			]);
			this.clones.delete(ident);
		} catch (error) {
			this.clones.set(ident, {
				state: "failed",
				message: error instanceof Error ? error.message : "git clone failed",
			});
		}
	}
	/** v1 "No Target Configured → Create target script": v1 wrote
	 * `CONFIG_DIR/apps/{run,build}/<ident>-<profile|action>.sh` and discovered it
	 * as a shell target. v2 writes the same template (never replacing an
	 * existing file) and registers a native shell target running it with
	 * `/bin/sh` in the checkout; the confirm dialog is the approval. */
	async shellTarget(input: Record<string, unknown>) {
		const ident = text(input.ident, "app", 64);
		const action = text(input.action, "action", 16);
		if (action !== "build" && action !== "test" && action !== "run")
			throw new Refusal(`unsupported shell action "${action}"`);
		if (input.runtime !== undefined && input.runtime !== "shell")
			throw new Refusal(
				"Only POSIX shell targets are available in agentic-coding-v2; PowerShell is not",
			);
		const profile =
			action === "run"
				? typeof input.profile === "string" && input.profile
					? input.profile
					: "dev"
				: "";
		if (action === "run" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))
			throw new Refusal(
				"profile must contain only letters, numbers, underscores, and dashes",
			);
		return this.serial(async () => {
			const project = this.environments.projects.find(
				(item) => item.id === ident,
			);
			if (!project || project.kind === "infrastructure")
				throw new Refusal(`app with ident "${ident}" not found`);
			const id = action === "run" ? `run-shell-${profile}` : `${action}-shell`;
			if (project.targets.some((target) => target.id === id))
				throw new Refusal(`${ident} already has target ${id}`);
			const file = this.catalogFile();
			const directory = path.join(
				fs.realpathSync(this.config.configDir),
				"apps",
				action === "run" ? "run" : "build",
			);
			const script = path.join(
				directory,
				action === "run" ? `${ident}-${profile}.sh` : `${ident}-${action}.sh`,
			);
			const label =
				action === "run"
					? profile
					: action.charAt(0).toUpperCase() + action.slice(1);
			fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
			if (
				fs.realpathSync(directory) !== directory ||
				(fs.existsSync(script) && !fs.lstatSync(script).isFile())
			)
				throw new Refusal(`${script} must be a regular file in CONFIG_DIR`);
			if (!fs.existsSync(script))
				fs.writeFileSync(
					script,
					`#!/usr/bin/env sh\n# devenv:name=${label}\n# devenv:mode=${action === "run" ? "tmux" : "logged"}\nset -eu\n\necho "TODO: replace with your command"\n`,
					{ mode: 0o755, flag: "wx" },
				);
			this.writeCatalog(file, (projects) =>
				projects.map((item) =>
					item.id !== ident
						? item
						: {
								...item,
								targets: [
									...((item.targets as unknown[]) ?? []),
									{
										id,
										action,
										runtime: "shell",
										command: `/bin/sh '${script.replaceAll("'", "'\\''")}'`,
										...(action === "run" ? { profile } : {}),
										label,
									},
								],
							},
				),
			);
			return { success: true, path: script };
		});
	}
	async remove(input: Record<string, unknown>) {
		const ident = text(input.ident, "app", 64);
		return this.serial(async () => {
			const project = this.environments.projects.find(
				(item) => item.id === ident,
			);
			if (!project || project.kind === "infrastructure")
				throw new Refusal(`app with ident "${ident}" not found`);
			if (this.clones.get(ident)?.state === "cloning")
				throw new Refusal("The repository is still being cloned");
			const root = this.root();
			const container = path.join(root, ident);
			const repository = project.repository;
			if (path.dirname(repository) !== container || !within(root, container))
				throw new Refusal(
					"Only repositories under $DEVENV_HOME/<ident>/ are removed; edit environments.json and config.json for other layouts",
				);
			if (
				this.environments.projects.some(
					(item) => item.id !== ident && item.repository === repository,
				) ||
				this.environments.clusters.some(
					(cluster) =>
						cluster.repositories.includes(repository) && !cluster.provision,
				)
			)
				throw new Refusal(
					"Another project or cluster definition uses this repository",
				);
			const snapshot = await this.environments.snapshot();
			if (
				snapshot.runs.some(
					(run) =>
						run.state !== "exited" &&
						(within(container, run.plan.workspace) ||
							within(container, run.plan.cwd)),
				)
			)
				throw new Refusal(
					"A native environment run uses this repository; stop it first",
				);
			const catalog = await this.store().snapshot(Catalog, background);
			for (const info of values<TaskInfo>(catalog?.tasks)) {
				if (info.repository !== repository) continue;
				const task = await this.store().getTask(info.id as TaskId, background);
				if (task?.state.status !== "terminal")
					throw new Refusal(
						"A workflow or task still uses this repository; finish it first",
					);
			}
			if (fs.existsSync(path.join(repository, ".git"))) {
				const worktrees = (
					await git(repository, ["worktree", "list", "--porcelain"])
				)
					.split("\n")
					.filter((line) => line.startsWith("worktree "))
					.map((line) => line.slice("worktree ".length));
				for (const worktree of worktrees) {
					if (!within(container, fs.realpathSync(worktree)))
						throw new Refusal(
							"A linked worktree lives outside $DEVENV_HOME/<ident>/; remove it first",
						);
					const status = await git(worktree, ["status", "--porcelain"]);
					if (status.trim())
						throw new Refusal(
							`${path.basename(worktree)} has uncommitted changes`,
						);
				}
				const unpushed = await git(repository, [
					"log",
					"--branches",
					"--not",
					"--remotes",
					"--oneline",
					"-n",
					"1",
				]).catch(() => "");
				if (unpushed.trim())
					throw new Refusal("Repository has commits that are not pushed");
			}
			const file = this.catalogFile();
			this.writeCatalog(file, (projects) =>
				projects.filter((item) => item.id !== ident),
			);
			this.authorize(repository, false);
			this.clones.delete(ident);
			fs.rmSync(container, { recursive: true, force: true });
			return { success: true, message: "App removed successfully" };
		});
	}
}
