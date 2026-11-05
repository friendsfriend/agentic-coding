import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { decode, type TaskInfo, values } from "../state.ts";
import type { Plan } from "./model.ts";
import { captureReferenceGraph } from "./reference-journal.ts";
import { actionsConflict, runsConflict } from "./resources.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
} from "./state.ts";
import { type WaitPoll, type WaitReceipt, waitingResult } from "./wait.ts";

type AcquisitionAuthority = {
	store: () => Harness;
	check: (owner: number, signal?: AbortSignal, batch?: string) => void;
	receipt: (batch: string, owner: number, request: string) => Promise<unknown>;
	execute: (
		batch: string,
		request: string,
		owner: TaskInfo,
		plans: Plan[],
		waitMs: number,
		signal: AbortSignal | undefined,
		retainQueue: boolean,
		pollId: string,
	) => Promise<unknown>;
};
type Waiter = {
	batch: string;
	owner: number;
	apps: string[];
	since: number;
	plans: Plan[];
	active: boolean;
	retained: boolean;
	ordinal: number;
};

export class Acquisitions {
	private waiters: Waiter[] = [];
	private listeners = new Set<() => void>();
	private generation = 0;
	constructor(
		private stateDir: string,
		private authority: AcquisitionAuthority,
	) {}
	get entries(): ReadonlyArray<Waiter> {
		return this.waiters;
	}
	remove(batches: readonly string[]) {
		this.waiters = this.waiters.filter(
			(waiter) => !batches.includes(waiter.batch),
		);
	}
	clear() {
		this.waiters = [];
	}
	notify() {
		this.generation++;
		for (const listener of [...this.listeners]) listener();
	}
	private changed(
		generation: number,
		signal: AbortSignal | undefined,
		deadline: number,
	) {
		if (this.generation !== generation) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.listeners.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
			this.listeners.add(done);
			signal?.addEventListener("abort", done, { once: true });
			if (signal?.aborted || this.generation !== generation) done();
		});
	}
	async recordedWait(
		pollId: string,
		owner: number,
		batch: string,
		request: string,
		waitMs: number,
	) {
		const state = await this.authority
				.store()
				.snapshot(EnvironmentState, background),
			raw = state?.waitPolls?.[pollId];
		if (!raw) return null;
		const saved = state?.waits?.[batch];
		if (!saved)
			throw new Error("Missing acquisition journal for recorded queue poll");
		const poll = decode<WaitPoll>(raw),
			receipt = decode<WaitReceipt>(saved);
		if (
			poll.owner !== owner ||
			poll.batch !== batch ||
			poll.request !== request ||
			poll.waitMs !== waitMs ||
			receipt.owner !== owner ||
			receipt.request !== request
		)
			throw new Error("Queue poll identity mismatch");
		if (poll.state === "waiting") return waitingResult(poll, receipt, true);
		if (poll.state === "acquired")
			return this.authority.receipt(batch, owner, request);
		if (poll.state === "cancelled")
			throw new Error(
				"Queue poll was cancelled; request fresh approval before acquiring again",
			);
		return null;
	}
	async continueWait(
		pollId: string,
		owner: TaskInfo,
		batch: string,
		waitMs: number,
		signal?: AbortSignal,
	) {
		this.authority.check(owner.id, signal, batch);
		if (owner.policy !== "workspace-write")
			throw new Error(
				"Queue continuation requires the original workspace-write native owner",
			);
		const state = await this.authority
				.store()
				.snapshot(EnvironmentState, background),
			raw = state?.waits?.[batch];
		if (!raw) throw new Error("Unknown acquisition");
		const receipt = decode<WaitReceipt>(raw);
		if (
			receipt.owner !== owner.id ||
			!receipt.retained ||
			receipt.plans.some((plan) => plan.workspace !== owner.workspace)
		)
			throw new Error(
				"Only the original native owner may continue its retained approved plan",
			);
		const recorded = await this.recordedWait(
			pollId,
			owner.id,
			batch,
			receipt.request,
			waitMs,
		);
		if (recorded) return recorded;
		if (receipt.state === "acquired")
			return this.authority.receipt(batch, owner.id, receipt.request);
		if (
			receipt.state !== "waiting" ||
			!this.waiters.some(
				(waiter) => waiter.batch === batch && waiter.owner === owner.id,
			)
		)
			throw new Error(
				"No live retained acquisition; saved receipts cannot restore queue authority. Request fresh approval",
			);
		return this.authority.execute(
			batch,
			receipt.request,
			owner,
			receipt.plans,
			waitMs,
			signal,
			true,
			pollId,
		);
	}

	async reserve(
		batch: string,
		request: string,
		owner: TaskInfo,
		plans: Plan[],
		waitMs: number,
		signal: AbortSignal | undefined,
		retainQueue: boolean,
		pollId: string,
	) {
		const running = plans[0]?.action === "run";
		let waiter = this.waiters.find((item) => item.batch === batch);
		if (waiter?.active)
			throw new Error(
				"This acquisition already has an active native wait call",
			);
		if (running) {
			if (
				this.waiters.some(
					(item) => item.owner === owner.id && item.batch !== batch,
				)
			)
				throw new Error(
					"Continue the existing retained acquisition with env_wait, or cancel it before acquiring another batch",
				);
			const receipt = await this.authority.store().commit(async (tx) => {
				const task = await tx.task(owner.id as TaskId),
					doc = await tx.doc(EnvironmentState);
				this.authority.check(owner.id, signal, batch);
				if (
					!task ||
					task.abortRequested ||
					task.state.status === "terminal" ||
					owner.policy !== "workspace-write"
				)
					throw new Error(
						"Environment task has ended or lacks write authority",
					);
				doc.waits ??= {};
				doc.waitPolls ??= {};
				let receipt = doc.waits[batch]
					? decode<WaitReceipt>(doc.waits[batch])
					: undefined;
				if (
					receipt &&
					(receipt.owner !== owner.id ||
						receipt.request !== request ||
						receipt.state !== "waiting" ||
						!waiter)
				)
					throw new Error(
						"No live matching acquisition; saved queue receipts cannot be adopted",
					);
				if (!receipt) {
					doc.waitOrdinal = (doc.waitOrdinal ?? 0) + 1;
					receipt = {
						batch,
						owner: owner.id,
						request,
						plans,
						retained: retainQueue,
						since: Date.now(),
						ordinal: doc.waitOrdinal,
						revision: 1,
						state: "waiting",
					};
					doc.waits[batch] = JSON.stringify(receipt);
				}
				doc.waitPolls[pollId] = JSON.stringify({
					owner: owner.id,
					batch,
					request,
					waitMs,
					state: "pending",
					observedAt: Date.now(),
				} satisfies WaitPoll);
				return receipt;
			}, background);
			if (!waiter) {
				waiter = {
					batch,
					owner: owner.id,
					apps: plans.map((plan) => plan.app),
					since: receipt.since,
					plans,
					active: true,
					retained: retainQueue,
					ordinal: receipt.ordinal,
				};
				this.waiters.push(waiter);
				this.waiters.sort((left, right) => left.ordinal - right.ordinal);
			} else waiter.active = true;
		}
		const currentWaiter = waiter;
		let retained = false;
		this.notify();
		const deadline = Date.now() + waitMs;
		let reserved = false;
		try {
			while (!reserved) {
				this.authority.check(owner.id, signal, batch);
				const generation = this.generation;
				reserved = await this.authority.store().commit(async (tx) => {
					const task = await tx.task(owner.id as TaskId);
					this.authority.check(owner.id, signal, batch);
					if (!task || task.abortRequested || task.state.status === "terminal")
						throw new Error("Environment task has ended");
					const doc = await tx.doc(EnvironmentState),
						active = values<EnvironmentRun>(doc.runs).filter(holdsResource);
					if (running) {
						if (!currentWaiter || !doc.waits || !doc.waitPolls)
							throw new Error("Missing live queue admission");
						const admission = decode<WaitReceipt>(doc.waits[batch]);
						if (
							admission.state !== "waiting" ||
							admission.owner !== owner.id ||
							admission.request !== request
						)
							throw new Error("Acquisition is no longer waiting");
						const held = active.filter((run) => run.plan.action === "run");
						if (held.some((run) => run.owner === owner.id))
							throw new Error(
								"Release your existing app batch before acquiring another; interrupted runs need operator inspection",
							);
						if (
							values<WaitReceipt>(doc.waits)
								.filter(
									(earlier) =>
										earlier.state === "waiting" &&
										earlier.ordinal < admission.ordinal,
								)
								.some((earlier) =>
									earlier.plans.some((left) =>
										plans.some((right) =>
											runsConflict(left, right, this.stateDir),
										),
									),
								) ||
							held.some((run) =>
								plans.some((plan) =>
									runsConflict(run.plan, plan, this.stateDir),
								),
							)
						)
							return false;
					} else if (
						active.some((run) =>
							plans.some((plan) => actionsConflict(run.plan, plan)),
						)
					)
						throw new Error(
							"An environment action already owns this workspace or daemon image writer; inspect interrupted actions before retrying",
						);
					if (running) {
						if (!doc.waits || !doc.waitPolls)
							throw new Error("Missing queue admission journal");
						const receipt = decode<WaitReceipt>(doc.waits[batch]),
							poll = decode<WaitPoll>(doc.waitPolls[pollId]);
						doc.waits[batch] = JSON.stringify({
							...receipt,
							state: "acquired",
							revision: receipt.revision + 1,
						});
						doc.waitPolls[pollId] = JSON.stringify({
							...poll,
							state: "acquired",
							observedAt: Date.now(),
						});
					}
					for (const plan of plans) {
						const run: EnvironmentRun = {
							id: `${batch}:${plan.app}`,
							batch,
							request,
							owner: owner.id,
							plan,
							state: "reserved",
							revision: 1,
							createdAt: Date.now(),
							pid: null,
							ready: null,
							exitCode: null,
							signal: null,
							output: "",
							error: null,
						};
						doc.runs[run.id] = JSON.stringify(run);
					}
					captureReferenceGraph(doc, batch, owner.id, request, plans);
					return true;
				}, background);
				if (!reserved) {
					if (Date.now() >= deadline) {
						if (retainQueue && currentWaiter) {
							const result = await this.authority.store().commit(async (tx) => {
								const task = await tx.task(owner.id as TaskId),
									doc = await tx.doc(EnvironmentState);
								this.authority.check(owner.id, signal, batch);
								if (
									!task ||
									task.abortRequested ||
									task.state.status === "terminal" ||
									!doc.waits ||
									!doc.waitPolls
								)
									throw new Error("Environment task has ended");
								const receipt = decode<WaitReceipt>(doc.waits[batch]);
								if (receipt.state !== "waiting")
									throw new Error("Acquisition is no longer waiting");
								const poll: WaitPoll = {
									owner: owner.id,
									batch,
									request,
									waitMs,
									state: "waiting",
									observedAt: Date.now(),
									position: this.waiters.indexOf(currentWaiter) + 1,
								};
								doc.waitPolls[pollId] = JSON.stringify(poll);
								return waitingResult(poll, receipt);
							}, background);
							retained = true;
							currentWaiter.active = false;
							return { reserved: false as const, result };
						}
						throw new Error(
							"Environment acquisition timed out; no apps started and queue position released",
						);
					}
					await this.changed(generation, signal, deadline);
				}
			}
			this.waiters = this.waiters.filter((item) => item !== currentWaiter);
			this.notify();
			return { reserved: true as const };
		} finally {
			if (!retained) {
				this.waiters = this.waiters.filter((item) => item !== currentWaiter);
				if (running)
					await this.authority.store().commit(async (tx) => {
						const doc = await tx.doc(EnvironmentState);
						if (!doc.waits || !doc.waitPolls) return;
						const receipt = decode<WaitReceipt>(doc.waits[batch]);
						if (receipt.state === "waiting") {
							doc.waits[batch] = JSON.stringify({
								...receipt,
								state: "cancelled",
								revision: receipt.revision + 1,
							});
							const poll = decode<WaitPoll>(doc.waitPolls[pollId]);
							doc.waitPolls[pollId] = JSON.stringify({
								...poll,
								state: "cancelled",
								observedAt: Date.now(),
							});
						}
					}, background);
			}
			this.notify();
		}
	}
}
