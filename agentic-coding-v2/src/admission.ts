import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Harness, TaskId } from "@earendil-works/pi-durable";
import { type Config, text } from "./config.ts";
import { git } from "./git.ts";
import { invocationFingerprint } from "./identity.ts";
import { finishSlot, type ScheduleSlot } from "./scheduler.ts";
import type { createSkillTask } from "./skill-task.ts";
import {
	Catalog,
	decode,
	type Invocation,
	type OrchestratorInfo,
	type Schedule,
	type TaskInfo,
	type TaskInput,
	type Topic,
	values,
} from "./state.ts";

function previousAdmission(
	raw: string | undefined,
	fingerprint: string,
): number | undefined {
	if (!raw) return undefined;
	const saved = decode<{ id: number; fingerprint: string }>(raw);
	if (saved.fingerprint !== fingerprint)
		throw new Error("Request ID was already used for a different invocation");
	return saved.id;
}
/** Who asked for a task: the conversation its report returns to, and the native
 * task whose directory a `shared` spawn works in. Both are resolved by the
 * runtime, never by the model. */
export type Admitter = { conversationId: number; task: number | null };
export class TaskAdmission {
	constructor(
		private readonly config: Config,
		private readonly models: Models,
		private readonly harness: Harness,
		private readonly home: Conversation,
		private readonly definition: ReturnType<typeof createSkillTask>,
		/** The calling conversation's own directory, for a `shared` spawn. */
		private readonly sharedWorkspace: (
			conversationId: number,
		) => Promise<string>,
	) {}
	async validate(invocation: Invocation): Promise<TaskInput> {
		if (
			invocation.workspace !== "shared" &&
			invocation.workspace !== "worktree"
		)
			throw new Error("An explicit workspace mode is required");
		text(invocation.topicId, "topic", 160);
		text(invocation.requestId, "request ID", 256);
		text(invocation.inputs, "inputs", 64000);
		const skill = this.config.skills.find(
			(item) => item.id === invocation.skill,
		);
		const profile = this.config.profiles.find(
			(item) => item.id === invocation.profile,
		);
		if (!skill || !profile) throw new Error("Unknown skill or profile");
		if (!this.models.getModel(profile.provider, profile.modelId))
			throw new Error(
				"Profile model is not available in the configured provider catalog",
			);
		const repository = fs.realpathSync(invocation.repository);
		if (!this.config.repositories.includes(repository))
			throw new Error("Repository is not authorized by v2 configuration");
		return {
			topicId: invocation.topicId,
			skill,
			profile,
			repository,
			inputs: invocation.inputs,
			relatedTo: invocation.relatedTo || null,
			occurrence: null,
			baseCommit: (
				await git(repository, [
					"rev-parse",
					"--verify",
					"--end-of-options",
					`${text(invocation.baseRef ?? "HEAD", "Git base ref", 512)}^{commit}`,
				])
			).trim(),
			workspace: invocation.workspace,
		};
	}
	async start(
		invocation: Invocation,
		slot: ScheduleSlot | null = null,
		admitter?: Admitter,
	): Promise<number> {
		const occurrence = slot ? `${slot.scheduleId}:${slot.due}` : null;
		const fingerprint = invocationFingerprint(invocation, occurrence);
		const previous = previousAdmission(
			(await this.harness.snapshot(Catalog, context))?.launches[
				invocation.requestId
			],
			fingerprint,
		);
		if (previous !== undefined) return previous;
		const input = await this.validate(invocation);
		input.occurrence = occurrence;
		if (admitter?.task != null) input.parent = admitter.task;
		if (input.workspace === "shared") {
			if (!admitter)
				throw new Error("A shared workspace needs the conversation that asked");
			input.workspacePath = await this.sharedWorkspace(admitter.conversationId);
			if (!fs.statSync(input.workspacePath).isDirectory())
				throw new Error("The calling conversation has no directory to share");
		}
		const id = await this.home.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			const existing = previousAdmission(
				doc.launches[invocation.requestId],
				fingerprint,
			);
			if (existing !== undefined) return existing;
			// A closing orchestrator fences the entire real task tree, including
			// in-flight child admissions. Visual workflow siblings stay independent.
			const infos = values<TaskInfo>(doc.tasks);
			const byId = new Map(infos.map((info) => [info.id, info]));
			const byConversation = new Map(
				infos.map((info) => [info.conversationId, info]),
			);
			let caller = admitter?.conversationId;
			let owner = admitter?.task == null ? undefined : byId.get(admitter.task);
			const visited = new Set<number>();
			while (caller !== undefined || owner) {
				if (caller !== undefined) {
					const raw = doc.orchestrators?.[String(caller)];
					if (raw && decode<OrchestratorInfo>(raw).retiredAt !== undefined)
						throw new Error("Orchestrator is closed");
				}
				owner ??= caller === undefined ? undefined : byConversation.get(caller);
				if (!owner) break;
				if (visited.has(owner.id))
					throw new Error("Invalid task ownership cycle");
				visited.add(owner.id);
				if (owner.dismissedAt !== undefined)
					throw new Error("Task was removed");
				caller = owner.admittedBy;
				owner = owner.parent === undefined ? undefined : byId.get(owner.parent);
			}
			if (slot) {
				const raw = doc.schedules[slot.scheduleId];
				const schedule = raw ? decode<Schedule>(raw) : null;
				if (
					schedule?.state !== "enabled" ||
					schedule.revision !== slot.revision ||
					schedule.nextDue !== slot.due
				)
					throw new Error("Schedule changed before admission");
			}
			if (input.relatedTo !== null) {
				const previous = doc.tasks[String(input.relatedTo)];
				if (
					!previous ||
					decode<TaskInfo>(previous).topicId !== invocation.topicId
				)
					throw new Error("Related task must exist in the same topic");
			}
			// A task a task spawned is owned by it: the engine's own tree nests it,
			// an abort of the parent cascades to it, and its completion is reported
			// to the conversation that asked. Only a conversation-owned task may be
			// background, and only a spawned one is never background.
			const spawner = admitter?.task ?? null;
			const created = await tx.createTask(this.definition, input, {
				ownership:
					spawner === null
						? { kind: "conversation" }
						: { kind: "task", taskId: spawner as TaskId },
				...(spawner === null ? { background: true } : {}),
			});
			const info: TaskInfo = {
				id: Number(created),
				...(admitter === undefined
					? {}
					: { admittedBy: admitter.conversationId }),
				...(admitter?.task == null ? {} : { parent: admitter.task }),
				baseCommit: input.baseCommit,
				workspaceMode: input.workspace,
				topicId: invocation.topicId,
				skill: input.skill.id,
				profile: input.profile.id,
				repository: input.repository,
				workspace: "",
				relatedTo: invocation.relatedTo || null,
				createdAt: Date.now(),
				reported: false,
			};
			doc.tasks[String(created)] = JSON.stringify(info);
			doc.launches[invocation.requestId] = JSON.stringify({
				id: Number(created),
				fingerprint,
			});
			if (!doc.topics[invocation.topicId])
				doc.topics[invocation.topicId] = JSON.stringify({
					id: invocation.topicId,
					title: invocation.topicId,
					createdAt: Date.now(),
				} satisfies Topic);
			if (slot)
				await finishSlot(
					tx,
					slot,
					Number(created),
					"admitted; intermediate missed slots coalesced",
				);
			return Number(created);
		}, context);
		this.harness.resume();
		return id;
	}
}
