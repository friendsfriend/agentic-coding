import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const file = (config: Config) => path.join(config.configDir, "engine.json");
const definitions = (config: Config) =>
	path.join(config.configDir, "environments.json");
const services = [
	"redis",
	"postgres",
	"mailpit",
	"activemq",
	"azurite",
	"playwright-server",
];
function configure(config: Config, provider: "docker" | "podman" = "docker") {
	fs.mkdirSync(config.configDir);
	fs.chmodSync(config.stateDir, 0o700);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	for (const runtime of ["docker", "podman"])
		fs.writeFileSync(
			path.join(bin, runtime),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
	fs.writeFileSync(
		file(config),
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const engine = serveContainerFixture(file(config));
	engines.push(engine);
	const edge = (app: string) => ({ app, target: "run" });
	const target = (id: string) => ({
		id: "run",
		action: "run",
		runtime: "compose",
		timeoutMs: 10000,
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: engine.socket,
		},
		...(id === "topology" ? {} : { prerequisites: [edge("topology")] }),
		compose: {
			file: "compose.native.yaml",
			provider,
			socket: engine.socket,
			network: "shared",
			...(id === "topology"
				? { networkOnly: true, source: "services: {}\n" }
				: {
						networkFrom: edge("topology"),
						source: `services:\n  ${id}:\n    image: fixture:latest\n    command: [serve]\n    healthcheck:\n      test: [CMD, 'true']\n`,
					}),
		},
	});
	const project = (id: string, kind: "infrastructure" | "app") => ({
		id,
		kind,
		repository: config.repositories[0],
		targets: [target(id)],
	});
	const alpha = project("alpha", "app"),
		beta = project("beta", "app");
	alpha.targets[0].prerequisites = [edge("topology"), ...services.map(edge)];
	beta.targets[0].prerequisites = [edge("topology"), edge("postgres")];
	fs.writeFileSync(
		definitions(config),
		JSON.stringify({
			version: 1,
			projects: [
				project("topology", "infrastructure"),
				...services.map((id) => project(id, "infrastructure")),
				alpha,
				beta,
			],
		}),
	);
}
async function held(app: Runtime, task: number, title?: string) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const snapshot = await app.snapshot();
		if (
			snapshot.reviews.some(
				(review) =>
					review.taskId === task &&
					(title
						? review.title === title
						: review.title.startsWith("Environment ")) &&
					review.state === "pending",
			)
		)
			return;
		await Bun.sleep(20);
	}
	throw Error(`No native review ${title}`);
}

for (const provider of ["docker", "podman"] as const)
	test(`native ${provider} topology has no keeper and independently settles six infrastructure members without tying bridge lifetime to a service`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configure(config, provider),
		);
		fake.setResponses([
			call("env_start", {
				apps: ["alpha"],
				lifetime: "shared-prerequisites-v1",
			}),
			call("env_start", {
				apps: ["beta"],
				lifetime: "shared-prerequisites-v1",
			}),
			call("request_review", { path: ".", title: "All members" }),
			call("env_stop", { apps: ["alpha"] }),
			call("request_review", { path: ".", title: "Surviving service" }),
			call("env_stop", { apps: ["beta"] }),
			call("request_review", { path: ".", title: "Topology settled" }),
		]);
		const task = await app.startTask(invocation),
			review = await pendingReview(app, task),
			snapshot = JSON.parse(review.snapshot);
		expect(snapshot.networkOnlyScope).toContain("not a keeper container");
		expect(
			snapshot.plans.find((plan: { app: string }) => plan.app === "topology")
				.composePlan.services,
		).toHaveLength(0);
		expect(
			snapshot.plans
				.filter(
					(plan: {
						projectKind: string;
						composePlan: { services: { container: { readiness: string } }[] };
					}) =>
						plan.projectKind === "infrastructure" &&
						plan.composePlan.services.length,
				)
				.every(
					(plan: {
						composePlan: { services: { container: { readiness: string } }[] };
					}) =>
						plan.composePlan.services.every(
							(service) => service.container.readiness === "healthy",
						),
				),
		).toBe(true);
		expect(readEngineFile(file(config)).history).toHaveLength(0);
		await approve(app, task);
		await held(app, task);
		await approve(app, task);
		await held(app, task, "All members");
		let state = readEngineFile(file(config));
		expect(Object.keys(state.containers)).toHaveLength(8);
		expect(Object.keys(state.networks ?? {})).toHaveLength(1);
		expect(
			state.history.filter(
				(args) => args[2] === "network" && args[3] === "create",
			),
		).toHaveLength(1);
		expect(
			new Set(
				Object.values(state.containers).map((container) => container.NetworkId),
			).size,
		).toBe(1);
		expect(
			Object.values(state.containers).some((container) =>
				container.Name.includes("topology"),
			),
		).toBe(false);
		const topology = (await app.environments.snapshot("topology")).runs[0];
		expect(topology?.ready).toBe(true);
		expect(
			topology?.runtimeStatuses?.filter((status) => status.kind === "network"),
		).toHaveLength(1);
		await approve(app, task, "All members");
		await held(app, task, "Surviving service");
		state = readEngineFile(file(config));
		expect(Object.keys(state.containers)).toHaveLength(2);
		expect(
			Object.values(state.containers).some((container) =>
				container.Aliases?.includes("postgres"),
			),
		).toBe(true);
		expect(Object.keys(state.networks ?? {})).toHaveLength(1);
		expect(
			state.history.some((args) => args[2] === "network" && args[3] === "rm"),
		).toBe(false);
		await approve(app, task, "Surviving service");
		await held(app, task, "Topology settled");
		state = readEngineFile(file(config));
		expect(Object.keys(state.containers)).toHaveLength(0);
		expect(Object.keys(state.networks ?? {})).toHaveLength(0);
		expect(
			(await app.environments.snapshot("topology")).runs[0]?.exitCode,
		).toBe(0);
		await app.cancel(task);
	}, 45000);

