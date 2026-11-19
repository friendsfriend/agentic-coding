import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import { git } from "./git.ts";
import type { Runtime } from "./runtime.ts";
import { Catalog, decode, type OrchestratorInfo } from "./state.ts";
import { cleanupOrchestratorTasks } from "./task-retention.ts";
import { ensureFeatureWorktree, featureBranch } from "./worktrees.ts";

/** Conversations the developer talks to. The root orchestrator is reserved by
 * the durable harness and stays implicit here; every other orchestrator is an
 * *ownerless sibling* conversation with its own directory, transcript and
 * profile — never a second harness, so the environment, git, telemetry and
 * review authority stays single. */
export class Orchestrators {
	constructor(private readonly app: Runtime) {}

	/** The profile an orchestrator actually runs with: its own choice, else the
	 * configured default. */
	private effective(entry: OrchestratorInfo): string {
		return entry.profileOverride ?? this.app.config.orchestratorProfile;
	}

	/** The root's own entry. It has no stored title or path of its own, but its
	 * profile choice is recorded like any other orchestrator's. */
	private rootInfo(stored?: OrchestratorInfo): OrchestratorInfo {
		return {
			id: Number(this.app.home.id),
			title: "Orchestrator",
			path: stored?.path || this.app.config.repositories[0] || process.cwd(),
			profile: this.effective(
				stored ?? { ...this.blank(), profileOverride: undefined },
			),
			createdAt: 0,
			...(stored?.profileOverride
				? { profileOverride: stored.profileOverride }
				: {}),
			...(stored?.skill ? { skill: stored.skill } : {}),
			...(stored?.branch ? { branch: stored.branch } : {}),
			...(stored?.repository ? { repository: stored.repository } : {}),
		};
	}

	private blank(): OrchestratorInfo {
		return {
			id: Number(this.app.home.id),
			title: "",
			path: "",
			profile: "",
			createdAt: 0,
		};
	}

	async read(): Promise<OrchestratorInfo[]> {
		const doc = await this.app.harness.snapshot(Catalog, context);
		const entries = Object.values(doc?.orchestrators ?? {}).map((raw) =>
			decode<OrchestratorInfo>(raw),
		);
		const root = entries.find((entry) => entry.id === Number(this.app.home.id));
		return [
			this.rootInfo(root),
			...entries
				.filter(
					(entry) =>
						entry.id !== Number(this.app.home.id) &&
						entry.retiredAt === undefined,
				)
				.sort((left, right) => left.createdAt - right.createdAt),
		];
	}

	/** The orchestrator a creation request already produced, closed or not. */
	private async byRequest(requestId: string): Promise<OrchestratorInfo | null> {
		const doc = await this.app.harness.snapshot(Catalog, context);
		for (const raw of Object.values(doc?.orchestrators ?? {})) {
			const entry = decode<OrchestratorInfo>(raw);
			if (entry.requestId === requestId) return entry;
		}
		return null;
	}

	/** One created orchestrator, closed or not: the fence for update/close. */
	private async retained(id: number): Promise<OrchestratorInfo> {
		const doc = await this.app.harness.snapshot(Catalog, context);
		const raw = doc?.orchestrators?.[String(id)];
		if (!raw) throw new Error("Orchestrator is not retained");
		return decode<OrchestratorInfo>(raw);
	}

	async rename(id: number, title: string): Promise<OrchestratorInfo> {
		if (id === Number(this.app.home.id))
			throw new Error("The root orchestrator keeps its own title");
		const entry = await this.retained(id);
		if (entry.retiredAt !== undefined)
			throw new Error("Orchestrator is closed");
		const next = {
			...entry,
			title: text(title.trim(), "orchestrator title", 120),
		};
		await this.save(next);
		return next;
	}

	/** Close it: abort whatever it is running, keep the transcript on disk and
	 * stop listing, asking and reporting to it, so the session ends and leaves the
	 * sidebar. It cannot be reopened; the same checkout accepts a new orchestrator.
	 * Deletion is not offered because the durable API does not offer one; the entry
	 * stays fenced instead. */
	async close(id: number): Promise<OrchestratorInfo> {
		if (id === Number(this.app.home.id))
			throw new Error("The root orchestrator cannot be closed");
		const entry = await this.retained(id);
		if (entry.retiredAt !== undefined) {
			// Idempotent retry also repairs task leftovers from older closures.
			await cleanupOrchestratorTasks(this.app, id);
			return entry;
		}
		const conversation = await this.conversation(id);
		const next = { ...entry, retiredAt: Date.now() };
		// Fence new root and descendant admissions before asking workers to stop.
		await this.save(next);
		await cleanupOrchestratorTasks(this.app, id);
		await conversation.abort(context);
		return next;
	}

