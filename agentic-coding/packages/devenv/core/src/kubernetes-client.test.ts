import { expect, test } from "bun:test";
import type { ClientDeps } from "./client-types";
import {
	createKubernetesCluster,
	deleteKubernetesCluster,
	getKubernetesClusterStatus,
} from "./docker-client";

function deps(response: Response): ClientDeps {
	const fetchMock = (async () => response) as unknown as typeof fetch;
	return {
		baseUrl: "http://dev",
		fetchFn: fetchMock,
		sseFetchFn: fetchMock,
	};
}

test("getKubernetesClusterStatus returns cluster status", async () => {
	const status = {
		clusterName: "devenv",
		contextName: "kind-devenv",
		provider: "docker",
		exists: true,
		reachable: true,
		state: "running",
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
		collectedAt: new Date().toISOString(),
	};
	const got = await getKubernetesClusterStatus(deps(Response.json(status)));
	expect(got.clusterName).toBe("devenv");
	expect(got.state).toBe("running");
});

test("cluster lifecycle client unwraps success response data", async () => {
	const status = {
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
		collectedAt: new Date().toISOString(),
	};
	const got = await createKubernetesCluster(
		deps(Response.json({ success: true, data: status })),
	);
	expect(got?.exists).toBe(false);
});

test("cluster lifecycle client throws server errors", async () => {
	await expect(
		deleteKubernetesCluster(
			deps(Response.json({ message: "boom" }, { status: 500 })),
		),
	).rejects.toThrow("boom");
});
