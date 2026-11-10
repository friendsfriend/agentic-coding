import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

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
const stateFile = (config: Config) =>
	path.join(config.configDir, "engine.json");
function configure(
	config: Config,
	provider: "docker" | "podman" = "docker",
	collision = false,
	endpoint?: URL,
) {
	fs.mkdirSync(config.configDir);
	fs.chmodSync(config.stateDir, 0o700);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	const source = `#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`;
	for (const runtime of ["docker", "podman"])
		fs.writeFileSync(path.join(bin, runtime), source, { mode: 0o700 });
	fs.writeFileSync(
		stateFile(config),
		JSON.stringify({
			next: 1,
			containers: {},
			history: [],
			workloadPrerequisite: "healthy",
		}),
	);
	const server = serveContainerFixture(stateFile(config));
	engines.push(server);
	const target = (service: string, borrow = false) => ({
		id: "stack",
		action: "run",
		runtime: "compose",
		timeoutMs: 10000,
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: server.socket,
		},
		...(borrow ? { prerequisites: [{ app: "infra", target: "stack" }] } : {}),
		compose: {
			file: "compose.captured.yaml",
			provider,
			socket: server.socket,
			network: "shared",
			...(borrow ? { networkFrom: { app: "infra", target: "stack" } } : {}),
			source: `services:\n  ${service}:\n    image: fixture:latest\n    command: [serve]\n    healthcheck:\n      test: [CMD, 'true']\n${borrow && endpoint ? `    ports: ['127.0.0.1:${endpoint.port}:8080']\n` : ""}`,
		},
		...(borrow && endpoint
			? {
					endpoints: { web: endpoint.href },
					endpointServices: { web: service },
				}
			: {}),
	});
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "infra",
					kind: "infrastructure",
					repository: config.repositories[0],
					targets: [target("worker")],
				},
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [target(collision ? "worker" : "web", true)],
				},
				{
					id: "other",
					kind: "app",
					repository: config.repositories[0],
					targets: [target("consumer", true)],
				},
			],
		}),
	);
}
for (const provider of ["docker", "podman"] as const)
	test(`native ${provider} prerequisite bridge creates one original network, preserves cross-stack discovery and removes it only after dependent containers`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configure(config, provider),
		);
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("request_review", { title: "Hold bridge", path: "." }),
		]);
		const task = await app.startTask(invocation),
			review = await pendingReview(app, task);
		expect(JSON.parse(review.snapshot).prerequisiteBridgeScope).toContain(
			"original ready same-owner",
		);
		expect(readEngineFile(stateFile(config)).history).toHaveLength(0);
		await approve(app, task);
		await pendingReview(app, task, "Hold bridge");
		const state = readEngineFile(stateFile(config));
		expect(Object.keys(state.networks ?? {})).toHaveLength(1);
		const containers = Object.values(state.containers);
		expect(containers).toHaveLength(2);
		expect(containers.every((container) => container.State.Running)).toBe(true);
		expect(
			new Set(containers.map((container) => container.NetworkId)).size,
		).toBe(1);
		expect(
			state.history.filter(
				(args) => args[2] === "network" && args[3] === "create",
			),
		).toHaveLength(1);
		await app.cancel(task);
		const stopped = readEngineFile(stateFile(config));
		expect(Object.keys(stopped.containers)).toHaveLength(0);
		expect(Object.keys(stopped.networks ?? {})).toHaveLength(0);
		const networkDelete = stopped.history.findIndex(
			(args) => args[2] === "network" && args[3] === "rm",
		);
		expect(networkDelete).toBeGreaterThan(
			stopped.history.findLastIndex((args) => args[2] === "rm"),
		);
	}, 20000);

