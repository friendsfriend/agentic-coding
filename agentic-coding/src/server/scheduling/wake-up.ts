import { HostClient, HostUnavailableError } from "../../agent-host/client.ts";
import {
	type ScheduledEnvelope,
	schedulingDigest,
} from "../../agent-host/scheduled-admission.ts";
import {
	type Job,
	type Occurrence,
	SchedulingError,
} from "../../contracts/scheduling.ts";
import { wakeUpEnvelope } from "../../scheduling/domain.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "./adapters.ts";
/** The lifecycle injects pinned host recovery. It must not select/create the current session instead. */
export function wakeUpAdapter(
	recover: (job: Job) => Promise<void>,
): SchedulingTargetAdapter {
	function envelope(value: Occurrence): ScheduledEnvelope {
		const target = value.job.target;
		if (target.kind !== "wake-up")
			throw new SchedulingError("invalid-input", "Expected a wake-up target.");
		const text = wakeUpEnvelope(value);
		return {
			occurrenceId: value.id,
			digest: schedulingDigest(text),
			text,
			runId: target.runId,
			expectedHostId: target.hostId,
			expectedConversationId: target.conversationId,
		};
	}
	async function request(
		operation: "reserve" | "activate" | "query",
		value: Occurrence,
	) {
		const target = value.job.target;
		if (target.kind !== "wake-up")
			throw new SchedulingError("invalid-input", "Expected a wake-up target.");
		try {
			await recover(value.job);
			return (
				await new HostClient(target.hostSocket).scheduledAdmission({
					operation,
					envelope: envelope(value),
					fence: value.fence,
				})
			).receipt;
		} catch (error) {
			if (error instanceof HostUnavailableError)
				throw new SchedulingInfrastructureError("Wake-up host unavailable.");
			throw new SchedulingDestinationUnavailable(
				"Pinned conversation unavailable.",
			);
		}
	}
	return {
		async resolve(job) {
			if (job.target.kind !== "wake-up")
				throw new SchedulingError(
					"invalid-input",
					"Expected a wake-up target.",
				);
			try {
				await recover(job);
			} catch (error) {
				if (error instanceof HostUnavailableError)
					throw new SchedulingInfrastructureError("Wake-up host unavailable.");
				throw new SchedulingDestinationUnavailable(
					"Pinned conversation unavailable.",
				);
			}
			return job;
		},
		reserve: (value) => request("reserve", value),
		activate: (value) => request("activate", value),
		query: (value) => request("query", value),
	};
}