	/** The fence for "who asked": the root, or an orchestrator that is still
	 * retained. Root is reported as `undefined` — absence already means the root
	 * — so an unchanged root request keeps the identity its record was saved
	 * under. */
	async attributing(id: number | undefined): Promise<number | undefined> {
		if (id === undefined || id === Number(this.app.home.id)) return undefined;
		const entry = await this.retained(id);
		if (entry.retiredAt !== undefined)
			throw new Error("Orchestrator is closed");
		return entry.id;
	}

	/** The developer's profile choice for one orchestrator. It is stored as an
	 * override, so it survives restarts and outlives a change of the configured
	 * default; the conversation is reconfigured with it immediately. */
	async setProfile(id: number, profile: string): Promise<OrchestratorInfo> {
		const chosen = text(profile, "profile", 200);
		const known = this.app.config.profiles.find((item) => item.id === chosen);
		if (!known) throw new Error("Unknown profile");
		const root = id === Number(this.app.home.id);
		const entry = root ? (await this.read())[0] : await this.retained(id);
		if (!entry) throw new Error("Orchestrator is not retained");
		if (entry.retiredAt !== undefined)
			throw new Error("Orchestrator is closed");
		const next: OrchestratorInfo = {
			...entry,
			profile: chosen,
			profileOverride: chosen,
			// The root record exists only for its own choice; its title and path
			// stay synthesized.
			...(root
				? {
						title: "Orchestrator",
						path: entry.path,
					}
				: {}),
		};
		await (root ? this.app.home : await this.conversation(id)).configure(
			this.app.orchestratorAgent(next.path, chosen, next.skill?.id),
			context,
		);
		await this.save(next);
		return next;
	}

	/** Restore effective profile, persisted directory and loaded skill at startup.
	 * An explicit profile override wins over the configured default. */
	async reconcile(): Promise<void> {
		const entries = await this.read();
		for (const entry of entries) {
			// Backfill already-open custom workspaces through the native catalog.
			// No configuration edits and no repository ancestry guessed by strings.
			const repository =
				entry.repository ?? (await this.repositoryAt(entry.path));
			if (repository && repository !== entry.repository)
				await this.save({ ...entry, repository });
			// Reapply persisted cwd and skill too: the root is reset by harness startup.
			const chosen = this.effective(entry);
			// A stored choice whose profile has since been removed from the
			// configuration leaves the conversation alone; it is still reported, so
			// the developer can choose another one.
			if (!this.app.config.profiles.some((item) => item.id === chosen))
				continue;
			const root = entry.id === Number(this.app.home.id);
			const conversation = root
				? this.app.home
				: await this.conversation(entry.id);
			await conversation.configure(
				this.app.orchestratorAgent(entry.path, chosen, entry.skill?.id),
				context,
			);
			await this.save({
				...entry,
				...(repository ? { repository } : {}),
				profile: chosen,
			});
		}
	}

