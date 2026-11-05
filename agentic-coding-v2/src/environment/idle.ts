import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { type TaskInfo, values } from "../state.ts";
import { referencedRoot, scopedRoot } from "./lifetime.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type StopReceipt,
} from "./state.ts";
import type { WaitReceipt } from "./wait.ts";

const DEFAULT_TTL = 30 * 60_000;
type Activity = {
	at: number;
	kind: "agent" | "operator" | "unknown";
	sequence: number;
};
type Ports = {
	store(): Harness;
	eligible(run: EnvironmentRun): boolean;
	pending(owner: number, runId?: string): boolean;
	latch(runs: EnvironmentRun[], batches: string[]): void;
	stop(runs: EnvironmentRun[], batches: string[]): Promise<void>;
};

/** Live activity is deliberately not recovered from stored identities. A stop
 * intent is durable before dispatch; restart leaves uncertain cleanup quarantined. */
export class IdleLifecycle {
	private owners = new Map<number, Activity>();
	private roots = new Map<
		string,
		{ owner: number; app: string; activity: Activity }
	>();
	private lastSweep: number | null = null;
	private sequence = 0;
	private policy: { ttlMs: number; source: string };
	constructor(
		private configDir: string,
		private ports: Ports,
	) {
		this.policy = this.readPolicy();
	}
	private readPolicy() {
		try {
			const file = path.join(this.configDir, "config.json");
			if (fs.statSync(file).size > 64 * 1024)
				throw new Error("Policy source too large");
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			const minutes = data?.environment?.instances?.idle_ttl_minutes;
			if (
				typeof minutes === "number" &&
				Number.isFinite(minutes) &&
				minutes > 0 &&
				Number.isSafeInteger(minutes * 60_000)
			)
				return {
					ttlMs: minutes * 60_000,
					source: "config.json:environment.instances.idle_ttl_minutes",
				};
		} catch {
			/* Missing/malformed policy never disables expiry. No source values are exposed. */
		}
		return { ttlMs: DEFAULT_TTL, source: "default-missing-or-unusable-policy" };
	}
	observe(owner: TaskInfo) {
		const kind =
			owner.kind === "operator-environment"
				? "operator"
				: owner.kind === undefined && owner.skill
					? "agent"
					: "unknown";
		const previous = this.owners.get(owner.id);
		this.owners.set(owner.id, {
			at: Date.now(),
			kind: previous && previous.kind !== kind ? "unknown" : kind,
			sequence: ++this.sequence,
		});
	}
	touchOwner(owner: number) {
		const previous = this.owners.get(owner);
		if (previous)
			this.owners.set(owner, {
				...previous,
				at: Date.now(),
				sequence: ++this.sequence,
			});
	}
	trackRoot(owner: number, id: string, app: string) {
		const activity = this.owners.get(owner);
		if (activity)
			this.roots.set(id, {
				owner,
				app,
				activity: { ...activity, at: Date.now(), sequence: ++this.sequence },
			});
	}
	touch(owner: number, app?: string) {
		this.touchOwner(owner);
		for (const [id, root] of this.roots)
			if (root.owner === owner && (app === undefined || root.app === app))
				this.roots.set(id, {
					...root,
					activity: {
						...root.activity,
						at: Date.now(),
						sequence: ++this.sequence,
					},
				});
	}
	touchRun(owner: number, id: string) {
		this.touchOwner(owner);
		const root = this.roots.get(id);
		if (root?.owner === owner)
			this.roots.set(id, {
				...root,
				activity: {
					...root.activity,
					at: Date.now(),
					sequence: ++this.sequence,
				},
			});
	}
	forgetRoot(id: string) {
		this.roots.delete(id);
	}
	private activity(owner: number, id?: string) {
		if (!id) return this.owners.get(owner);
		const root = this.roots.get(id);
		return root?.owner === owner &&
			this.owners.get(owner)?.kind === root.activity.kind
			? root.activity
			: undefined;
	}
	forget(owner: number) {
		this.owners.delete(owner);
		for (const [id, root] of this.roots)
			if (root.owner === owner) this.roots.delete(id);
	}
	private waiting(waits: Record<string, string> | undefined, owner: number) {
		return values<WaitReceipt>(waits).some(
			(wait) => wait.owner === owner && wait.state === "waiting",
		);
	}
	private protection(
		run: EnvironmentRun,
		activity: Activity | undefined,
		options: { waiting?: boolean; protectedBatch?: boolean },
	) {
		if (scopedRoot(run.plan) && !holdsResource(run))
			return "not-known-live-running";
		// A declared prerequisite expires only with its last live root reference.
		if (referencedRoot(run.plan) && run.plan.projectKind !== "app")
			return "referenced-prerequisite";
		if (activity?.kind === "operator") return "operator-owner";
		if (activity?.kind !== "agent") return "unknown-owner";
		if (options.waiting) return "waiting-owner";
		if (
			this.ports.pending(run.owner, scopedRoot(run.plan) ? run.id : undefined)
		)
			return "operation-in-flight";
		if (!this.ports.eligible(run)) return "not-known-live-running";
		if (options.protectedBatch && !scopedRoot(run.plan))
			return "batch-member-not-known-live-running";
		return null;
	}
	view(
		run: EnvironmentRun,
		options: {
			waiting?: boolean;
			protectedBatch?: boolean;
			ownerHeldRuns?: number;
			ownerBatches?: number;
		} = {},
		now = Date.now(),
	) {
		const independent = scopedRoot(run.plan);
		const activity = this.activity(run.owner, independent ? run.id : undefined);
		const protection = this.protection(run, activity, options);
		return {
			scope: independent
				? referencedRoot(run.plan)
					? "referenced-native-root"
					: "independent-native-root"
				: "whole-native-owner-batch",
			activityScope: independent
				? "selected-native-root"
				: "all-held-runs-of-native-owner",
			acquisitionScope: "one-exclusive-held-run-batch-per-owner",
			ownerHeldRuns: options.ownerHeldRuns ?? null,
			ownerBatches: options.ownerBatches ?? null,
			dependencyScope: run.plan.dependencyBatch
				? referencedRoot(run.plan)
					? "referenced-prerequisite-closure"
					: "exclusive-coupled-batch"
				: "no-declared-dependency-batch",
			ttlMs: activity?.kind === "agent" ? this.policy.ttlMs : null,
			policySource: this.policy.source,
			lastActivityAt: activity?.at ?? null,
			protection,
			remainingMs:
				protection || !activity
					? null
					: Math.max(0, activity.at + this.policy.ttlMs - now),
		};
	}
	async reap(now = Date.now()) {
		if (
			!Number.isSafeInteger(now) ||
			(this.lastSweep !== null && now - this.lastSweep < 60_000)
		)
			return;
		this.lastSweep = now;
		this.policy = this.readPolicy();
		const state = await this.ports
			.store()
			.snapshot(EnvironmentState, background);
		const candidates = new Map<string, { owner: number; rootId?: string }>();
		for (const run of values<EnvironmentRun>(state?.runs).filter(
			holdsResource,
		)) {
			// Prerequisites carry no clock of their own: they are retained by the
			// live roots that declare them, never reaped independently.
			if (referencedRoot(run.plan) && run.plan.projectKind !== "app") continue;
			const rootId = scopedRoot(run.plan) ? run.id : undefined;
			candidates.set(rootId ?? `owner:${run.owner}`, {
				owner: run.owner,
				rootId,
			});
		}
		for (const { owner, rootId } of candidates.values()) {
			const activity = this.activity(owner, rootId);
			if (activity?.kind !== "agent" || now - activity.at < this.policy.ttlMs)
				continue;
			const receipt = await this.ports.store().commit(async (tx) => {
				const doc = await tx.doc(EnvironmentState);
				const runs = values<EnvironmentRun>(doc.runs).filter(
					(run) =>
						run.owner === owner &&
						holdsResource(run) &&
						(!rootId || run.id === rootId),
				);
				// Revalidate after the document read, immediately before the synchronous
				// dispatch latch. New activity, waits or unknown batch members protect all.
				if (
					this.activity(owner, rootId) !== activity ||
					!runs.length ||
					this.waiting(doc.waits, owner) ||
					this.ports.pending(owner, rootId) ||
					runs.some((run) => !this.ports.eligible(run))
				)
					return null;
				const batches = rootId
					? []
					: [...new Set(runs.map((run) => run.batch))].sort();
				const id = `idle:${owner}:${rootId ?? batches.join(",")}:${activity.sequence}`;
				if (doc.stops[id]) return null; // An issued receipt is never resent or overwritten.
				const idle = {
					at: now,
					lastActivityAt: activity.at,
					ttlMs: this.policy.ttlMs,
				};
				const saved: StopReceipt = {
					owner,
					apps: rootId ? runs.map((run) => run.plan.app) : null,
					runs: runs.map((run) => run.id),
					batches,
					done: false,
					idle,
				};
				doc.stops[id] = JSON.stringify(saved);
				for (const run of runs)
					doc.runs[run.id] = JSON.stringify({
						...run,
						state: "stopping",
						revision: run.revision + 1,
						idleReap: idle,
					});
				this.ports.latch(runs, batches);
				return { id, saved, runs };
			}, background);
			if (!receipt) continue;
			await this.ports.stop(receipt.runs, receipt.saved.batches);
			await this.ports.store().commit(async (tx) => {
				const doc = await tx.doc(EnvironmentState);
				doc.stops[receipt.id] = JSON.stringify({
					...receipt.saved,
					done: true,
				});
			}, background);
		}
	}
}
