import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	captureHelmChart,
	readHelmSpec,
} from "../src/configuration/helm-chart.ts";
import { loadKubernetesClusters } from "../src/configuration/kubernetes-cluster.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("Helm execution is exact-approved, owned and cleaned up only from its install receipt", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-helm-service-")),
	);
	const repository = path.join(root, "repo");
	const state = path.join(root, "state");
	fs.mkdirSync(repository);
	for (const args of [
		["init", "--quiet"],
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--quiet",
			"-m",
			"fixture",
		],
	]) {
		const child = Bun.spawnSync(["git", "-C", repository, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (child.exitCode !== 0) throw new Error("Fixture Git failed");
	}
	fs.mkdirSync(path.join(repository, "chart", "templates"), {
		recursive: true,
	});
	fs.mkdirSync(state, { mode: 0o700 });
	fs.writeFileSync(
		path.join(repository, "chart", "Chart.yaml"),
		"apiVersion: v2\nname: fixture\nversion: 0.1.0\ntype: application\n",
	);
	fs.writeFileSync(
		path.join(repository, "chart", "templates", "deployment.yaml"),
		"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec: {}\n",
	);
	const spec = readHelmSpec({ chart: "chart", release: "fixture" });
	const chart = captureHelmChart(repository, spec);
	const cluster = loadKubernetesClusters(state, [repository]).get("devenv");
	if (!cluster) throw new Error("Missing default cluster fixture");
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [],
		apps: [
			{
				id: "api",
				repository,
				targets: [
					{
						id: "helm",
						action: "run",
						runtime: "kubernetes",
						executable: {
							kind: "helm-release",
							cluster: cluster.id,
							clusterDigest: cluster.digest,
							namespace: "default",
							release: "fixture",
							chart: chart.root,
							chartDigest: chart.digest,
							values: [],
							setString: {},
							timeoutSec: 30,
						},
					},
				],
			},
		],
	});
	const calls: string[] = [];
	const helmUninstall: {
		release: string;
		namespace: string;
		revision: number;
		label: string;
	}[] = [];
	const executor = {
		async helmInstall(input: {
			runLabel: string;
			signal: AbortSignal;
			cluster: { context: string };
		}) {
			calls.push(`install:${input.cluster.context}:${input.runLabel}`);
			input.signal.throwIfAborted();
			return {
				exitCode: 0,
				timedOut: false,
				output: "installed",
				truncated: false,
				created: {
					release: "fixture",
					namespace: "default",
					revision: 1,
					label: input.runLabel,
				},
				deployments: ["api"],
				readiness: "ready" as const,
			};
		},
		async helmUninstall(input: {
			release: string;
			namespace: string;
			revision: number;
			label: string;
		}) {
			helmUninstall.push({
				release: input.release,
				namespace: input.namespace,
				revision: input.revision,
				label: input.label,
			});
			return true;
		},
	} as unknown as ExecutionPort;
	const journal = openOperationJournal(state, [repository]);
	const operator = journal.operator();
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		{ inspect: async () => ({ status: "absent" as const }) },
		executor,
		{ get: () => undefined },
		{ configDir: state },
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		const operation = await agent.admit(
			"helm",
			{ app: "api", target: "helm" },
			signal,
		);
		await operator.decide(operation.id, {
			requestId: "approve-helm",
			digest: operation.digest,
			revision: operation.revision,
			decision: "approved",
		});
		await agent.execute(operation.id, signal);
		expect((await agent.wait(operation.id, 5, signal)).receipt).toMatchObject({
			status: "completed",
			kind: "helm",
			release: "fixture",
			namespace: "default",
			deployments: ["api"],
			readiness: "ready",
			readinessSource: "helm-deployments",
		});
		expect(calls).toHaveLength(1);
		expect(agent.status().owned).toMatchObject([
			{ app: "api", kind: "helm-release" },
		]);
		expect(await agent.logs("api", 20, signal)).toMatchObject({
			app: "api",
			output: expect.stringContaining("Native Helm"),
		});
		expect(await agent.stop("api", signal)).toMatchObject({
			stopped: ["default/fixture"],
			remaining: 0,
		});
		expect(helmUninstall).toMatchObject([
			{ release: "fixture", namespace: "default", revision: 1 },
		]);
		expect(agent.status().owned).toEqual([]);
		expect(calls[0]).toContain("install:kind-devenv");
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
