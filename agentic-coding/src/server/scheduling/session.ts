import fs from "node:fs";
import { HostClient, HostUnavailableError } from "../../agent-host/client.ts";
import { openPiDurableSession } from "../../agent-host/pi-durable-session.ts";
import { schedulingDigest } from "../../agent-host/scheduled-admission.ts";
import type { Job, Occurrence } from "../../contracts/scheduling.ts";
import {
	durableSessionOwner,
	readDurableSessionRegistry,
	requireDurableSession,
} from "../../pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../../pi-durable-state.ts";
import { dailyDigestWindow } from "../../scheduling/daily-digest.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "./adapters.ts";
import { validateSessionBase } from "./base-validation.ts";
export function sessionTarget(job: Job) {
	const target = job.target;
	if (
		target.kind !== "standalone" ||
		target.policy !== "read-only" ||
		!target.destination
	)
		throw new SchedulingDestinationUnavailable(
			"Expected a read-only workflowless-session destination.",
		);
	return target;
}
export function sessionDigestPrompt(occurrence: Occurrence): string {
	const window = dailyDigestWindow(occurrence.nominalDue);
	return `Scheduled read-only daily task digest\nOccurrence: ${occurrence.id}\nNominal due: ${new Date(occurrence.nominalDue).toISOString()}\nWindow: [${new Date(window.start).toISOString()}, ${new Date(window.end).toISOString()})\nUse this nominal 24-hour window even on Monday or during late execution. Report actual execution time separately. Scheduling grants no source write permission.\n\n${occurrence.job.task}`;
}
export function workflowlessSessionAdapter(
	configDir: string,
	options: {
		models?: () => Promise<readonly string[]>;
		open?: typeof openPiDurableSession;
		client?: (socket: string) => Pick<HostClient, "scheduledAdmission">;
		validateBase?: (cwd: string, base: string) => Promise<void>;
	} = {},
): SchedulingTargetAdapter {
	async function validateExact(job: Job) {
		const target = sessionTarget(job),
			destination = target.destination;
		if (!destination)
			throw new SchedulingDestinationUnavailable(
				"Session destination unavailable.",
			);
		const registry = readDurableSessionRegistry(piDurableRuntimeDir(configDir));
		if (!registry || destination.owner !== durableSessionOwner())
			throw new SchedulingDestinationUnavailable(
				"Session custody unavailable or denied.",
			);
		const record = requireDurableSession(
			registry,
			destination.sessionId,
			destination.owner,
		);
		if (
			record.toolPolicy !== "collection" ||
			!record.binding ||
			record.binding.hostId !== destination.hostId ||
			record.binding.conversationId !== destination.conversationId ||
			record.cwd !== fs.realpathSync(target.repository) ||
			record.model !== target.model ||
			record.thinking !== target.thinking
		)
			throw new SchedulingDestinationUnavailable(
				"Exact collection session binding/settings changed or unavailable; no retargeting attempted.",
			);
		if (
			!(
				await (
					options.models ??
					(async () =>
						(
							await import("../../agent-host/configured-models.ts")
						).configuredModelList())
				)()
			).includes(target.model)
		)
			throw new SchedulingDestinationUnavailable(
				"Configured collection model unavailable.",
			);
		await (options.validateBase ?? validateSessionBase)(
			record.cwd,
			target.baseBranch,
		);
		return { target, destination, record };
	}
	async function exact(job: Job) {
		try {
			return await validateExact(job);
		} catch (error) {
			if (
				error instanceof SchedulingDestinationUnavailable ||
				error instanceof SchedulingInfrastructureError
			)
				throw error;
			throw new SchedulingDestinationUnavailable(
				"Session is deleted or unavailable, corrupt, replaced or foreign; no replacement was attempted.",
			);
		}
	}
	async function request(
		operation: "reserve" | "activate" | "query",
		occurrence: Occurrence,
	) {
		const { destination, record } = await exact(occurrence.job);
		try {
			const opened = await (options.open ?? openPiDurableSession)({
				sessionId: record.id,
				configDir,
				select: false,
			});
			const text = sessionDigestPrompt(occurrence);
			return (
				await (
					options.client?.(opened.hostSocket) ??
					new HostClient(opened.hostSocket)
				).scheduledAdmission({
					operation,
					fence: occurrence.fence,
					envelope: {
						occurrenceId: occurrence.id,
						digest: schedulingDigest(text),
						text,
						runId: record.runId,
						expectedHostId: destination.hostId,
						expectedConversationId: destination.conversationId,
					},
				})
			).receipt;
		} catch (error) {
			if (
				error instanceof SchedulingInfrastructureError ||
				error instanceof SchedulingDestinationUnavailable
			)
				throw error;
			if (
				error instanceof HostUnavailableError ||
				(error instanceof Error &&
					error.message === "agent host is shutting down")
			)
				throw new SchedulingInfrastructureError(
					"Collection host temporarily unavailable.",
				);
			throw new SchedulingDestinationUnavailable(
				"Pinned collection conversation unavailable; no replacement was attempted.",
			);
		}
	}
	return {
		async resolve(job) {
			await exact(job);
			return job;
		},
		reserve: (occurrence) => request("reserve", occurrence),
		activate: (occurrence) => request("activate", occurrence),
		query: (occurrence) => request("query", occurrence),
	};
}
export function withSessionDestination(
	standalone: SchedulingTargetAdapter,
	session: SchedulingTargetAdapter,
): SchedulingTargetAdapter {
	const adapter = (job: Job) =>
		job.target.kind === "standalone" &&
		job.target.policy === "read-only" &&
		job.target.destination
			? session
			: standalone;
	return {
		resolve: (job) => adapter(job).resolve(job),
		reserve: (occurrence) => adapter(occurrence.job).reserve(occurrence),
		activate: (occurrence) => adapter(occurrence.job).activate(occurrence),
		query: (occurrence) => adapter(occurrence.job).query(occurrence),
	};
}
