import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { deploymentClient } from "./fixtures/deployment-client.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const stateFile = (config: Config) =>
	path.join(config.configDir, "deployment.json");
const read = (config: Config) =>
	JSON.parse(fs.readFileSync(stateFile(config), "utf8"));
const calls = (config: Config) =>
	fs
		.readFileSync(path.join(config.configDir, "deployment-calls.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
function configure(config: Config) {
	fs.chmodSync(config.stateDir, 0o700);
	configureLocalCluster(config, deploymentClient, {
		FIXTURE_STATE: stateFile(config),
		FIXTURE_CALLS: path.join(config.configDir, "deployment-calls.jsonl"),
	});
	fs.writeFileSync(
		stateFile(config),
		JSON.stringify({
			deployments: {},
			services: {},
			descendants: {},
			serial: 0,
		}),
	);
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
								command: ["serve"],
								args: ["--port", "8080"],
								replicas: 2,
								readinessProbe: {
									httpGet: { path: "/ready", port: 8080 },
									initialDelaySeconds: 0,
									periodSeconds: 1,
									timeoutSeconds: 1,
									failureThreshold: 2,
									successThreshold: 1,
								},
								services: [{ name: "api", port: 80, targetPort: 8080 }],
							},
						},
					],
				},
			],
		}),
	);
}
async function held(value: Awaited<ReturnType<typeof fixture>>) {
	const { app, fake, invocation } = value;
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_start", { apps: ["api"], runtime: "kubernetes" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("env_logs", { app: "api" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			fauxToolCall("request_review", {
				path: ".",
				title: "Hold native Deployment",
			}),
			{ stopReason: "toolUse" },
		),
	]);
	const owner = await app.startTask(invocation);
	const review = await pendingReview(app, owner);
	expect(review.snapshot).toContain("kubernetesDeploymentScope");
	expect(review.snapshot).not.toContain('"kubernetesScope"');
	expect(callsIfPresent(value.config)).toHaveLength(0);
	await approve(app, owner);
	await pendingReview(app, owner, "Hold native Deployment");
	return owner;
}
function callsIfPresent(config: Config) {
	return fs.existsSync(path.join(config.configDir, "deployment-calls.jsonl"))
		? calls(config)
		: [];
}

test("explicit native Deployment creates one UID-owned controller, not flattened pods, with Services and observed generation-qualified availability", async () => {
	const value = await fixture(false, configure),
		{ app, config } = value,
		owner = await held(value);
	const state = read(config),
		name = Object.keys(state.deployments)[0];
	if (!name) throw new Error("Missing original controller");
	const deployment = state.deployments[name];
	expect(Object.keys(state.deployments)).toHaveLength(1);
	expect(Object.keys(state.services)).toHaveLength(1);
	expect(state.descendants[deployment.metadata.uid]).toHaveLength(3);
	expect(deployment).toMatchObject({
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { namespace: "fixtures" },
		spec: {
			replicas: 2,
			revisionHistoryLimit: 0,
			strategy: { type: "Recreate" },
			template: {
				spec: {
					automountServiceAccountToken: false,
					enableServiceLinks: false,
					containers: [
						{
							name: "app",
							image: "fixture/app:v1",
							command: ["serve"],
							args: ["--port", "8080"],
							readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
							securityContext: {
								allowPrivilegeEscalation: false,
								capabilities: { drop: ["ALL"] },
							},
						},
					],
				},
			},
		},
	});
	expect(deployment.spec.selector.matchLabels).toEqual(
		deployment.metadata.labels,
	);
	expect(state.services.api.spec.selector).toEqual(deployment.metadata.labels);
	const statuses = (await app.environments.snapshot()).runs[0]?.runtimeStatuses;
	expect(statuses).toHaveLength(1);
	expect(statuses?.[0]).toMatchObject({
		kind: "deployment",
		readiness: "deployment-available",
		health: "healthy",
		owned: true,
		id: deployment.metadata.uid,
	});
	expect(
		calls(config)
			.filter((call) => call.method === "create")
			.map((call) => call.body.kind),
	).toEqual(["Service", "Deployment"]);
	expect(calls(config).some((call) => /pods|replicasets/.test(call.path))).toBe(
		false,
	);
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
	const after = read(config);
	expect(after.deployments).toEqual({});
	expect(after.services).toEqual({});
	expect(after.descendants).toEqual({});
	const deleted = calls(config).filter((call) => call.method === "delete");
	expect(deleted.map((call) => call.path.split("/").at(-2))).toEqual([
		"deployments",
		"services",
	]);
	expect(
		deleted.every(
			(call) =>
				call.body.propagationPolicy === "Foreground" &&
				typeof call.body.preconditions.uid === "string",
		),
	).toBe(true);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
}, 30000);

