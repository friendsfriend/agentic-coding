import { describe, expect, test } from "bun:test";
import type { KubernetesClusterStatus } from "@devenv/types";
import { kubernetesClusterSummaryLines } from "./KubernetesClusterView";

const base: KubernetesClusterStatus = {
	clusterName: "devenv",
	contextName: "kind-devenv",
	provider: "docker",
	exists: false,
	reachable: false,
	state: "missing",
	nodes: [],
	namespaces: [],
	pods: {
		total: 0,
		running: 0,
		pending: 0,
		succeeded: 0,
		failed: 0,
		unknown: 0,
	},
	releases: [],
	collectedAt: "2026-01-01T00:00:00Z",
};

describe("kubernetesClusterSummaryLines", () => {
	test("reports the missing-state contract for a nullish status", () => {
		expect(kubernetesClusterSummaryLines(null)).toEqual([
			"State: missing",
			"Live usage unavailable",
			"No node data",
		]);
		expect(kubernetesClusterSummaryLines(undefined)).toEqual([
			"State: missing",
			"Live usage unavailable",
			"No node data",
		]);
	});

	test("summarizes a missing cluster with each field", () => {
		expect(kubernetesClusterSummaryLines(base)).toEqual([
			"State: missing",
			"Name: devenv  Context: kind-devenv  Provider: docker",
			"Exists: no  Reachable: no  Version: n/a",
			"Live usage unavailable",
			"Pods: 0 total, 0 running, 0 failed",
		]);
	});

	test("falls back to unknown provider and n/a version when unset", () => {
		expect(
			kubernetesClusterSummaryLines({
				...base,
				provider: "",
				kubernetesVersion: "",
			}),
		).toEqual([
			"State: missing",
			"Name: devenv  Context: kind-devenv  Provider: unknown",
			"Exists: no  Reachable: no  Version: n/a",
			"Live usage unavailable",
			"Pods: 0 total, 0 running, 0 failed",
		]);
	});

	test("summarizes a running cluster with live CPU and pod counts", () => {
		expect(
			kubernetesClusterSummaryLines({
				...base,
				exists: true,
				reachable: true,
				state: "running",
				kubernetesVersion: "v1.29.0",
				pods: {
					total: 3,
					running: 3,
					pending: 0,
					succeeded: 0,
					failed: 0,
					unknown: 0,
				},
				stats: {
					cpuPercent: 12.3,
					memoryUsageBytes: 1,
					memoryLimitBytes: 2,
					memoryPercent: 50,
					nodes: [],
					collectedAt: base.collectedAt,
				},
			}),
		).toEqual([
			"State: running",
			"Name: devenv  Context: kind-devenv  Provider: docker",
			"Exists: yes  Reachable: yes  Version: v1.29.0",
			"CPU 12.3%",
			"Pods: 3 total, 3 running, 0 failed",
		]);
	});

	test("reports unavailable live usage and failure counts for degraded state", () => {
		expect(
			kubernetesClusterSummaryLines({
				...base,
				exists: true,
				reachable: true,
				state: "degraded",
				pods: {
					total: 2,
					running: 1,
					pending: 0,
					succeeded: 0,
					failed: 1,
					unknown: 0,
				},
				warnings: ["stats unavailable"],
			}),
		).toEqual([
			"State: degraded",
			"Name: devenv  Context: kind-devenv  Provider: docker",
			"Exists: yes  Reachable: yes  Version: n/a",
			"Live usage unavailable",
			"Pods: 2 total, 1 running, 1 failed",
		]);
	});
});
