import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { text } from "./config.ts";
import type { Runtime } from "./runtime.ts";
import { Catalog, decode, type OrchestratorInfo } from "./state.ts";

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
			path: this.app.config.repositories[0] ?? process.cwd(),
			profile: this.effective(
				stored ?? { ...this.blank(), profileOverride: undefined },
			),
			createdAt: 0,
			...(stored?.profileOverride
				? { profileOverride: stored.profileOverride }
				: {}),
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

	/** The orchestrator a creation request already produced, retired or not. */
	private async byRequest(requestId: string): Promise<OrchestratorInfo | null> {
		const doc = await this.app.harness.snapshot(Catalog, context);
		for (const raw of Object.values(doc?.orchestrators ?? {})) {
			const entry = decode<OrchestratorInfo>(raw);
			if (entry.requestId === requestId) return entry;
		}
		return null;
	}

	/** One created orchestrator, retired or not: the fence for update/retire. */
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
			throw new Error("Orchestrator is retired");
		const next = {
			...entry,
			title: text(title.trim(), "orchestrator title", 120),
		};
		await this.save(next);
		return next;
	}

	/** Retire it: abort whatever it is running, keep the transcript on disk and
	 * stop listing, asking and reporting to it. Deletion is not offered because
	 * the durable API does not offer one; the entry stays fenced instead. */
	async retire(id: number): Promise<OrchestratorInfo> {
		if (id === Number(this.app.home.id))
			throw new Error("The root orchestrator cannot be retired");
		const entry = await this.retained(id);
		if (entry.retiredAt !== undefined)
			throw new Error("Orchestrator is already retired");
		await (await this.conversation(id)).abort(context);
		const next = { ...entry, retiredAt: Date.now() };
		await this.save(next);
		return next;
	}

	/** The developer's profile choice for one orchestrator. It is stored as an
	 * override, so it survives restarts and outlives a change of the configured
	 * default; the conversation is reconfigured with it immediately. */
	async setProfile(id: number, profile: string): Promise<OrchestratorInfo> {
		const chosen = text(profile, "profile", 200);
		const known = this.app.config.profiles.find((item) => item.id === chosen);
		if (!known) throw new Error("Unknown profile");
		const root = id === Number(this.app.home.id);
		const entry = root ? this.rootInfo() : await this.retained(id);
		if (entry.retiredAt !== undefined)
			throw new Error("Orchestrator is retired");
		const next: OrchestratorInfo = {
			...entry,
			profile: chosen,
			profileOverride: chosen,
			// The root record exists only for its own choice; its title and path
			// stay synthesized.
			...(root
				? {
						title: "Orchestrator",
						path: this.app.config.repositories[0] ?? process.cwd(),
					}
				: {}),
		};
		await (root ? this.app.home : await this.conversation(id)).configure(
			this.app.orchestratorAgent(root ? null : next.path, chosen),
			context,
		);
		await this.save(next);
		return next;
	}

	/** Apply the effective profile to every retained orchestrator that does not
	 * already run with it: an override always wins, an orchestrator without one
	 * follows the configured default, and nothing is reconfigured needlessly. */
	async reconcile(): Promise<void> {
		const entries = await this.read();
		for (const entry of entries) {
			if (entry.profile === this.effective(entry)) continue;
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
				this.app.orchestratorAgent(root ? null : entry.path, chosen),
				context,
			);
			await this.save({ ...entry, profile: chosen });
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
	}): Promise<OrchestratorInfo> {
		const run = this.creating.then(() => this.createOnce(input));
		this.creating = run.catch(() => undefined);
		return run;
	}

	private async createOnce(input: {
		path: string;
		title?: string;
		requestId?: string;
	}): Promise<OrchestratorInfo> {
		const requestId = input.requestId
			? text(input.requestId, "creation identity", 128)
			: undefined;
		if (requestId) {
			const replayed = await this.byRequest(requestId);
			if (replayed) {
				if (replayed.retiredAt !== undefined)
					throw new Error("Orchestrator was created and has been retired");
				return replayed;
			}
		}
		const target = this.authorize(input.path);
		const title = text(
			input.title?.trim() || path.basename(target),
			"orchestrator title",
			120,
		);
		const existing = (await this.read()).find(
			(item) => item.path === target && item.title === title,
		);
		if (existing) throw new Error("Orchestrator already exists at that path");
		const conversation = await this.app.harness.createConversation(
			{
				// Ownerless: a sibling of the root, not owned or cascaded by it, so
				// one orchestrator's cancellation never reaches another.
				ownership: { kind: "ownerless" },
				agent: this.app.orchestratorAgent(target),
			},
			context,
		);
		const info: OrchestratorInfo = {
			id: Number(conversation.id),
			title,
			path: target,
			profile: this.app.config.orchestratorProfile,
			createdAt: Date.now(),
			...(requestId ? { requestId } : {}),
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