test("matching-label replacement is not a new controller lease and cannot be deleted", async () => {
	const value = await fixture(false, configure),
		{ app, config } = value,
		owner = await held(value),
		state = read(config),
		name = Object.keys(state.deployments)[0];
	if (!name) throw new Error("Missing synthetic Deployment");
	const replacement = "99999999-2222-3333-4444-555555555555";
	state.deployments[name].metadata.uid = replacement;
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await eventually(
		() => app.environments.snapshot(),
		(snapshot) => snapshot.runs[0]?.state === "interrupted",
	);
	expect(read(config).deployments[name].metadata.uid).toBe(replacement);
	expect(
		calls(config).filter(
			(call) => call.method === "delete" && call.path.includes("/deployments/"),
		),
	).toHaveLength(0);
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
	expect(read(config).deployments[name].metadata.uid).toBe(replacement);
}, 30000);

test("delete races carry the original UID rather than retrying against a replacement by name", async () => {
	const value = await fixture(false, configure),
		{ app, config } = value,
		owner = await held(value),
		state = read(config),
		name = Object.keys(state.deployments)[0];
	if (!name) throw new Error("Missing synthetic Deployment");
	const original = state.deployments[name].metadata.uid;
	state.replaceOnDelete = true;
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
	expect(read(config).deployments[name].metadata.uid).not.toBe(original);
	const deletes = calls(config).filter(
		(call) => call.method === "delete" && call.path.includes("/deployments/"),
	);
	expect(deletes).toHaveLength(1);
	expect(deletes[0]?.body.preconditions.uid).toBe(original);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe(
		"interrupted",
	);
}, 30000);
for (const failure of [
	"invalidReceipt",
	"staleGeneration",
	"wrongList",
	"occupiedService",
] as const)
	test(`native Deployment refuses ${failure} without chart reduction, adoption or false readiness`, async () => {
		const value = await fixture(false, (config) => {
				configure(config);
				const state = read(config);
				if (failure === "occupiedService")
					state.services.api = {
						apiVersion: "v1",
						kind: "Service",
						metadata: {
							name: "api",
							namespace: "fixtures",
							uid: "99999999-2222-3333-4444-555555555555",
							resourceVersion: "1",
							labels: {},
						},
						spec: { type: "ClusterIP", clusterIP: "10.96.0.8" },
					};
				else state[failure] = true;
				fs.writeFileSync(stateFile(config), JSON.stringify(state));
				if (failure === "staleGeneration") {
					const file = path.join(config.configDir, "environments.json"),
						definitions = JSON.parse(fs.readFileSync(file, "utf8"));
					definitions.projects[0].targets[0].timeoutMs = 1000;
					fs.writeFileSync(file, JSON.stringify(definitions));
				}
			}),
			{ app, config } = value,
			owner = await held(value);
		const status = (await app.environments.snapshot()).runs[0];
		expect(status?.ready).not.toBe(true);
		expect(status?.state).toBe(
			failure === "invalidReceipt" ? "interrupted" : "exited",
		);
		if (failure === "invalidReceipt") {
			expect(Object.keys(read(config).deployments)).toHaveLength(1);
			expect(
				calls(config).filter(
					(call) =>
						call.method === "delete" && call.path.includes("/deployments/"),
				),
			).toHaveLength(0);
		} else if (failure === "occupiedService") {
			expect(read(config).services.api.metadata.uid).toBe(
				"99999999-2222-3333-4444-555555555555",
			);
			expect(
				calls(config).filter((call) => call.method !== "get"),
			).toHaveLength(0);
		} else if (failure === "staleGeneration") {
			expect(read(config).deployments).toEqual({});
			expect(
				calls(config).filter(
					(call) =>
						call.method === "delete" && call.path.includes("/deployments/"),
				),
			).toHaveLength(1);
		} else
			expect(
				calls(config).filter((call) => call.method !== "get"),
			).toHaveLength(0);
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);
for (const invalid of [
	{ workload: "helm" },
	{ workload: "deployment-v1", namespace: "default" },
	{
		workload: "deployment-v1",
		portForwards: [{ local: 44000, remote: 8080, replica: 0 }],
	},
	{ workload: "deployment-v1", manifest: { kind: "Deployment" } },
])
	test(`authenticated schema refuses unapproved controller scope ${JSON.stringify(invalid)}`, async () => {
		const { app, config } = await fixture(false, configure),
			host = serve(app);
		try {
			const token =
					new URLSearchParams(new URL(host.url).hash.slice(1)).get("token") ??
					"",
				post = (route: string, body: unknown) =>
					fetch(new URL(route, host.url), {
						method: "POST",
						headers: {
							authorization: `Bearer ${token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					}),
				document = JSON.parse(
					fs.readFileSync(
						path.join(config.configDir, "environments.json"),
						"utf8",
					),
				);
			Object.assign(document.projects[0].targets[0].kubernetes, invalid);
			const staged = await (
				await post("/api/environments/drafts", {
					requestId: "invalid-controller-scope",
					content: JSON.stringify(document),
				})
			).json();
			const response = await post("/api/environments/drafts/preflight", {
				requestId: "invalid-controller-check",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
			});
			expect(response.status).toBe(200);
			const checked = await response.json();
			expect(checked.completed).toBe(false);
			expect(checked.schemaAccepted).toBeNull();
			expect(callsIfPresent(config)).toHaveLength(0);
			expect((await app.snapshot()).tasks).toHaveLength(0);
		} finally {
			await host.stop();
		}
	});
