import fs from "node:fs";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineExtension,
	type Harness,
} from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import { git } from "../git.ts";
import { Catalog, decode } from "../state.ts";
import { resolvePlans } from "./catalog.ts";
import type { Environments } from "./manager.ts";
import {
	createOperatorTask,
	type OperatorAction,
	operatorOwner,
} from "./operator-task.ts";

export type { OperatorAction } from "./operator-task.ts";

/** Idempotent admission for authenticated UI and orchestrator controls. */
export class OperatorEnvironments {
	readonly definition;
	readonly extension;
	constructor(
		private config: Config,
		private manager: Environments,
	) {
		this.definition = createOperatorTask(config, manager);
		this.extension = defineExtension({
			name: "v2.operator-environments",
			tasks: [this.definition],
		});
	}
	async start(harness: Harness, home: Conversation, request: OperatorAction) {
		if (
			Object.keys(request).some(
				(key) =>
					![
						"apps",
						"action",
						"requestId",
						"baseRef",
						"workspaceMode",
						"target",
						"profile",
						"runtime",
						"replicas",
					].includes(key),
			)
		)
			throw new Error("Unknown environment action option");
		text(request.requestId, "request ID", 256);
		if (
			request.workspaceMode !== undefined &&
			request.workspaceMode !== "checkout" &&
			request.workspaceMode !== "worktree"
		)
			throw new Error("Choose checkout or worktree workspace mode");
		if (
			request.workspaceMode !== "worktree" &&
			request.baseRef !== undefined &&
			request.baseRef !== "HEAD"
		)
			throw new Error("Git base refs require isolated worktree mode");
		if (
			!Array.isArray(request.apps) ||
			!request.apps.length ||
			request.apps.length > 16 ||
			new Set(request.apps).size !== request.apps.length
		)
			throw new Error("Choose 1..16 distinct configured environment apps");
		if (!["run", "build", "test"].includes(request.action))
			throw new Error("Unknown environment action");
		const projects = request.apps.map((id) => {
			const project = this.manager.projects.find(
				(project) => project.id === text(id, "app", 64),
			);
			if (!project) throw new Error("Unknown environment app");
			return project;
		});
		const repository = fs.realpathSync(projects[0]?.repository ?? "");
		if (
			!this.config.repositories.includes(repository) ||
			projects.some((project) => project.repository !== repository)
		)
			throw new Error("Environment apps must share one authorized repository");
		const fingerprint = digest(JSON.stringify(request)),
			key = `environment:${request.requestId}`;
		const previous = (raw: string | undefined) => {
			if (!raw) return undefined;
			const saved = decode<{ id: number; fingerprint: string }>(raw);
			if (saved.fingerprint !== fingerprint)
				throw new Error(
					"Request ID was already used for a different environment action",
				);
			return saved.id;
		};
		const saved = previous(
			(await harness.snapshot(Catalog, background))?.launches[key],
		);
		if (saved !== undefined) return saved;
		const baseCommit = (
			await git(repository, [
				"rev-parse",
				"--verify",
				"--end-of-options",
				`${text(request.baseRef ?? "HEAD", "Git base ref", 512)}^{commit}`,
			])
		).trim();
		// Validate selection before admitting a native task or creating its worktree.
		resolvePlans(
			this.manager.projects,
			{ policy: "workspace-write", repository, workspace: repository },
			request.apps,
			request.action,
			request,
			this.config.stateDir,
		);
		const id = await home.commit(async (tx) => {
			const doc = await tx.doc(Catalog),
				existing = previous(doc.launches[key]);
			if (existing !== undefined) return existing;
			const input = { request, repository, baseCommit, createdAt: Date.now() };
			const id = Number(
				await tx.createTask(this.definition, input, {
					ownership: { kind: "conversation" },
					background: true,
				}),
			);
			doc.launches[key] = JSON.stringify({ id, fingerprint });
			doc.tasks[String(id)] = JSON.stringify(operatorOwner(id, input));
			doc.topics.environments ??= JSON.stringify({
				id: "environments",
				title: "Environments",
				createdAt: Date.now(),
			});
			return id;
		}, background);
		harness.resume();
		return id;
	}
}