test("a foreign infrastructure prerequisite shares only its approved owner-bound captured-commit generation, never the dirty developer checkout", async () => {
	const foreign = await fixture(false);
	const repository = foreign.invocation.repository;
	fs.writeFileSync(
		path.join(repository, "README.md"),
		"dirty-developer-marker\n",
	);
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		config.repositories.push(repository);
		const file = path.join(config.configDir, "environments.json"),
			data = JSON.parse(fs.readFileSync(file, "utf8"));
		data.projects[0].repository = repository;
		fs.writeFileSync(file, JSON.stringify(data));
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { title: "Foreign bridge held", path: "." }),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task),
		plans = JSON.parse(review.snapshot).plans;
	const planned = plans.find((plan: { app: string }) => plan.app === "infra");
	expect(planned.dependencyWorkspace.repository).toBe(repository);
	expect(fs.existsSync(planned.workspace)).toBe(false);
	expect(readEngineFile(stateFile(config)).history).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Foreign bridge held");
	const infra = (await app.environments.snapshot("infra")).runs[0];
	expect(infra?.plan.workspace).not.toBe(repository);
	expect(
		fs.readFileSync(
			path.join(infra?.plan.workspace ?? "", "README.md"),
			"utf8",
		),
	).toBe("Initial\n");
	expect(
		Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
	).toHaveLength(1);
	await app.cancel(task);
	expect(fs.readFileSync(path.join(repository, "README.md"), "utf8")).toBe(
		"dirty-developer-marker\n",
	);
	expect(fs.existsSync(planned.workspace)).toBe(true);
	expect(
		Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
	).toHaveLength(0);
}, 20000);

test("referenced roots in one reviewed batch independently settle members while retaining their exact common prerequisite bridge", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", {
			apps: ["api", "other"],
			lifetime: "referenced-roots-v1",
		}),
		call("request_review", { title: "Referenced both", path: "." }),
		call("env_stop", { apps: ["api"] }),
		call("request_review", { title: "Referenced survivor", path: "." }),
		call("env_stop", { apps: ["other"] }),
		call("request_review", { title: "References settled", path: "." }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Referenced both");
	expect(
		Object.keys(readEngineFile(stateFile(config)).containers),
	).toHaveLength(3);
	await approve(app, task, "Referenced both");
	await pendingReview(app, task, "Referenced survivor");
	const state = readEngineFile(stateFile(config));
	expect(Object.keys(state.containers)).toHaveLength(2);
	expect(Object.keys(state.networks ?? {})).toHaveLength(1);
	expect(
		state.history.some((args) => args[2] === "network" && args[3] === "rm"),
	).toBe(false);
	await approve(app, task, "Referenced survivor");
	await pendingReview(app, task, "References settled");
	expect(
		Object.keys(readEngineFile(stateFile(config)).containers),
	).toHaveLength(0);
	expect(
		Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
	).toHaveLength(0);
	await app.cancel(task);
}, 20000);

test("same-owner shared acquisitions retain the original bridge and infrastructure until the last dependent settles", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		call("env_start", { apps: ["other"], lifetime: "shared-prerequisites-v1" }),
		call("request_review", { title: "Both roots", path: "." }),
		call("env_stop", { apps: ["api"] }),
		call("request_review", { title: "One root", path: "." }),
		call("env_stop", { apps: ["other"] }),
		call("request_review", { title: "No roots", path: "." }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Both roots");
	let state = readEngineFile(stateFile(config));
	expect(Object.values(state.containers)).toHaveLength(3);
	expect(Object.keys(state.networks ?? {})).toHaveLength(1);
	expect(
		state.history.filter(
			(args) => args[2] === "network" && args[3] === "create",
		),
	).toHaveLength(1);
	await approve(app, task, "Both roots");
	await pendingReview(app, task, "One root");
	state = readEngineFile(stateFile(config));
	expect(Object.values(state.containers)).toHaveLength(2);
	expect(
		Object.values(state.containers).some((container) =>
			container.Aliases?.includes("consumer"),
		),
	).toBe(true);
	expect(Object.keys(state.networks ?? {})).toHaveLength(1);
	expect(
		state.history.some((args) => args[2] === "network" && args[3] === "rm"),
	).toBe(false);
	await approve(app, task, "One root");
	await pendingReview(app, task, "No roots");
	state = readEngineFile(stateFile(config));
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
	await app.cancel(task);
}, 25000);

test("conflicting cross-stack DNS aliases refuse a dependent before creation and roll back only the original acquisition", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		configure(config, "docker", true),
	);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		fauxAssistantMessage("No ambiguous alias accepted"),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	const state = readEngineFile(stateFile(config));
	expect(state.history.filter((args) => args[2] === "create")).toHaveLength(1);
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
	const runs = await app.environments.logs("api", task, true);
	expect(runs[0]?.ready).not.toBe(true);
	expect(runs[0]?.state).toBe("exited");
}, 15000);

