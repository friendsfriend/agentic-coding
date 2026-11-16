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

	/** The root's own entry: the same shape as a created one, never persisted. */
	private rootInfo(): OrchestratorInfo {
		return {
			id: Number(this.app.home.id),
			title: "Orchestrator",
			path: this.app.config.repositories[0] ?? process.cwd(),
			profile: this.app.config.orchestratorProfile,
			createdAt: 0,
		};
	}

	async read(): Promise<OrchestratorInfo[]> {
		const doc = await this.app.harness.snapshot(Catalog, context);
		const created = Object.values(doc?.orchestrators ?? {})
			.map((raw) => decode<OrchestratorInfo>(raw))
			.sort((left, right) => left.createdAt - right.createdAt);
		return [this.rootInfo(), ...created];
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

	/** Create one orchestrator: an ownerless conversation configured exactly
	 * like the root, except that it works in the chosen directory. */
	async create(input: {
		path: string;
		title?: string;
	}): Promise<OrchestratorInfo> {
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
