import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { readEngineFile } from "./fixtures/container-server.ts";
import { approve } from "./fixtures/environment.ts";
import {
	configureTopologyFixture,
	infrastructureServices as ids,
	topologyEngineFile,
} from "./fixtures/network-topology.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof configureTopologyFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
function inputs(config: Config) {
	const source = path.join(path.dirname(config.configDir), "v1-source");
	for (const directory of [
		"apps/build",
		"apps/compose",
		"apps/run",
		"infrastructure/compose",
		"infrastructure/definitions",
	])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({ version: 1, projects: [] }),
	);
	fs.writeFileSync(
		path.join(source, "infrastructure/compose/network-compose.yml"),
		"networks:\n  devenv-local:\n    driver: bridge\n",
	);
	for (const id of ids) {
		fs.writeFileSync(
			path.join(source, `infrastructure/definitions/${id}.json`),
			JSON.stringify({
				ident: id,
				displayName: `Fixture ${id}`,
				containerBaseName: `legacy-${id}`,
			}),
		);
		fs.writeFileSync(
			path.join(source, `infrastructure/compose/${id}-compose.yml`),
			Bun.YAML.stringify({
				include: ["../../infrastructure/compose/network-compose.yml"],
				name: "legacy-global",
				services: {
					[id]: {
						image: "fixture:latest",
						container_name: `legacy-${id}`,
						command: ["serve"],
						restart: "always",
						networks: ["devenv-local"],
						ports: [`${45000 + ids.indexOf(id)}:${9000 + ids.indexOf(id)}`],
						...(id === "redis" ? { volumes: ["data:/data"] } : {}),
						...(id === "playwright-server" ? { shm_size: "512m" } : {}),
					},
				},
				...(id === "redis" ? { volumes: { data: {} } } : {}),
			}),
		);
	}
	return source;
}
function preview(
	config: Config,
	source: string,
	outputName: string,
	repository: string | undefined = config.repositories[0],
) {
	const output = path.join(path.dirname(config.configDir), outputName);
	const child = Bun.spawnSync(
		[
			process.execPath,
			path.join(import.meta.dir, "../scripts/preview-environment-migration.ts"),
			"--source-config",
			source,
			"--current-config",
			config.configDir,
			"--output",
			output,
			"--socket",
			engines.at(-1)?.socket ?? "/tmp/absent-fixture.sock",
			...(repository ? ["--infrastructure-repository", repository] : []),
		],
		{ cwd: config.repositories[0], stdout: "pipe", stderr: "pipe" },
	);
	expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
	const content = fs.readFileSync(
		path.join(output, "environments.json"),
		"utf8",
	);
	return {
		output,
		content,
		document: JSON.parse(content),
		report: JSON.parse(
			fs.readFileSync(path.join(output, "report.json"), "utf8"),
		),
	};
}
function gateway(app: Runtime) {
	const host = serve(app),
		token =
			new URLSearchParams(new URL(host.url).hash.slice(1)).get("token") ?? "";
	return {
		host,
		post: (route: string, body: unknown) =>
			fetch(new URL(route, host.url), {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
	};
}
async function preflight(
	post: ReturnType<typeof gateway>["post"],
	content: string,
	requestId: string,
) {
	const createdResponse = await post("/api/environments/drafts", {
		requestId,
		content,
	});
	expect(createdResponse.status).toBe(200);
	const created = await createdResponse.json();
	const checkedResponse = await post("/api/environments/drafts/preflight", {
		requestId: `${requestId}-check`,
		id: created.id,
		revision: created.revision,
		digest: created.digest,
	});
	expect(checkedResponse.status).toBe(200);
	return { created, checked: await checkedResponse.json() };
}

test("explicit captured six-service infrastructure maps through authenticated publication and protected native lifecycle without source execution or a keeper", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		config.profiles = [];
		engines.push(configureTopologyFixture(config));
	});
	const source = inputs(config),
		captured = preview(config, source, "infrastructure-preview");
	const initial = gateway(app);
	let second: ReturnType<typeof gateway> | undefined;
	try {
		expect(captured.report.infrastructureMapping.status).toBe("candidate");
		expect(
			captured.report.infrastructureMapping.recommendedOperatorLifetime,
		).toBe("operator-infrastructure-v3");
		expect(
			captured.report.infrastructureMapping.lifetimeEnforcedByConfiguration,
		).toBe(false);
		expect(captured.report.infrastructureMapping.projects).toHaveLength(7);
		expect(captured.report.requiredRepositoryApprovals).toEqual([]);
		expect(captured.report.runtimeValidated).toBe(false);
		expect(captured.report.fullParityArchived).toBe(false);
		expect(captured.report.liveConfigurationChanged).toBe(false);
		expect(
			captured.report.defaultDecisions.every(
				(row: { status: string }) => row.status === "captured-infrastructure",
			),
		).toBe(true);
		expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
		const { checked } = await preflight(
			initial.post,
			captured.content,
			"captured-global-infrastructure",
		);
		expect(checked.schemaAccepted).toBe(true);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe('{"version":1,"projects":[]}');
		// Substitute only the disposable engine transport. Captured service bytes,
		// target pins and topology effects are unchanged; no real Docker is used.
		for (const project of captured.document.projects)
			for (const target of project.targets)
				target.environment = {
					PATH: `${path.join(config.configDir, "bin")}:${process.env.PATH ?? ""}`,
					FIXTURE_ENGINE_SOCKET: engines.at(-1)?.socket,
				};
		const runnableContent = JSON.stringify(captured.document);
		const { created } = await preflight(
			initial.post,
			runnableContent,
			"synthetic-global-transport",
		);
		const promotedResponse = await initial.post(
			"/api/environments/drafts/promote",
			{
				requestId: "fixture-only-explicit-publication",
				id: created.id,
				revision: created.revision,
				digest: created.digest,
				approve: created.digest,
			},
		);
		expect(promotedResponse.status, await promotedResponse.clone().text()).toBe(
			200,
		);
		expect((await promotedResponse.json()).outcome).toBe("written");
		expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
		await initial.host.stop();
		await app.close();
		const reopened = await open();
		second = gateway(reopened);
		const started = await second.post("/api/environments/actions", {
			requestId: "run-captured-infrastructure",
			apps: ids.map((id) => `host-infra-${id}`),
			action: "run",
			target: "run-compose-default",
			lifetime: "operator-infrastructure-v3",
		});
		expect(started.status, await started.clone().text()).toBe(200);
		const { taskId: owner } = (await started.json()) as { taskId: number };
		await approve(reopened, owner);
		await eventually(
			async () => {
				await Bun.sleep(25);
				return reopened.snapshot();
			},
			(snapshot) =>
				snapshot.environments.runs.length === 7 &&
				snapshot.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		const engine = readEngineFile(topologyEngineFile(config));
		expect(Object.keys(engine.containers)).toHaveLength(6);
		expect(
			Object.values(engine.containers)
				.map((container) => container.Name.replace(/^\//, ""))
				.sort(),
		).toEqual(ids.map((id) => `legacy-${id}`).sort());
		expect(Object.keys(engine.networks ?? {})).toHaveLength(1);
		const bridge = Object.values(engine.networks ?? {})[0]?.Id;
		expect(
			Object.values(engine.containers).every(
				(container) => container.NetworkId === bridge,
			),
		).toBe(true);
		expect(Object.keys(engine.volumes ?? {})).toHaveLength(1);
		const creates = engine.history.filter((args) => args[2] === "create");
		expect(creates).toHaveLength(6);
		expect(
			creates.every(
				(args) =>
					args[args.indexOf("--restart") + 1] === "always" &&
					args[args.indexOf("--publish") + 1]?.startsWith("127.0.0.1:"),
			),
		).toBe(true);
		expect(
			creates.some(
				(args) =>
					args.includes("--shm-size") &&
					args[args.indexOf("--shm-size") + 1] === "536870912",
			),
		).toBe(true);
		for (const id of ids) {
			const run = (await reopened.snapshot()).environments.runs.find(
				(run) => run.plan.app === `host-infra-${id}`,
			);
			if (!run) throw new Error("Missing captured infrastructure unit");
			expect(run.plan.projectKind).toBe("infrastructure");
			expect(run.plan.operatorRoot).toBe(true);
			const stopped = await second.post("/api/environments/units/stop", {
				requestId: `stop-${id}`,
				runId: run.id,
				revision: run.revision,
				reason: "Independently stop this captured native service",
			});
			expect(stopped.status, await stopped.clone().text()).toBe(200);
		}
		expect(
			Object.keys(readEngineFile(topologyEngineFile(config)).containers),
		).toHaveLength(0);
		expect(
			Object.values(
				readEngineFile(topologyEngineFile(config)).networks ?? {},
			)[0]?.Id,
		).toBe(bridge);
		await reopened.cancel(owner);
		await reopened.harness.waitForTask(owner as TaskId, context);
		expect(
			Object.keys(readEngineFile(topologyEngineFile(config)).networks ?? {}),
		).toHaveLength(0);
		expect(
			Object.keys(readEngineFile(topologyEngineFile(config)).volumes ?? {}),
		).toHaveLength(1);
		expect((await reopened.snapshot()).messages).toHaveLength(0);
		expect(
			fs.readFileSync(
				path.join(source, "infrastructure/compose/network-compose.yml"),
				"utf8",
			),
		).toBe("networks:\n  devenv-local:\n    driver: bridge\n");
	} finally {
		await initial.host.stop();
		await second?.host.stop();
	}
}, 45000);

test("proposed repository mapping remains an inert policy prerequisite and cannot authorize itself at authenticated native preflight", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const source = inputs(config),
		repository = path.join(path.dirname(config.configDir), "not-allowlisted");
	fs.mkdirSync(repository);
	const captured = preview(config, source, "unapproved-repository", repository);
	const { host, post } = gateway(app);
	try {
		expect(captured.report.requiredRepositoryApprovals).toEqual([
			fs.realpathSync(repository),
		]);
		expect(captured.report.infrastructureMapping.status).toBe("candidate");
		const { created, checked } = await preflight(
			post,
			captured.content,
			"no-repository-self-approval",
		);
		expect(checked.schemaAccepted).toBeNull();
		expect(checked.completed).toBe(false);
		expect(checked.entries).toEqual([]);
		expect(
			(
				await post("/api/environments/drafts/promote", {
					requestId: "cannot-self-authorize-repository",
					id: created.id,
					revision: created.revision,
					digest: created.digest,
					approve: created.digest,
				})
			).status,
		).toBe(400);
		expect((await app.snapshot()).tasks).toHaveLength(0);
		expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
		expect(
			fs.readFileSync(path.join(config.configDir, "config.json"), "utf8"),
		).not.toContain(repository);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe('{"version":1,"projects":[]}');
	} finally {
		await host.stop();
	}
});
test("source credentials become required references, never copied values or a fabricated service-health declaration", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const source = inputs(config);
	for (const id of ["redis", "postgres"]) {
		const file = path.join(source, `infrastructure/compose/${id}-compose.yml`),
			value = Bun.YAML.parse(fs.readFileSync(file, "utf8")) as {
				services: Record<string, Record<string, unknown>>;
			};
		const service = value.services[id];
		if (!service) throw new Error("Missing synthetic source");
		if (id === "redis")
			service.command = "redis-server --requirepass fixture-literal-never-copy";
		else service.environment = ["POSTGRES_PASSWORD=fixture-pg-never-copy"];
		fs.writeFileSync(file, Bun.YAML.stringify(value));
	}
	const captured = preview(config, source, "reference-only-infrastructure");
	expect(captured.content).not.toContain("fixture-literal-never-copy");
	expect(captured.content).not.toContain("fixture-pg-never-copy");
	expect(captured.report.references).toContain("V2_REDIS_PASSWORD");
	expect(captured.report.references).toContain("V2_POSTGRES_POSTGRES_PASSWORD");
	expect(captured.report.infrastructureMapping.effectsNotClaimed).toContain(
		"service health beyond the captured source readiness",
	);
	const { host, post } = gateway(app);
	try {
		const { checked } = await preflight(
			post,
			captured.content,
			"reference-only-check",
		);
		expect(checked.schemaAccepted).toBe(true);
		expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
	} finally {
		await host.stop();
	}
});
for (const corruption of [
	"metadata",
	"network",
	"service-effect",
	"collision",
	"missing-definition",
	"source-link",
] as const)
	test(`global source mapping refuses ${corruption} atomically instead of omitting unsupported effects`, async () => {
		const { app, config } = await fixture(false, (config) =>
			engines.push(configureTopologyFixture(config)),
		);
		const source = inputs(config),
			definition = path.join(source, "infrastructure/definitions/redis.json");
		if (corruption === "metadata")
			fs.writeFileSync(
				definition,
				JSON.stringify({
					ident: "redis",
					displayName: "Fixture redis",
					containerBaseName: "legacy-redis",
					unsupported: "must-never-leak",
				}),
			);
		else if (corruption === "network")
			fs.writeFileSync(
				path.join(source, "infrastructure/compose/network-compose.yml"),
				"networks:\n  devenv-local:\n    driver: overlay\n",
			);
		else if (corruption === "missing-definition") fs.unlinkSync(definition);
		else if (corruption === "source-link") {
			const outside = path.join(
				config.repositories[0] ?? "",
				"private-source.json",
			);
			fs.writeFileSync(outside, fs.readFileSync(definition));
			fs.unlinkSync(definition);
			fs.symlinkSync(outside, definition);
		} else if (corruption === "collision")
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "host-infra-redis",
							kind: "app",
							repository: config.repositories[0],
							targets: [],
						},
					],
				}),
			);
		else {
			const file = path.join(
				source,
				"infrastructure/compose/redis-compose.yml",
			);
			fs.writeFileSync(
				file,
				fs
					.readFileSync(file, "utf8")
					.replace(
						"image: fixture:latest",
						"privileged: true\n    image: fixture:latest",
					),
			);
		}
		const base = fs.readFileSync(
				path.join(config.configDir, "environments.json"),
				"utf8",
			),
			captured = preview(config, source, `refused-${corruption}`);
		expect(captured.report.infrastructureMapping.status).toBe("blocked");
		expect(
			captured.report.rows.filter(
				(row: { status: string }) => row.status === "candidate",
			),
		).toHaveLength(0);
		expect(
			captured.report.rows.filter(
				(row: { status: string }) => row.status === "blocked",
			),
		).toHaveLength(7);
		expect(captured.document.projects).toEqual(JSON.parse(base).projects);
		expect(JSON.stringify(captured.report)).not.toContain("must-never-leak");
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe(base);
		expect((await app.snapshot()).tasks).toHaveLength(0);
		expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
	});
test("missing explicit infrastructure workspace never infers a repository or a global lifetime", async () => {
	const { config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const source = inputs(config),
		captured = preview(config, source, "unmapped-infrastructure", "");
	expect(captured.report.infrastructureMapping.status).toBe("not-requested");
	expect(captured.document.projects).toHaveLength(0);
	expect(
		captured.report.rows.filter(
			(row: { status: string }) => row.status === "blocked",
		),
	).toHaveLength(7);
	expect(readEngineFile(topologyEngineFile(config)).history).toHaveLength(0);
});