test("original native endpoint admission refuses changing bridge membership while a sibling creation acknowledgement is pending", async () => {
	let requests = 0;
	const web = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests++;
			return new Response("synthetic");
		},
	});
	try {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configure(config, "docker", false, new URL(web.url)),
		);
		fake.setResponses([
			call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
			call("request_review", { title: "First root", path: "." }),
			call("env_start", {
				apps: ["other"],
				lifetime: "shared-prerequisites-v1",
			}),
			call("request_review", { title: "Settled members", path: "." }),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await pendingReview(app, task, "First root");
		const state = readEngineFile(stateFile(config));
		state.startDelayMs = 1500;
		fs.writeFileSync(stateFile(config), JSON.stringify(state));
		await approve(app, task, "First root");
		await approve(app, task);
		await eventually(
			async () => readEngineFile(stateFile(config)),
			(state) =>
				Object.values(state.containers).some(
					(container) =>
						container.Aliases?.includes("consumer") && container.State.Running,
				),
		);
		const owner = (await app.snapshot()).tasks.find(
			(entry) => entry.id === task,
		);
		if (!owner) throw Error("No native owner");
		await expect(
			app.environments.http.prepare(owner, "api", "web", "/"),
		).rejects.toThrow("membership is changing");
		expect(requests).toBe(0);
		await pendingReview(app, task, "Settled members");
		await app.cancel(task);
		expect(
			Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
		).toHaveLength(0);
	} finally {
		web.stop(true);
	}
}, 20000);

test("foreign bridge attachments refuse native HTTP diagnostics and are never disconnected or removed during owned cleanup", async () => {
	let requests = 0;
	const web = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests++;
			return new Response("synthetic");
		},
	});
	try {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configure(config, "docker", false, new URL(web.url)),
		);
		let observed = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("request_review", { title: "Hold bridge", path: "." }),
			call("env_http_request", { app: "api", endpoint: "web" }),
			(messages) => {
				observed = JSON.stringify(messages.messages.at(-1));
				return call("request_review", {
					title: "Diagnostic refused",
					path: ".",
				});
			},
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await pendingReview(app, task, "Hold bridge");
		const state = readEngineFile(stateFile(config)),
			network = Object.values(state.networks ?? {})[0];
		if (!network) throw Error("No original bridge");
		const foreign = "f".repeat(64);
		network.Containers[foreign] = { Name: "unowned-attachment" };
		fs.writeFileSync(stateFile(config), JSON.stringify(state));
		await approve(app, task, "Hold bridge");
		await pendingReview(app, task, "Diagnostic refused");
		expect(requests).toBe(0);
		expect(observed).toContain("without an original live creation receipt");
		expect(observed).not.toContain("must-not-leak-private-network-metadata");
		await app.cancel(task);
		const stopped = readEngineFile(stateFile(config));
		expect(Object.keys(stopped.containers)).toHaveLength(0);
		expect(
			Object.values(stopped.networks ?? {})[0]?.Containers[foreign],
		).toEqual({ Name: "unowned-attachment" });
		expect(
			stopped.history.some(
				(args) =>
					args[2] === "network" && ["disconnect", "rm"].includes(args[3] ?? ""),
			),
		).toBe(false);
	} finally {
		web.stop(true);
	}
}, 20000);

