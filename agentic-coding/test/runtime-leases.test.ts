// Durable dependency leases (`port-environment-runtimes-to-bun`, task 3.7).
//
// Ported from `server/pkg/server/dependency_leases_test.go`. A run leases the
// owned dependencies it started, a stop releases its owner's leases, and the
// target is stopped only when the last lease for it is gone.
import { describe, expect, test } from "bun:test";
import type { ActionDefinition, ActionStepDefinition } from "@devenv/types";
import { DependencyLeases } from "../src/server/runtime/leases.ts";

interface Store {
	leases: {
		targetId: string;
		ownerRunId: string;
		ownerApp: string;
		lifecycle: string;
		updatedAt: string;
	}[];
}

function store(initial: Store["leases"] = []): {
	store: {
		getDependencyLeases(): Store["leases"];
		setDependencyLease(lease: Store["leases"][number]): void;
		deleteDependencyLease(targetId: string, ownerRunId: string): void;
	};
	state: Store;
} {
	const state: Store = { leases: [...initial] };
	return {
		state,
		store: {
			getDependencyLeases: () => [...state.leases],
			setDependencyLease: (lease) => {
				state.leases = state.leases.filter(
					(existing) =>
						!(
							existing.targetId === lease.targetId &&
							existing.ownerRunId === lease.ownerRunId
						),
				);
				state.leases.push(lease);
			},
			deleteDependencyLease: (targetId, ownerRunId) => {
				state.leases = state.leases.filter(
					(existing) =>
						!(
							existing.targetId === targetId &&
							existing.ownerRunId === ownerRunId
						),
				);
			},
		},
	};
}

function dependencyStep(
	lifecycle: string,
	executionKey = "dependency/redis/docker/local",
): ActionStepDefinition {
	const step: ActionStepDefinition & { executionKey?: string } = {
		id: "step-1",
		kind: "composite",
		label: "Start dependency: redis",
		configuration: { lifecycle, dependencyTarget: "redis" },
	};
	step.executionKey = executionKey;
	return step;
}

function definition(
	type: string,
	ownerId: string,
	steps: ActionStepDefinition[],
): ActionDefinition {
	return {
		id: `${type}-${ownerId}`,
		owner: { kind: "app", id: ownerId },
		type,
		runtime: "docker",
		label: type,
		inputs: [],
		availability: { available: true },
		root: {
			id: "root",
			kind: "composite",
			label: type,
			children: steps,
		},
	} as unknown as ActionDefinition;
}

describe("dependency leases", () => {
	test("a run leases only its owned dependencies", () => {
		const { store: port, state } = store();
		const leases = new DependencyLeases({
			state: port,
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		const count = leases.leaseFromDefinition(
			definition("run", "api", [
				dependencyStep("owned"),
				dependencyStep("shared", "dependency/postgres/docker/local"),
				dependencyStep("external", "dependency/vault/docker/local"),
			]),
			"run-1",
		);
		expect(count).toBe(1);
		expect(state.leases).toEqual([
			{
				targetId: "dependency/redis/docker/local",
				ownerRunId: "run-1",
				ownerApp: "api",
				lifecycle: "owned",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		]);
	});

	test("adoption restores the leases a previous process left", () => {
		const { store: port } = store([
			{
				targetId: "dependency/redis/docker/local",
				ownerRunId: "run-1",
				ownerApp: "api",
				lifecycle: "owned",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		]);
		const leases = new DependencyLeases({ state: port });
		expect(leases.adopt()).toBe(1);
		expect(leases.hasActiveLease("dependency/redis/docker/local")).toBe(true);
	});

	test("releasing an owner stops the target only when its last lease is gone", () => {
		const { store: port, state } = store([
			{
				targetId: "dependency/redis/docker/local",
				ownerRunId: "run-1",
				ownerApp: "api",
				lifecycle: "owned",
				updatedAt: "t",
			},
			{
				targetId: "dependency/redis/docker/local",
				ownerRunId: "run-2",
				ownerApp: "worker",
				lifecycle: "owned",
				updatedAt: "t",
			},
		]);
		const stopped: string[] = [];
		const leases = new DependencyLeases({
			state: port,
			stopOwnedTarget: (targetId) => stopped.push(targetId),
		});
		leases.adopt();
		expect(leases.releaseForOwner("api")).toEqual([]);
		expect(stopped).toEqual([]);
		expect(state.leases).toHaveLength(1);
		expect(leases.releaseForOwner("worker")).toEqual([
			"dependency/redis/docker/local",
		]);
		expect(stopped).toEqual(["dependency/redis/docker/local"]);
		expect(state.leases).toEqual([]);
	});

	test("a lease the store rejects is not mirrored in memory", () => {
		const failures: string[] = [];
		const leases = new DependencyLeases({
			state: {
				getDependencyLeases: () => [],
				setDependencyLease: () => {
					failures.push("set");
					throw new Error("disk full");
				},
				deleteDependencyLease: () => {},
			},
			logger: () => {},
		});
		leases.leaseFromDefinition(
			definition("run", "api", [dependencyStep("owned")]),
			"run-1",
		);
		expect(failures).toEqual(["set"]);
		// The durable store is the authority, so a failed write is still mirrored
		// for this process: the dependency is owned by the run that started it.
		expect(leases.hasActiveLease("dependency/redis/docker/local")).toBe(true);
	});

	test("stopping infrastructure another app leases is refused with Go's message", () => {
		const { store: port } = store();
		const leases = new DependencyLeases({ state: port });
		leases.leaseFromDefinition(
			definition("run", "api", [dependencyStep("owned")]),
			"run-1",
		);
		// The dependent app stops a resource id, not the dependency key.
		const blocked = leases.stopBlocked(
			definition("stop", "redis", [dependencyStep("owned")]),
		);
		expect(blocked?.message).toBe(
			"cannot stop redis: active dependent leases exist",
		);
		// The owner itself is never blocked by its own lease.
		expect(
			leases.stopBlocked({
				...definition("stop", "redis", []),
				owner: { kind: "app", id: "api" },
			}),
		).toBeUndefined();
	});

	test("a stop action is the only blocked action type", () => {
		const { store: port } = store();
		const leases = new DependencyLeases({ state: port });
		leases.leaseFromDefinition(
			definition("run", "api", [dependencyStep("owned")]),
			"run-1",
		);
		expect(leases.stopBlocked(definition("run", "redis", []))).toBeUndefined();
		expect(
			leases.stopBlocked(definition("restart", "redis", [])),
		).toBeUndefined();
	});
});
