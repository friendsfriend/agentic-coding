import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Config, text } from "../config.ts";
import { git as rawGit } from "../git.ts";
import { Refusal } from "../server/refusal.ts";
import type { Environments } from "./manager.ts";

/** Durable per-app active linked worktree (v1's `activeWorktree`). */
export const RepositoryGitState = defineDoc<{ active: Record<string, string> }>(
	{
		kind: "v2.repository-git",
		version: 1,
		scope: "session",
		initial: () => ({ active: {} }),
		checkpointWhen: () => true,
	},
);
export const gitOperations = [
	"status",
	"branches",
	"worktrees",
	"fetch",
	"pull",
	"push",
	"checkout",
	"create-branch",
	"create-worktree",
	"remove-worktree",
	"switch-worktree",
] as const;
export type GitOperation = (typeof gitOperations)[number];
export type Worktree = {
	branch: string;
	path: string;
	isMain: boolean;
	active: boolean;
};
/** Git's own first diagnostic line (redacted) is what v1 showed the developer. */
const git = (cwd: string, args: string[]) =>
	rawGit(cwd, args).catch((error: unknown) => {
		throw new Refusal(
			String(error instanceof Error ? error.message : error).replace(
				/^git \S+ failed: /,
				`git ${args[0]}: `,
			),
		);
	});
const real = (dir: string) => {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
};
/** v1's `+added ~changed -removed` / `✓` summary. */
function summary(porcelain: string) {
	let added = 0,
		changed = 0,
		removed = 0;
	const entries = porcelain.split("\0");
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index] ?? "";
		if (!entry) continue;
		const x = entry[0],
			y = entry[1];
		if (x === "R" || x === "C") index++;
		if (x === "D" || y === "D") removed++;
		else if (x === "?" || x === "A") added++;
		else changed++;
	}
	const parts = [
		added ? `+${added}` : "",
		changed ? `~${changed}` : "",
		removed ? `-${removed}` : "",
	].filter(Boolean);
	return parts.length ? parts.join(" ") : "✓";
}

/** Developer-initiated Git controls for configured application repositories.
 * Only authorized repositories; hooks, filters and prompts stay disabled
 * (`git()`); pull fast-forwards only and worktree removal is never forced, so
 * no local commit or uncommitted file is discarded. HEAD-changing operations
 * refuse while a native run uses that checkout. */