test("uncertain dependent identity retains its bridge claim and quarantines shared bridge diagnostics without deleting the changed resource", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	let observed = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		call("env_start", { apps: ["other"], lifetime: "shared-prerequisites-v1" }),
		call("request_review", { title: "Held originals", path: "." }),
		call("env_stop", { apps: ["api"] }),
		call("request_review", { title: "Uncertain original", path: "." }),
		call("env_logs", { app: "other" }),
		(messages) => {
			observed = JSON.stringify(messages.messages.at(-1));
			return call("request_review", { title: "Bridge quarantined", path: "." });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Held originals");
	const state = readEngineFile(stateFile(config)),
		changed = Object.values(state.containers).find((container) =>
			container.Aliases?.includes("web"),
		);
	if (!changed) throw Error("No original dependent");
	changed.Config.Labels["dev.agentic-coding.v2.run"] = "foreign";
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await approve(app, task, "Held originals");
	await pendingReview(app, task, "Uncertain original");
	await approve(app, task, "Uncertain original");
	await pendingReview(app, task, "Bridge quarantined");
	expect(observed).toContain("bridge authority are quarantined");
	expect(
		readEngineFile(stateFile(config)).containers[changed.Id]?.Config.Labels[
			"dev.agentic-coding.v2.run"
		],
	).toBe("foreign");
	await app.cancel(task);
	const stopped = readEngineFile(stateFile(config));
	expect(stopped.containers[changed.Id]).toBeDefined();
	expect(Object.keys(stopped.networks ?? {})).toHaveLength(1);
	expect(
		stopped.history.some((args) => args[2] === "network" && args[3] === "rm"),
	).toBe(false);
}, 20000);

for (const health of ["missing", "unhealthy"] as const)
	test(`a declared infrastructure health probe must be freshly healthy before bridge binding: ${health}`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configure(config);
			const state = readEngineFile(stateFile(config));
			state.initialHealth = health;
			fs.writeFileSync(stateFile(config), JSON.stringify(state));
			const file = path.join(config.configDir, "environments.json"),
				data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.projects[0].targets[0].timeoutMs = 2500;
			fs.writeFileSync(file, JSON.stringify(data));
		});
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			fauxAssistantMessage("No unhealthy bridge granted"),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await app.harness.waitForTask(task as TaskId, context);
		const state = readEngineFile(stateFile(config));
		expect(state.history.filter((args) => args[2] === "create")).toHaveLength(
			1,
		);
		expect(Object.keys(state.containers)).toHaveLength(0);
		expect(Object.keys(state.networks ?? {})).toHaveLength(0);
		expect((await app.environments.snapshot("api")).runs[0]?.ready).not.toBe(
			true,
		);
	}, 15000);

test("a configured bridge exporter waits for its declared probe within the reviewed startup budget before any dependent container is created", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		const state = readEngineFile(stateFile(config));
		state.initialHealth = "starting";
		fs.writeFileSync(stateFile(config), JSON.stringify(state));
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { title: "Qualified bridge", path: "." }),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	const planned = JSON.parse(review.snapshot).plans.find(
		(plan: { app: string }) => plan.app === "infra",
	);
	expect(planned.composePlan.services[0].container.readiness).toBe("healthy");
	await approve(app, task);
	await eventually(
		async () => readEngineFile(stateFile(config)),
		(state) =>
			Object.values(state.containers).some(
				(container) =>
					container.Aliases?.includes("worker") &&
					container.State.Running &&
					state.history.filter(
						(args) => args[2] === "inspect" && args.at(-1) === container.Id,
					).length >= 3,
			),
	);
	const state = readEngineFile(stateFile(config)),
		worker = Object.values(state.containers).find((container) =>
			container.Aliases?.includes("worker"),
		);
	if (!worker) throw Error("No original worker");
	expect(Object.keys(state.containers)).toHaveLength(1);
	worker.State.Health = { Status: "healthy" };
	state.initialHealth = undefined;
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await pendingReview(app, task, "Qualified bridge");
	expect((await app.environments.snapshot("api")).runs[0]?.ready).toBe(true);
	await app.cancel(task);
	expect(
		Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
	).toHaveLength(0);
}, 15000);

test("an explicitly running-only infrastructure bridge never fabricates a health probe", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		const file = path.join(config.configDir, "environments.json"),
			data = JSON.parse(fs.readFileSync(file, "utf8"));
		for (const project of data.projects)
			project.targets[0].compose.source =
				project.targets[0].compose.source.replace(
					"    healthcheck:\n      test: [CMD, 'true']\n",
					"",
				);
		fs.writeFileSync(file, JSON.stringify(data));
		const state = readEngineFile(stateFile(config));
		state.initialHealth = "missing";
		state.workloadPrerequisite = "running";
		fs.writeFileSync(stateFile(config), JSON.stringify(state));
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { title: "Running only", path: "." }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Running only");
	expect((await app.environments.snapshot("api")).runs[0]?.ready).toBe(true);
	expect(
		Object.values(readEngineFile(stateFile(config)).containers).every(
			(container) => container.State.Health === undefined,
		),
	).toBe(true);
	await app.cancel(task);
	expect(
		Object.keys(readEngineFile(stateFile(config)).networks ?? {}),
	).toHaveLength(0);
}, 15000);