test("rejected native topology approval cannot create a network or a keeper", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["topology"] }),
		fauxAssistantMessage("No topology permission"),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	await app.decide(
		review.id,
		review.revision,
		"rejected",
		"No original topology authority",
	);
	await app.harness.waitForTask(task as TaskId, context);
	const state = readEngineFile(file(config));
	expect(state.history).toHaveLength(0);
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
});

test("native owner cancellation settles all live service members before removing only its original topology bridge", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["alpha"], lifetime: "shared-prerequisites-v1" }),
		call("request_review", { path: ".", title: "Cancel live topology" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await held(app, task, "Cancel live topology");
	expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(7);
	await app.cancel(task);
	const state = readEngineFile(file(config));
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
	const removed = state.history.findIndex(
		(args) => args[2] === "network" && args[3] === "rm",
	);
	expect(removed).toBeGreaterThan(
		state.history.findLastIndex((args) => args[2] === "rm"),
	);
	expect(
		state.history.filter((args) => args[2] === "network" && args[3] === "rm"),
	).toHaveLength(1);
}, 25000);

test("standalone native topology is a reviewed network-only lifetime, not application or diagnostic readiness", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	let diagnostic = "";
	fake.setResponses([
		call("env_start", { apps: ["topology"] }),
		call("env_http_request", { app: "topology", endpoint: "imagined" }),
		(messages) => {
			diagnostic = JSON.stringify(messages.messages.at(-1));
			return call("request_review", { path: ".", title: "Bridge only" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await held(app, task, "Bridge only");
	expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(0);
	expect(Object.keys(readEngineFile(file(config)).networks ?? {})).toHaveLength(
		1,
	);
	expect(diagnostic).toContain("error");
	await app.cancel(task);
	expect(Object.keys(readEngineFile(file(config)).networks ?? {})).toHaveLength(
		0,
	);
	expect((await app.environments.snapshot("topology")).runs[0]?.exitCode).toBe(
		0,
	);
}, 15000);

test("a second native owner queues for topology instead of borrowing another task's live bridge", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["topology"] }),
		call("request_review", { path: ".", title: "First owns topology" }),
	]);
	const first = await app.startTask(invocation);
	await approve(app, first);
	await held(app, first, "First owns topology");
	const before = readEngineFile(file(config)).history.length;
	fake.setResponses([
		call("env_start", { apps: ["beta"], timeoutSec: 1 }),
		call("request_review", { path: ".", title: "No takeover" }),
	]);
	const second = await app.startTask({ ...invocation, requestId: "second" });
	await approve(app, second);
	await held(app, second, "No takeover");
	expect(readEngineFile(file(config)).history).toHaveLength(before);
	expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(0);
	expect(Object.keys(readEngineFile(file(config)).networks ?? {})).toHaveLength(
		1,
	);
	await app.cancel(second);
	expect(Object.keys(readEngineFile(file(config)).networks ?? {})).toHaveLength(
		1,
	);
	await app.cancel(first);
	expect(Object.keys(readEngineFile(file(config)).networks ?? {})).toHaveLength(
		0,
	);
}, 15000);

test("lost original topology creation receipt retains the bridge without creating a keeper or adopting/deleting it", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		const state = readEngineFile(file(config));
		state.invalidNetworkReceipt = true;
		fs.writeFileSync(file(config), JSON.stringify(state));
	});
	fake.setResponses([
		call("env_start", { apps: ["beta"] }),
		fauxAssistantMessage("No uncertain topology authority"),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	const state = readEngineFile(file(config));
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(1);
	expect(
		state.history.some((args) => args[2] === "network" && args[3] === "rm"),
	).toBe(false);
}, 15000);