export class RepositoryGit {
	private queues = new Map<string, Promise<unknown>>();
	constructor(
		private config: Config,
		private environments: Environments,
		private store: () => Harness,
	) {}
	private project(app: unknown) {
		const id = text(app, "app", 64),
			project = this.environments.projects.find((item) => item.id === id);
		if (!project || project.kind === "infrastructure")
			throw new Refusal("Choose a configured application or library");
		const repository = real(project.repository);
		if (!this.config.repositories.includes(repository))
			throw new Refusal("Repository is not authorized");
		return { id, repository };
	}
	private async branch(name: unknown) {
		const branch = text(name, "branch", 200);
		if (branch.startsWith("-") || branch.startsWith("origin/"))
			throw new Refusal("Invalid branch name");
		await git(this.config.repositories[0] ?? ".", [
			"check-ref-format",
			"--branch",
			branch,
		]).catch(() => {
			throw new Refusal("Invalid branch name");
		});
		return branch;
	}
	private async active(app: string) {
		return (await this.store().snapshot(RepositoryGitState, background))
			?.active[app];
	}
	async worktrees(app: unknown): Promise<Worktree[]> {
		const { id, repository } = this.project(app),
			active = await this.active(id),
			raw = await git(repository, ["worktree", "list", "--porcelain"]);
		const items = raw
			.split(/\n\n+/)
			.map((block) => block.split("\n"))
			.flatMap((lines) => {
				const dir = lines.find((line) => line.startsWith("worktree "));
				if (!dir || lines.includes("bare")) return [];
				const location = real(dir.slice(9));
				return [
					{
						branch:
							lines
								.find((line) => line.startsWith("branch "))
								?.slice(7)
								.replace(/^refs\/heads\//, "") ?? "",
						path: location,
						isMain: location === repository,
						active: false,
					},
				];
			});
		const selected =
			items.find((item) => !item.isMain && item.branch === active) ??
			items.find((item) => item.isMain);
		for (const item of items) item.active = item === selected;
		return items;
	}
	/** The checkout operator runs of `app` execute in. A recorded active
	 * worktree that disappeared is refused, never silently substituted. */
	async checkout(app: string) {
		const { id, repository } = this.project(app),
			active = await this.active(id);
		if (!active) return repository;
		const found = (await this.worktrees(id)).find(
			(item) => !item.isMain && item.branch === active,
		);
		if (!found)
			throw new Refusal(
				`Active worktree ${active} of ${id} no longer exists; switch worktrees first`,
			);
		return found.path;
	}
	/** Workspace for a direct UI action: the first app's active linked
	 * worktree, or undefined for the repository itself. */
	async workspaceFor(apps: unknown) {
		if (!Array.isArray(apps)) return undefined;
		const app = apps.find((id) =>
			this.environments.projects.some(
				(project) => project.id === id && project.kind !== "infrastructure",
			),
		);
		if (typeof app !== "string") return undefined;
		const { repository } = this.project(app),
			dir = await this.checkout(app);
		return dir === repository ? undefined : dir;
	}
	async status() {
		const rows = [];
		for (const project of this.environments.projects) {
			if (project.kind === "infrastructure") continue;
			try {
				const dir = await this.checkout(project.id),
					{ repository } = this.project(project.id);
				rows.push({
					app: project.id,
					path: dir,
					branch: (await git(dir, ["branch", "--show-current"])).trim(),
					status: summary(await git(dir, ["status", "--porcelain", "-z"])),
					activeWorktree:
						dir === repository
							? null
							: ((await this.active(project.id)) ?? null),
					mainWorktreeBranch: (
						await git(repository, ["branch", "--show-current"])
					).trim(),
				});
			} catch (error) {
				rows.push({
					app: project.id,
					path: project.repository,
					branch: "",
					status: "error",
					activeWorktree: null,
					mainWorktreeBranch: "",
					error: String(error instanceof Error ? error.message : error),
				});
			}
		}
		return rows;
	}
	async branches(app: unknown) {
		const { id } = this.project(app),
			dir = await this.checkout(id),
			names = async (ref: string) =>
				(await git(dir, ["for-each-ref", "--format=%(refname:short)", ref]))
					.split("\n")
					.map((line) => line.trim())
					.filter(
						(line) => line && line !== "origin" && line !== "origin/HEAD",
					);
		return {
			appIdent: id,
			currentBranch: (await git(dir, ["branch", "--show-current"])).trim(),
			localBranches: await names("refs/heads"),
			remoteBranches: await names("refs/remotes/origin"),
		};
	}
	private async idle(dir: string) {
		const busy = (await this.environments.snapshot()).runs.some(
			(run) =>
				run.state !== "exited" &&
				(real(run.plan.workspace) === dir ||
					real(run.plan.cwd).startsWith(`${dir}${path.sep}`)),
		);
		if (busy)
			throw new Refusal(
				"A native environment run uses this checkout; stop it before changing its branch",
			);
	}
	private async clean(dir: string) {
		if ((await git(dir, ["status", "--porcelain"])).trim())
			throw new Refusal("Repository has uncommitted changes");
	}
	private async has(dir: string, ref: string) {
		return git(dir, ["show-ref", "--verify", "--quiet", ref]).then(
			() => true,
			() => false,
		);
	}
	private fetch(dir: string) {
		return git(dir, [
			"fetch",
			"--force",
			"origin",
			"+refs/heads/*:refs/remotes/origin/*",
		]);
	}
	/** One mutation per repository at a time; no automatic retry. */
	async mutate(operation: GitOperation, app: unknown, rawBranch?: unknown) {
		const { id, repository } = this.project(app);
		const previous = this.queues.get(repository) ?? Promise.resolve();
		const next = previous.then(
			() => this.perform(operation, id, repository, rawBranch),
			() => this.perform(operation, id, repository, rawBranch),
		);
		this.queues.set(
			repository,
			next.catch(() => {}),
		);
		return next;
	}
	private async perform(
		operation: GitOperation,
		id: string,
		repository: string,
		rawBranch?: unknown,
	): Promise<{ done: true; operation: GitOperation }> {
		const dir = await this.checkout(id),
			done = { done: true as const, operation };
		switch (operation) {
			case "fetch":
				await this.fetch(dir);
				return done;
			case "push":
				await git(dir, ["push", "origin", "HEAD"]);
				return done;
			case "pull": {
				await this.idle(dir);
				const current = (await git(dir, ["branch", "--show-current"])).trim();
				if (!current) throw new Refusal("A detached HEAD cannot be pulled");
				await this.fetch(dir);
				await git(dir, ["merge", "--ff-only", `origin/${current}`]);
				return done;
			}
			case "checkout": {
				const branch = await this.branch(rawBranch);
				await this.idle(dir);
				await this.clean(dir);
				if (await this.has(dir, `refs/heads/${branch}`))
					await git(dir, ["switch", branch]);
				else if (await this.has(dir, `refs/remotes/origin/${branch}`))
					await git(dir, [
						"switch",
						"-c",
						branch,
						"--track",
						`origin/${branch}`,
					]);
				else await git(dir, ["switch", "-c", branch]);
				return done;
			}
			case "create-branch": {
				const branch = await this.branch(rawBranch);
				await this.idle(dir);
				await git(dir, ["switch", "-c", branch]);
				return done;
			}
			case "create-worktree": {
				const branch = await this.branch(rawBranch),
					existing = (await this.worktrees(id)).find(
						(item) => item.branch === branch,
					);
				if (!existing) {
					const target = `${repository}.${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
					if (fs.existsSync(target))
						throw new Refusal(
							"Worktree directory already exists; it is never adopted",
						);
					if (await this.has(repository, `refs/heads/${branch}`))
						await git(repository, ["worktree", "add", target, branch]);
					else if (await this.has(repository, `refs/remotes/origin/${branch}`))
						await git(repository, [
							"worktree",
							"add",
							"--track",
							"-b",
							branch,
							target,
							`origin/${branch}`,
						]);
					else await git(repository, ["worktree", "add", "-b", branch, target]);
				}
				await this.select(id, existing?.isMain ? null : branch);
				return done;
			}
			case "switch-worktree": {
				const branch = await this.branch(rawBranch),
					found = (await this.worktrees(id)).find(
						(item) => item.branch === branch,
					);
				if (!found) throw new Refusal("Unknown worktree");
				await this.select(id, found.isMain ? null : branch);
				return done;
			}
			case "remove-worktree": {
				const branch = await this.branch(rawBranch),
					found = (await this.worktrees(id)).find(
						(item) => item.branch === branch,
					);
				if (!found) throw new Refusal("Unknown worktree");
				if (found.isMain || found.active)
					throw new Refusal("Cannot remove the active or primary worktree");
				await this.idle(found.path);
				await git(repository, ["worktree", "remove", found.path]);
				return done;
			}
			default:
				throw new Refusal("Unsupported Git operation");
		}
	}
	private select(app: string, branch: string | null) {
		return this.store().commit(async (tx) => {
			const doc = await tx.doc(RepositoryGitState);
			if (branch) doc.active[app] = branch;
			else delete doc.active[app];
		}, background);
	}
}