test("a copied-label replacement bridge cannot mint a later shared acquisition binding or be removed by original cleanup", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		call("request_review", { title: "Original scope", path: "." }),
		call("env_start", { apps: ["other"], lifetime: "shared-prerequisites-v1" }),
		call("request_review", { title: "Replacement refused", path: "." }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Original scope");
	const state = readEngineFile(stateFile(config)),
		original = Object.values(state.networks ?? {})[0];
	if (!original || !state.networks) throw Error("Missing original bridge");
	delete state.networks[original.Id];
	const replacement = "e".repeat(64);
	state.networks[replacement] = { ...original, Id: replacement };
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await approve(app, task, "Original scope");
	await approve(app, task);
	await pendingReview(app, task, "Replacement refused");
	const refused = readEngineFile(stateFile(config));
	expect(refused.history.filter((args) => args[2] === "create")).toHaveLength(
		2,
	);
	expect(
		refused.history.filter(
			(args) => args[2] === "network" && args[3] === "create",
		),
	).toHaveLength(1);
	expect((await app.environments.snapshot("other")).runs[0]?.ready).not.toBe(
		true,
	);
	await app.cancel(task);
	const stopped = readEngineFile(stateFile(config));
	expect(stopped.networks?.[replacement]?.Id).toBe(replacement);
	expect(
		stopped.history.some((args) => args[2] === "network" && args[3] === "rm"),
	).toBe(false);
}, 20000);

test("authenticated saved-input bridge preflight binds descriptors without minting a live network capability or workloads", async () => {
	const { app, config } = await fixture(false, configure);
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
			content: fs.readFileSync(
				path.join(config.configDir, "environments.json"),
				"utf8",
			),
		});
		const candidate = await post("/api/environments/drafts/preflight", {
			requestId: "candidate",
			id: draft.id,
			revision: draft.revision,
			digest: draft.digest,
			validateStagedCandidate: true,
		});
		expect(candidate.accepted).toBe(true);
		expect(candidate.entries).toHaveLength(3);
		expect(candidate.publicationAllowed).toBe(false);
		expect(readEngineFile(stateFile(config)).history).toHaveLength(0);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(snapshot.environments.runs).toHaveLength(0);
	} finally {
		host.stop();
	}
});

for (const invalid of [
	"wrong-target",
	"different-socket",
	"raw-network-id",
	"missing-edge",
	"app-provider",
	"different-provider",
	"isolated",
] as const)
	test(`authenticated staging refuses prerequisite bridge ${invalid} without workloads`, async () => {
		const { app, config } = await fixture(false, configure);
		const document = JSON.parse(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		);
		const infra = document.projects[0],
			dependent = document.projects[1].targets[0];
		if (invalid === "missing-edge") delete dependent.prerequisites;
		if (invalid === "wrong-target")
			dependent.compose.networkFrom.target = "other";
		if (invalid === "different-socket")
			dependent.compose.socket = "/tmp/acv2-no-other-engine.sock";
		if (invalid === "raw-network-id")
			dependent.compose.networkFrom.id = "e".repeat(64);
		if (invalid === "app-provider") infra.kind = "app";
		if (invalid === "different-provider") dependent.compose.provider = "podman";
		if (invalid === "isolated") dependent.compose.network = "isolated";
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
					content: JSON.stringify(document),
				}),
				checked = await post("/api/environments/drafts/preflight", {
					requestId: "check",
					id: draft.id,
					revision: draft.revision,
					digest: draft.digest,
				});
			expect(checked.schemaAccepted).toBeNull();
			expect(readEngineFile(stateFile(config)).history).toHaveLength(0);
			expect((await app.snapshot()).tasks).toHaveLength(0);
		} finally {
			host.stop();
		}
	});
