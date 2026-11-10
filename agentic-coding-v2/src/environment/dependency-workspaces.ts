import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import { contained, git } from "../git.ts";
import type { TaskInfo } from "../state.ts";
import type { Plan } from "./model.ts";

export type DependencyWorkspace = {
	repository: string;
	commit: string;
	ownerWorkspace: string;
	owner: number | null;
	workspace: string;
	repositoryIdentity: string;
	gitCommonDirectory: string;
	gitCommonIdentity: string;
};
function identity(directory: string) {
	const stat = fs.lstatSync(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		fs.realpathSync(directory) !== directory
	)
		throw new Error(
			"Dependency repository/workspace identity is not a canonical directory",
		);
	return `${stat.dev}:${stat.ino}`;
}
/** Serializable descriptions are never live worktree authority. New dependency
 * worktrees are created only after exact approval and native reservation. This
 * host keeps the original private creation capability; restart/existing paths
 * never grant adoption or cleanup permission. Worktrees/data are retained. */
export class DependencyWorkspaces {
	private root: string;
	private stateIdentity: string;
	private descriptions = new Map<
		string,
		{
			scope: DependencyWorkspace;
			phase: "described" | "creating" | "owned";
			identity?: string;
		}
	>();
	constructor(private stateDir: string) {
		this.stateDir = fs.realpathSync(stateDir);
		this.stateIdentity = identity(this.stateDir);
		this.root = path.join(this.stateDir, "environment-workspaces");
	}
	async describe(
		repository: string,
		ownerWorkspace: string,
		owner?: number,
	): Promise<DependencyWorkspace> {
		const repositoryIdentity = identity(repository);
		const commit = (
			await git(repository, [
				"rev-parse",
				"--verify",
				"--end-of-options",
				"HEAD^{commit}",
			])
		).trim();
		if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))
			throw new Error("Invalid captured dependency commit");
		const gitCommonDirectory = fs.realpathSync(
			path.resolve(
				repository,
				(await git(repository, ["rev-parse", "--git-common-dir"])).trim(),
			),
		);
		const gitCommonIdentity = identity(gitCommonDirectory);
		const key = digest(
			JSON.stringify([
				repository,
				repositoryIdentity,
				gitCommonDirectory,
				gitCommonIdentity,
				commit,
				ownerWorkspace,
				owner ?? null,
			]),
		);
		const previous =
			owner === undefined ? undefined : this.descriptions.get(key);
		if (previous) return { ...previous.scope };
		if (owner !== undefined && this.descriptions.size >= 256)
			throw new Error("Native dependency workspace description window is full");
		const scope = {
			repository,
			commit,
			ownerWorkspace,
			owner: owner ?? null,
			repositoryIdentity,
			gitCommonDirectory,
			gitCommonIdentity,
			workspace: path.join(
				this.root,
				`${key}-${randomBytes(12).toString("hex")}`,
			),
		};
		if (owner !== undefined)
			this.descriptions.set(key, { scope, phase: "described" });
		return { ...scope };
	}
	forgetOwner(owner: number) {
		for (const [key, entry] of this.descriptions)
			if (entry.scope.owner === owner) this.descriptions.delete(key);
	}
	async realize(plan: Plan, owner: TaskInfo) {
		const scope = plan.dependencyWorkspace;
		if (!scope) return;
		if (!belongsToOwner(plan, owner))
			throw new Error(
				"Dependency workspace does not belong to this approved native owner",
			);
		const entry = [...this.descriptions.values()].find(
			(entry) => JSON.stringify(entry.scope) === JSON.stringify(scope),
		);
		if (!entry || entry.phase === "creating")
			throw new Error(
				"No original live dependency-workspace capability; saved descriptions and uncertain creation cannot be adopted",
			);
		if (
			identity(this.stateDir) !== this.stateIdentity ||
			identity(scope.repository) !== scope.repositoryIdentity
		)
			throw new Error("Dependency workspace source/state identity changed");
		if (
			identity(scope.gitCommonDirectory) !== scope.gitCommonIdentity ||
			fs.realpathSync(
				path.resolve(
					scope.repository,
					(
						await git(scope.repository, ["rev-parse", "--git-common-dir"])
					).trim(),
				),
			) !== scope.gitCommonDirectory
		)
			throw new Error("Dependency Git directory identity changed");
		if (entry.phase === "owned") {
			identity(this.root);
			if ((fs.lstatSync(this.root).mode & 0o077) !== 0)
				throw new Error("Native dependency-workspace root must remain private");
			if (identity(scope.workspace) !== entry.identity)
				throw new Error("Owned dependency worktree identity changed");
		} else {
			fs.mkdirSync(this.root, { mode: 0o700, recursive: true });
			identity(this.root);
			if ((fs.lstatSync(this.root).mode & 0o077) !== 0)
				throw new Error("Native dependency-workspace root must remain private");
			try {
				fs.lstatSync(scope.workspace);
				throw new Error(
					"Dependency worktree path already exists; never adopted or overwritten",
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			entry.phase = "creating";
			await git(scope.repository, [
				"worktree",
				"add",
				"--detach",
				scope.workspace,
				scope.commit,
			]);
			entry.identity = identity(scope.workspace);
		}
		if (
			(await git(scope.workspace, ["rev-parse", "HEAD"])).trim() !==
				scope.commit ||
			(
				await git(scope.workspace, ["rev-parse", "--abbrev-ref", "HEAD"])
			).trim() !== "HEAD" ||
			fs.realpathSync(
				(await git(scope.workspace, ["rev-parse", "--show-toplevel"])).trim(),
			) !== scope.workspace ||
			fs.realpathSync(
				path.resolve(
					scope.workspace,
					(
						await git(scope.workspace, ["rev-parse", "--git-common-dir"])
					).trim(),
				),
			) !== scope.gitCommonDirectory
		)
			throw new Error("Dependency worktree commit/Git identity changed");
		entry.phase = "owned";
		const cwd = contained(
			scope.workspace,
			path.relative(scope.workspace, plan.cwd),
		);
		if (!fs.statSync(cwd).isDirectory())
			throw new Error("Captured dependency commit has no declared cwd");
	}
}
export function belongsToOwner(
	plan: Plan,
	owner: Pick<TaskInfo, "id" | "repository" | "workspace">,
) {
	const scope = plan.dependencyWorkspace;
	return scope
		? scope.owner === owner.id &&
				scope.ownerWorkspace === owner.workspace &&
				scope.repository !== owner.repository &&
				plan.workspace === scope.workspace
		: plan.workspace === owner.workspace;
}
/** One owner acquisition may contain distinct, explicitly approved workspaces.
 * Batch identity remains mandatory; unrelated tasks never gain access. */
export function samePlanOwnerScope(left: Plan, right: Plan) {
	return (
		(left.dependencyWorkspace?.ownerWorkspace ?? left.workspace) ===
		(right.dependencyWorkspace?.ownerWorkspace ?? right.workspace)
	);
}
