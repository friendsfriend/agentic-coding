import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { digest, text } from "../config.ts";
import { Catalog, decode, type TaskInfo, values } from "../state.ts";
import {
	hostOperatorLifetime,
	renewableOperator,
	sameApprovedPlan,
} from "./lifetime.ts";
import type { Plan } from "./model.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type OperatorUnitStart,
} from "./state.ts";

type Authority = {
	store: () => Harness;
	live: (run: EnvironmentRun) => boolean;
	check: (owner: number) => void;
	pending: (owner: number) => boolean;
};
/** Developer-only request journal. It queues a native human review, never starts
 * a resource or restores an original handle from persisted observations. */
export class OperatorUnitStarts {
	constructor(private authority: Authority) {}
	private scope(
		saved: Pick<OperatorUnitStart, "owner" | "runId" | "revision" | "topology">,
		runs: EnvironmentRun[],
		task: TaskInfo | undefined,
	) {
		this.authority.check(saved.owner);
		const unit = runs.find((run) => run.id === saved.runId),
			topology = runs.find((run) => run.id === saved.topology),
			mine = runs.filter((run) => run.owner === saved.owner),
			latest = mine.filter((run) => run.plan.app === unit?.plan.app).at(-1);
		if (
			!unit ||
			latest?.id !== unit.id ||
			unit.owner !== saved.owner ||
			unit.revision !== saved.revision ||
			unit.state !== "exited" ||
			(unit.plan.lifetime !== hostOperatorLifetime &&
				(unit.exitCode !== 0 || unit.error)) ||
			unit.cleanupRetention ||
			!renewableOperator(unit.plan) ||
			unit.plan.operatorRoot !== true ||
			task?.kind !== "operator-environment" ||
			task.policy !== "workspace-write" ||
			!topology ||
			topology.owner !== saved.owner ||
			topology.plan.lifetime !== unit.plan.lifetime ||
			!topology.plan.compose?.networkOnly ||
			unit.plan.compose?.networkFrom?.app !== topology.plan.app ||
			unit.plan.compose.networkFrom.target !== topology.plan.id ||
			topology.state !== "running" ||
			topology.ready !== true ||
			topology.cleanupRetention ||
			!this.authority.live(topology) ||
			this.authority.pending(saved.owner) ||
			mine.some(
				(run) =>
					holdsResource(run) &&
					(run.state !== "running" ||
						run.ready !== true ||
						run.cleanupRetention ||
						run.plan.lifetime !== unit.plan.lifetime),
			)
		)
			throw new Error(
				"Re-add requires the latest confirmed released renewable operator unit, its original live topology and settled owner; no old approval upgrade, interrupted ownership, replacement topology or new owner",
			);
		return { unit, topology, owner: task, lifetime: unit.plan.lifetime };
	}
	async closeOwner(owner: number) {
		await this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
			for (const [id, raw] of Object.entries(doc.unitStarts ?? {})) {
				const row = decode<OperatorUnitStart>(raw);
				if (
					row.owner === owner &&
					["pending", "review", "issued"].includes(row.state) &&
					doc.unitStarts
				)
					doc.unitStarts[id] = JSON.stringify({
						...row,
						state: "interrupted",
						error: "Original operator ended; no replay",
					});
			}
		}, background);
	}
	async history() {
		const doc = await this.authority
			.store()
			.snapshot(EnvironmentState, background);
		return values<OperatorUnitStart>(doc?.unitStarts).slice(-64);
	}
	async request(input: Record<string, unknown>) {
		if (
			Object.keys(input).some(
				(key) => !["requestId", "runId", "revision", "reason"].includes(key),
			)
		)
			throw new Error("Unexpected operator unit re-add field");
		const requestId = text(input.requestId, "request ID", 256),
			runId = text(input.runId, "run ID", 512),
			reason = text(input.reason, "re-add reason", 1000),
			id = digest(requestId);
		if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1)
			throw new Error("A current integer released-unit revision is required");
		return this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				catalog = await tx.doc(Catalog);
			doc.unitStarts ??= {};
			const old = doc.unitStarts[id];
			if (old) {
				const saved = decode<OperatorUnitStart>(old);
				if (
					saved.requestId !== requestId ||
					saved.runId !== runId ||
					saved.revision !== input.revision ||
					saved.reason !== reason
				)
					throw new Error("Unit re-add request identity mismatch");
				return saved;
			}
			if (Object.keys(doc.unitStarts).length >= 1024)
				throw new Error(
					"Unit re-add journal capacity reached; no records were deleted",
				);
			const runs = values<EnvironmentRun>(doc.runs),
				unit = runs.find((run) => run.id === runId);
			if (!unit) throw new Error("Unknown released operator unit");
			const raw = catalog.tasks[String(unit.owner)],
				task = raw ? decode<TaskInfo>(raw) : undefined,
				native = await tx.task(unit.owner as TaskId);
			if (
				!native ||
				native.abortRequested ||
				native.state.status === "terminal"
			)
				throw new Error("Original operator is not live");
			if (
				values<OperatorUnitStart>(doc.unitStarts).some(
					(row) =>
						row.owner === unit.owner &&
						["pending", "review", "issued"].includes(row.state),
				)
			)
				throw new Error(
					"Another unit re-add is pending; settle its exact review first",
				);
			const topology = runs.filter(
				(run) =>
					run.owner === unit.owner &&
					holdsResource(run) &&
					run.plan.compose?.networkOnly,
			);
			if (topology.length !== 1 || !topology[0])
				throw new Error("No unique original live topology");
			const saved: OperatorUnitStart = {
				id,
				requestId,
				owner: unit.owner,
				runId,
				revision: Number(input.revision),
				reason,
				topology: topology[0].id,
				batch: `env-${unit.owner}-unit-${id.slice(0, 32)}`,
				createdAt: Date.now(),
				state: "pending",
			};
			this.scope(saved, runs, task);
			doc.unitStarts[id] = JSON.stringify(saved);
			return saved;
		}, background);
	}
	async context(id: string, owner: number) {
		return this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				raw = doc.unitStarts?.[id],
				catalog = await tx.doc(Catalog);
			if (!raw) throw new Error("Unknown operator unit request");
			const saved = decode<OperatorUnitStart>(raw),
				taskRaw = catalog.tasks[String(owner)];
			if (saved.owner !== owner || !["pending", "review"].includes(saved.state))
				throw new Error("Unit re-add request is no longer reviewable");
			return {
				...this.scope(
					saved,
					values<EnvironmentRun>(doc.runs),
					taskRaw ? decode<TaskInfo>(taskRaw) : undefined,
				),
				request: saved,
			};
		}, background);
	}
	async verify(id: string, owner: number, plans: Plan[]) {
		const scoped = await this.context(id, owner),
			topology = plans.find((plan) => !plan.operatorRoot),
			unit = plans.find((plan) => plan.operatorRoot);
		if (
			plans.length !== 2 ||
			!topology ||
			!unit ||
			unit.app !== scoped.unit.plan.app ||
			unit.id !== scoped.unit.plan.id ||
			unit.operatorTopology !== scoped.topology.id ||
			!sameApprovedPlan(topology, scoped.topology.plan)
		)
			throw new Error(
				"Original topology or selected unit changed; no re-add or second topology",
			);
		return scoped.request;
	}
	async settle(
		id: string,
		owner: number,
		state: OperatorUnitStart["state"],
		error?: string,
	) {
		await this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				raw = doc.unitStarts?.[id];
			if (!raw) throw new Error("Unknown unit request");
			const saved = decode<OperatorUnitStart>(raw);
			if (saved.owner !== owner) throw new Error("Wrong unit request owner");
			if (["completed", "rejected", "interrupted"].includes(saved.state))
				return;
			if (doc.unitStarts)
				doc.unitStarts[id] = JSON.stringify({
					...saved,
					state,
					...(error ? { error } : {}),
				});
		}, background);
	}
}
