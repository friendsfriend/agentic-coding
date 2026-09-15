// Durable dependency leases and owned-target cleanup
// (`port-environment-runtimes-to-bun`, task 3.7).
//
// Ported from `server/pkg/server/dependency_leases.go`.
//
// A `run` action that starts an *owned* dependency records a lease keyed by the
// dependency's execution key; a `stop` action releases the owner's leases and
// stops a target only once no lease for it remains. The lease is durable, so a
// restarted server adopts the leases a previous process left and never starts a
// second copy of a dependency a live lease already owns.
//
// Two rules stay load-bearing:
//
//   - observation failure is not absence: a lease is only ever removed for its
//     own owner, and a target is stopped only when the released lease was the
//     last one for it;
//   - stopping a target that still has dependents is refused, so a stop cannot
//     tear out infrastructure another app is running on.
import type { ActionDefinition, ActionStepDefinition } from "@devenv/types";

export interface DependencyLease {
	targetId: string;
	ownerRunId: string;
	ownerApp: string;
	lifecycle: string;
	updatedAt: string;
}

/** The durable lease store; the Bun state store satisfies it. */
export interface DependencyLeaseStore {
	getDependencyLeases(): DependencyLease[];
	setDependencyLease(lease: DependencyLease): void;
	deleteDependencyLease(targetId: string, ownerRunId: string): void;
}

export interface DependencyLeaseOptions {
	readonly state: DependencyLeaseStore;
	readonly now?: () => Date;
	/** Stops the owned target whose last lease was released. */
	readonly stopOwnedTarget?: (targetId: string) => void;
	readonly logger?: (message: string) => void;
}

export class DependencyLeases {
	private readonly state: DependencyLeaseStore;
	private readonly now: () => Date;
	private readonly stopOwnedTarget?: (targetId: string) => void;
	private readonly logger?: (message: string) => void;
	/** In-memory mirror of the durable leases; the store is the authority. */
	private leases: DependencyLease[] = [];

	constructor(options: DependencyLeaseOptions) {
		this.state = options.state;
		this.now = options.now ?? (() => new Date());
		this.stopOwnedTarget = options.stopOwnedTarget;
		this.logger = options.logger;
	}

	/**
	 * Adopts the leases a previous process left behind, so a restarted server
	 * does not treat an owned dependency as unowned.
	 */
	adopt(): number {
		try {
			this.leases = this.state.getDependencyLeases();
		} catch (error) {
			this.logger?.(
				`[leases] adoption failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.leases = [];
		}
		return this.leases.length;
	}

	/** The current leases, in adoption/append order. */
	active(): readonly DependencyLease[] {
		return this.leases;
	}

	/**
	 * Records one lease per owned dependency step in a definition. Steps that
	 * are shared or external own nothing and create no lease.
	 */
	leaseFromDefinition(definition: ActionDefinition, runId: string): number {
		const leased: DependencyLease[] = [];
		const walk = (step: ActionStepDefinition): void => {
			const configuration = (step.configuration ?? {}) as Record<
				string,
				unknown
			>;
			const executionKey =
				typeof step.executionKey === "string" ? step.executionKey : "";
			if (
				configuration.lifecycle === "owned" &&
				executionKey.startsWith("dependency/")
			) {
				leased.push({
					targetId: executionKey,
					ownerRunId: runId,
					ownerApp: definition.owner.id,
					lifecycle: "owned",
					updatedAt: this.now().toISOString(),
				});
			}
			for (const child of step.children ?? []) walk(child);
		};
		walk(definition.root);
		for (const lease of leased) {
			try {
				this.state.setDependencyLease(lease);
			} catch (error) {
				this.logger?.(
					`[leases] persisting ${lease.targetId} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			this.leases.push(lease);
		}
		return leased.length;
	}

	/**
	 * Releases every lease an owner app holds and stops a target whose last
	 * lease is gone. Returns the targets that were stopped, so a caller can
	 * report the cleanup it performed.
	 */
	releaseForOwner(ownerApp: string): string[] {
		const released: DependencyLease[] = [];
		const kept: DependencyLease[] = [];
		for (const lease of this.leases) {
			if (lease.ownerApp !== ownerApp) {
				kept.push(lease);
				continue;
			}
			try {
				this.state.deleteDependencyLease(lease.targetId, lease.ownerRunId);
			} catch (error) {
				this.logger?.(
					`[leases] releasing ${lease.targetId} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			released.push(lease);
		}
		this.leases = kept;
		const stopped: string[] = [];
		for (const lease of released) {
			if (this.hasActiveLease(lease.targetId)) continue;
			stopped.push(lease.targetId);
			this.stopOwnedTarget?.(lease.targetId);
		}
		return stopped;
	}

	hasActiveLease(targetId: string): boolean {
		return this.leases.some((lease) => lease.targetId === targetId);
	}

	/**
	 * Whether another owner still depends on a target. Accepts both the bare
	 * resource id and a dependency key, as the Go check did, so a stop of
	 * `redis` is refused while `dependency/redis/docker/local` is leased.
	 */
	hasActiveDependents(targetId: string, excluding: string): boolean {
		return this.leases.some((lease) => {
			const matches =
				lease.targetId === targetId ||
				lease.targetId === `dependency/${targetId}` ||
				lease.targetId.startsWith(`${targetId}/`) ||
				lease.targetId.startsWith(`dependency/${targetId}/`);
			return matches && lease.ownerApp !== excluding;
		});
	}

	/**
	 * Refuses a `stop` action while a dependent lease exists: stopping
	 * infrastructure another app is using would break it, so the conflicting
	 * request fails instead of proceeding.
	 */
	stopBlocked(definition: ActionDefinition): Error | undefined {
		if (definition.type !== "stop") return undefined;
		const target = definition.owner.id;
		if (this.hasActiveDependents(target, definition.owner.id)) {
			return new Error(`cannot stop ${target}: active dependent leases exist`);
		}
		return undefined;
	}
}