	private async save(entry: OrchestratorInfo): Promise<void> {
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			doc.orchestrators = {
				...(doc.orchestrators ?? {}),
				[String(entry.id)]: JSON.stringify(entry),
			};
		}, context);
	}

	/** Moving the owning conversation keeps all later shared tasks in the feature
	 * worktree. Persist the path: restart/profile changes must not send it home. */
	async worktree(id: number, name: string, ticket?: string, base?: string) {
		const entry = (await this.read()).find((item) => item.id === id);
		if (!entry)
			throw new Error("Worktree binding requires an interactive conversation");
		const branch = featureBranch(name, ticket);
		const location = path.join(
			this.app.config.stateDir,
			"worktrees",
			"features",
			digest(`${id}:${branch}`).slice(0, 24),
		);
		fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
		const result = await ensureFeatureWorktree(
			entry.path,
			branch,
			base,
			location,
		);
		const repository =
			entry.repository ?? (await this.repositoryAt(entry.path));
		const next = {
			...entry,
			...(repository ? { repository } : {}),
			path: result.path,
			branch: result.branch,
		};
		await this.save(next);
		await (await this.conversation(id)).configure(
			this.app.orchestratorAgent(next.path, next.profile, next.skill?.id),
			context,
		);
		return result;
	}

	/** Resolve one orchestrator conversation by identity, or refuse. */
	async conversation(id: number): Promise<Conversation> {
		const entry = (await this.read()).find((item) => item.id === id);
		if (!entry) throw new Error("Orchestrator is not retained");
		if (entry.id === Number(this.app.home.id)) return this.app.home;
		const conversation = await this.app.harness.conversation(
			entry.id as ConversationId,
			context,
		);
		if (!conversation)
			throw new Error("Orchestrator conversation is unavailable");
		return conversation;
	}

	/** One creation at a time, in this process: the authority is single, so a
	 * double submission must not race two conversations into existence. */
	private creating: Promise<unknown> = Promise.resolve();

	/** Create one orchestrator: an ownerless conversation configured exactly
	 * like the root, except that it works in the chosen directory. A repeated
	 * `requestId` returns the orchestrator it already created. */
	async create(input: {
		path: string;
		title?: string;
		requestId?: string;
		skill?: string;
		revision?: string;
		spawnedBy?: number;
	}): Promise<OrchestratorInfo> {
		const run = this.creating.then(() => this.createOnce(input));
		this.creating = run.catch(() => undefined);
		return run;
	}

	private async createOnce(input: {
		path: string;
		title?: string;
		requestId?: string;
		skill?: string;
		revision?: string;
		spawnedBy?: number;
	}): Promise<OrchestratorInfo> {
		const requestId = input.requestId
			? text(input.requestId, "creation identity", 128)
			: undefined;
		if (requestId) {
			const replayed = await this.byRequest(requestId);
			if (replayed) {
				if (replayed.retiredAt !== undefined)
					throw new Error("Orchestrator was created and has been closed");
				return replayed;
			}
		}
		const target = this.authorize(input.path);
		// A session opened for a skill runs that skill as its instructions, so the
		// developer chooses the exact text they saw: an unknown skill or a stale
		// revision is refused rather than opened with something else.
		const skill = input.skill
			? this.app.config.skills.find(
					(item) => item.id === text(input.skill, "skill", 128),
				)
			: undefined;
		if (input.skill && !skill) throw new Error("Unknown skill");
		if (skill && input.revision !== skill.digest)
			throw new Error("Loaded skill changed since it was read");
		const title = text(
			input.title?.trim() || skill?.id || path.basename(target),
			"orchestrator title",
			120,
		);
		const existing = (await this.read()).find(
			(item) => item.path === target && item.title === title,
		);
		if (existing && !skill)
			throw new Error("Orchestrator already exists at that path");
		const conversation = await this.app.harness.createConversation(
			{
				// Ownerless: a sibling of the root, not owned or cascaded by it, so
				// one orchestrator's cancellation never reaches another.
				ownership: { kind: "ownerless" },
				agent: this.app.orchestratorAgent(target, undefined, skill?.id),
			},
			context,
		);
		const parent =
			input.spawnedBy === undefined
				? undefined
				: (await this.read()).find(
						(entry) => entry.id === input.spawnedBy && entry.path === target,
					);
		const repository = parent?.repository ?? (await this.repositoryAt(target));
		const info: OrchestratorInfo = {
			id: Number(conversation.id),
			title,
			path: target,
			...(repository ? { repository } : {}),
			profile: this.app.config.orchestratorProfile,
			createdAt: Date.now(),
			...(requestId ? { requestId } : {}),
			...(skill ? { skill: { id: skill.id, digest: skill.digest } } : {}),
			...(input.spawnedBy !== undefined ? { spawnedBy: input.spawnedBy } : {}),
		};
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			// Older catalogs carry no orchestrator family at all.
			doc.orchestrators = {
				...(doc.orchestrators ?? {}),
				[String(info.id)]: JSON.stringify(info),
			};
		}, context);
		return info;
	}

	private async repositoryAt(directory: string): Promise<string | undefined> {
		try {
			return fs.realpathSync(
				(await git(directory, ["rev-parse", "--show-toplevel"])).trim(),
			);
		} catch {
			// Interactive conversations may legitimately start outside Git. Their
			// exact selected path is retained; Git-backed tasks still require Git.
			return undefined;
		}
	}

	/** A directory this process may work in: absolute, existing, a directory,
	 * with symlinks resolved. Nothing is created, cloned or checked out here. */
	private authorize(candidate: string): string {
		const value = text(candidate, "orchestrator directory", 4096);
		if (!path.isAbsolute(value))
			throw new Error("Orchestrator directory must be an absolute path");
		let resolved: string;
		try {
			resolved = fs.realpathSync(value);
		} catch {
			throw new Error("Orchestrator directory does not exist");
		}
		if (!fs.statSync(resolved).isDirectory())
			throw new Error("Orchestrator directory is not a directory");
		return resolved;
	}
}
