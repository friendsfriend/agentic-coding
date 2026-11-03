import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { type Config, text } from "./config.ts";
import { git } from "./git.ts";
import { invocationFingerprint } from "./identity.ts";
import { finishSlot, type ScheduleSlot } from "./scheduler.ts";
import type { createSkillTask } from "./skill-task.ts";
import {
	Catalog,
	decode,
	type Invocation,
	type Schedule,
	type TaskInfo,
	type TaskInput,
	type Topic,
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
export class TaskAdmission {
	constructor(
		private readonly config: Config,
		private readonly models: Models,
		private readonly harness: Harness,
		private readonly home: Conversation,
		private readonly definition: ReturnType<typeof createSkillTask>,
	) {}
	async validate(invocation: Invocation): Promise<TaskInput> {
		if (!["read-only", "workspace-write"].includes(invocation.policy))
			throw new Error("An explicit execution policy is required");
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
			relatedTo: invocation.relatedTo ?? null,
			occurrence: null,
			baseCommit: (
				await git(repository, [
					"rev-parse",
					"--verify",
					"--end-of-options",
					`${text(invocation.baseRef ?? "HEAD", "Git base ref", 512)}^{commit}`,
				])
			).trim(),
			policy: skill.readOnly ? "read-only" : invocation.policy,
		};
	}
	async start(
		invocation: Invocation,
		slot: ScheduleSlot | null = null,
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
		const id = await this.home.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			const existing = previousAdmission(
				doc.launches[invocation.requestId],
				fingerprint,
			);
			if (existing !== undefined) return existing;
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
			if (invocation.relatedTo !== undefined) {
				const previous = doc.tasks[String(invocation.relatedTo)];
				if (
					!previous ||
					decode<TaskInfo>(previous).topicId !== invocation.topicId
				)
					throw new Error("Related task must exist in the same topic");
			}
			const created = await tx.createTask(this.definition, input, {
				ownership: { kind: "conversation" },
				background: true,
			});
			const info: TaskInfo = {
				id: Number(created),
				baseCommit: input.baseCommit,
				policy: input.policy,
				topicId: invocation.topicId,
				skill: input.skill.id,
				profile: input.profile.id,
				repository: input.repository,
				workspace: "",
				relatedTo: invocation.relatedTo ?? null,
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