test("authenticated network-only candidate captures zero-service topology without creating workload or bridge authority", async () => {
	const { app, config } = await fixture(false, configure),
		host = serve(app);
	try {
		const url = new URL(host.url),
			token = new URLSearchParams(url.hash.slice(1)).get("token"),
			post = async (route: string, body: unknown) => {
				const response = await fetch(new URL(route, url), {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(200);
				return response.json();
			};
		const draft = await post("/api/environments/drafts", {
				requestId: "create",
				content: fs.readFileSync(definitions(config), "utf8"),
			}),
			checked = await post("/api/environments/drafts/preflight", {
				requestId: "candidate",
				id: draft.id,
				revision: draft.revision,
				digest: draft.digest,
				validateStagedCandidate: true,
			});
		expect(checked.accepted).toBe(true);
		expect(checked.entries).toHaveLength(9);
		expect(checked.publicationAllowed).toBe(false);
		expect(readEngineFile(file(config)).history).toHaveLength(0);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(snapshot.environments.runs).toHaveLength(0);
	} finally {
		host.stop();
	}
});

test("reopened native topology refuses an occupied copied-label network instead of restoring authority from its saved observation", async () => {
	const { app, config, fake, open, invocation } = await fixture(
		true,
		configure,
	);
	fake.setResponses([
		call("env_start", { apps: ["topology"] }),
		call("request_review", { path: ".", title: "Original topology" }),
	]);
	const first = await app.startTask(invocation);
	await approve(app, first);
	await held(app, first, "Original topology");
	const original = Object.values(
		readEngineFile(file(config)).networks ?? {},
	)[0];
	if (!original) throw Error("No original topology");
	await app.close();
	const state = readEngineFile(file(config));
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
	state.networks = { [original.Id]: original };
	const before = state.history.length;
	fs.writeFileSync(file(config), JSON.stringify(state));
	const reopened = await open();
	fake.setResponses([
		call("env_start", { apps: ["topology"] }),
		fauxAssistantMessage("No saved bridge authority"),
	]);
	const second = await reopened.startTask({
		...invocation,
		requestId: "after-reopen",
	});
	await approve(reopened, second);
	await reopened.harness.waitForTask(second as TaskId, context);
	const after = readEngineFile(file(config));
	expect(after.networks?.[original.Id]).toEqual(original);
	expect(
		after.history
			.slice(before)
			.some(
				(args) =>
					args[2] === "network" &&
					["create", "rm", "disconnect"].includes(args[3] ?? ""),
			),
	).toBe(false);
	expect(Object.keys(after.containers)).toHaveLength(0);
}, 20000);

for (const invalid of [
	"not-infrastructure",
	"empty-without-opt-in",
	"services",
	"volume",
	"network-name",
	"isolated",
	"borrower",
	"boolean",
	"secret",
	"endpoint",
	"telemetry",
] as const)
	test(`authenticated topology candidate refuses ${invalid} without native effects`, async () => {
		const { app, config } = await fixture(false, configure),
			data = JSON.parse(fs.readFileSync(definitions(config), "utf8")),
			project = data.projects[0],
			target = project.targets[0];
		if (invalid === "not-infrastructure") project.kind = "app";
		if (invalid === "empty-without-opt-in") delete target.compose.networkOnly;
		if (invalid === "services")
			target.compose.source =
				"services:\n  ignored:\n    image: fixture:latest\n";
		if (invalid === "volume")
			target.compose.source = "services: {}\nvolumes: {}\n";
		if (invalid === "network-name")
			target.compose.source =
				"services: {}\nnetworks:\n  default:\n    name: devenv-local\n";
		if (invalid === "isolated") target.compose.network = "isolated";
		if (invalid === "borrower")
			target.compose.networkFrom = { app: "postgres", target: "run" };
		if (invalid === "boolean") target.compose.networkOnly = "true";
		if (invalid === "secret")
			target.secretRefs = { PASSWORD: "NO_PRIVATE_VALUE" };
		if (invalid === "endpoint")
			target.endpoints = { app: "http://127.0.0.1:12345" };
		if (invalid === "telemetry")
			target.telemetry = {
				protocol: "otlp-http-json",
				listen: "0.0.0.0:0",
				collectorService: "imagined",
				transport: "tls-host-gateway-v1",
			};
		const host = serve(app);
		try {
			const url = new URL(host.url),
				token = new URLSearchParams(url.hash.slice(1)).get("token"),
				post = async (route: string, body: unknown) => {
					const response = await fetch(new URL(route, url), {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});
					expect(response.status).toBe(200);
					return response.json();
				};
			const draft = await post("/api/environments/drafts", {
					requestId: "create",
					content: JSON.stringify(data),
				}),
				checked = await post("/api/environments/drafts/preflight", {
					requestId: "candidate",
					id: draft.id,
					revision: draft.revision,
					digest: draft.digest,
					validateStagedCandidate: true,
				});
			expect(checked.accepted).not.toBe(true);
			expect(readEngineFile(file(config)).history).toHaveLength(0);
			const snapshot = await app.snapshot();
			expect(snapshot.tasks).toHaveLength(0);
			expect(snapshot.reviews).toHaveLength(0);
			expect(snapshot.environments.runs).toHaveLength(0);
		} finally {
			host.stop();
		}
	});
