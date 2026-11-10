import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { deploymentClient } from "./fixtures/deployment-client.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
for (const failure of [
	"availability",
	"service-scope",
	"missing-root",
] as const)
	test(`native Deployment ${failure} loss reports failure without inferring pod access or reconstructing a controller`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			const file = path.join(config.configDir, "deployment.json");
			configureLocalCluster(config, deploymentClient, { FIXTURE_STATE: file });
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: config.repositories[0],
							targets: [
								{
									id: "controller",
									action: "run",
									runtime: "kubernetes",
									timeoutMs: 5000,
									kubernetes: {
										cluster: "local",
										namespace: "fixtures",
										image: "fixture/app:v1",
										workload: "deployment-v1",
										replicas: 1,
										services: [{ name: "api", port: 80, targetPort: 8080 }],
									},
								},
							],
						},
					],
				}),
			);
		});
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_start", { apps: ["api"], runtime: "kubernetes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("request_review", {
					path: ".",
					title: "Hold controller loss",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const owner = await app.startTask(invocation);
		await approve(app, owner);
		await pendingReview(app, owner, "Hold controller loss");
		const file = path.join(config.configDir, "deployment.json"),
			state = JSON.parse(fs.readFileSync(file, "utf8")),
			name = Object.keys(state.deployments)[0];
		if (!name) throw new Error("Missing synthetic original controller");
		const original = state.deployments[name].metadata.uid;
		if (failure === "availability")
			state.deployments[name].status.availableReplicas = 0;
		else if (failure === "service-scope")
			state.services.api.spec.type = "LoadBalancer";
		else delete state.deployments[name];
		fs.writeFileSync(file, JSON.stringify(state));
		await eventually(
			() => app.environments.snapshot(),
			(snapshot) =>
				snapshot.runs[0]?.state ===
				(failure === "missing-root" ? "interrupted" : "exited"),
		);
		const after = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(after.deployments).toEqual({});
		expect(after.services).toEqual({});
		expect((await app.environments.snapshot()).runs[0]?.exitCode).toBe(1);
		if (failure !== "missing-root")
			expect(after.descendants[original]).toBeUndefined();
		else expect(after.descendants[original]).toHaveLength(2);
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);
