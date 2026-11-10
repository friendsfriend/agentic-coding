import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { git } from "../src/git.ts";
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
const secret = "host-build-fixture-secret-only";
async function setup(mode = "ok") {
	const result = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
		const bin = path.join(config.configDir, "bin");
		fs.mkdirSync(bin);
		const record = path.join(config.configDir, "engine.json");
		fs.writeFileSync(
			record,
			JSON.stringify({ next: 1, containers: {}, history: [] }),
		);
		const engine = serveContainerFixture(record);
		engines.push(engine);
		const prefix = `#!${process.execPath}\n`;
		const instrument = `(() => { const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);if(a[2]==='build'){const c=a.at(-1),f=a[a.indexOf('--file')+1];fs.appendFileSync(process.env.HOST_EVENTS,JSON.stringify({phase:'engine'})+'\\n');fs.writeFileSync(process.env.HOST_RECEIPT,JSON.stringify({context:c,mode:fs.statSync(path.dirname(c)).mode&0o777,layers:fs.readdirSync(c).sort(),file:fs.readFileSync(f,'utf8'),contents:fs.readFileSync(path.join(c,'application','layer.txt'),'utf8'),inputIncluded:fs.existsSync(path.join(c,'input.jar'))}));}})();\n`;
		fs.writeFileSync(
			path.join(bin, "docker"),
			prefix +
				instrument +
				fs.readFileSync(
					path.join(import.meta.dir, "fixtures/container-engine.ts"),
					"utf8",
				),
			{ mode: 0o700 },
		);
		fs.writeFileSync(
			path.join(bin, "mvn"),
			prefix +
				`const fs=require('node:fs');fs.appendFileSync(process.env.HOST_EVENTS,JSON.stringify({phase:'mvn',args:process.argv.slice(2),pid:process.pid,cwd:process.cwd()})+'\\n');console.log(process.env.SERVICE_TOKEN);if(process.env.MODE==='maven-fail')process.exit(8);if(process.env.MODE==='block'){setInterval(()=>{},1000);await new Promise(()=>{});}fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/app.jar','captured-fixture-jar');if(process.env.MODE==='ambiguous')fs.writeFileSync('target/extra.jar','ambiguous');`,
			{ mode: 0o700 },
		);
		fs.writeFileSync(
			path.join(bin, "java"),
			prefix +
				`const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(process.env.HOST_EVENTS,JSON.stringify({phase:'java',args:a,pid:process.pid})+'\\n');if(process.env.MODE==='java-block'){setInterval(()=>{},1000);await new Promise(()=>{});}if(process.env.MODE==='java-fail')process.exit(7);const source=a[a.indexOf('-jar')+1],destination=a[a.indexOf('--destination')+1];for(const layer of ['dependencies','spring-boot-loader','snapshot-dependencies','application']){if(process.env.MODE==='missing-layers'&&layer==='application')continue;fs.mkdirSync(path.join(destination,layer),{recursive:true});fs.writeFileSync(path.join(destination,layer,'layer.txt'),fs.readFileSync(source));}if(process.env.MODE==='symlink')fs.symlinkSync(path.join(process.env.CONFIG_DIR,'.env'),path.join(destination,'application','private-link'));console.log(process.env.SERVICE_TOKEN);`,
			{ mode: 0o700 },
		);
		fs.writeFileSync(path.join(config.configDir, ".env"), `TOKEN=${secret}\n`, {
			mode: 0o600,
		});
		fs.writeFileSync(
			path.join(config.repositories[0] ?? "", "pom.xml"),
			"<project>synthetic host preparation fixture</project>\n",
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
						defaults: { build: "host-image" },
						targets: [
							{
								id: "host-image",
								action: "build",
								runtime: "docker",
								timeoutMs: 10000,
								environment: {
									PATH: `${bin}:${process.env.PATH ?? ""}`,
									FIXTURE_ENGINE_SOCKET: engine.socket,
									HOST_EVENTS: path.join(config.configDir, "events.ndjson"),
									HOST_RECEIPT: path.join(
										config.configDir,
										"build-receipt.json",
									),
									MODE: mode,
								},
								secretRefs: { SERVICE_TOKEN: "TOKEN" },
								container: {
									socket: engine.socket,
									image: "fixture:latest",
									hostPreparation: "spring-boot-layers-v1",
									dockerfileSource:
										"FROM fixture:latest\nCOPY application/ /app/\n",
								},
							},
						],
					},
				],
			}),
		);
	});
	const repository = result.config.repositories[0] ?? "";
	await git(repository, ["add", "pom.xml"]);
	await git(repository, ["commit", "-m", "host preparation fixture"]);
	const events = () => {
		const file = path.join(result.config.configDir, "events.ndjson");
		return fs.existsSync(file)
			? (fs
					.readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)) as {
					phase: string;
					args?: string[];
					pid?: number;
					cwd?: string;
				}[])
			: [];
	};
	const engine = () =>
		readEngineFile(path.join(result.config.configDir, "engine.json"));
	return { ...result, repository, events, engine };
}

test("exactly reviewed native host Maven/layer extraction feeds only private verified layers to the owned image adapter and redacts both phases", async () => {
	const { app, config, fake, invocation, repository, events, engine } =
		await setup();
	let transcript = "";
	fake.setResponses([
		call("env_build", { app: "api" }),
		(value) => {
			transcript = JSON.stringify(value.messages);
			return fauxAssistantMessage("Native host image built.");
		},
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	expect(JSON.parse(review.snapshot).hostBuildScope).toContain(
		"argv-only host mvn",
	);
	expect(events()).toHaveLength(0);
	expect(engine().history).toHaveLength(0);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(events().map((entry) => entry.phase)).toEqual([
		"mvn",
		"java",
		"engine",
	]);
	expect(events()[0]?.args).toEqual(["-B", "-DskipTests", "package"]);
	expect(events()[1]?.args?.slice(0, 2)).toEqual([
		"-Djarmode=layertools",
		"-jar",
	]);
	const receipt = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "build-receipt.json"), "utf8"),
	);
	expect(receipt).toMatchObject({
		mode: 0o700,
		layers: [
			"application",
			"dependencies",
			"snapshot-dependencies",
			"spring-boot-loader",
		],
		contents: "captured-fixture-jar",
		inputIncluded: false,
	});
	expect(fs.existsSync(receipt.context)).toBe(false);
	expect(fs.existsSync(path.join(repository, "target"))).toBe(false);
	const runs = (await app.environments.snapshot()).runs;
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({ state: "exited", exitCode: 0 });
	expect(
		fs.readFileSync(
			path.join(runs[0]?.plan.cwd ?? "", "target/app.jar"),
			"utf8",
		),
	).toBe("captured-fixture-jar");
	expect(transcript).not.toContain(secret);
	expect(
		JSON.stringify(await app.environments.logs("api", task)),
	).not.toContain(secret);
}, 15000);

for (const mode of [
	"maven-fail",
	"java-fail",
	"ambiguous",
	"missing-layers",
	"symlink",
])
	test(`native host preparation refuses ${mode} before any image effect and retains task outputs without adopting private paths`, async () => {
		const { app, config, fake, invocation, events, engine } = await setup(mode);
		fake.setResponses([
			call("env_build", { app: "api" }),
			fauxAssistantMessage("Preparation refused without image dispatch."),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await app.harness.waitForTask(task as TaskId, context);
		expect(engine().history).toHaveLength(0);
		expect(events().some((entry) => entry.phase === "engine")).toBe(false);
		expect(events().map((entry) => entry.phase)).toEqual(
			["maven-fail", "ambiguous"].includes(mode) ? ["mvn"] : ["mvn", "java"],
		);
		expect(
			fs
				.readdirSync(config.stateDir)
				.filter((name) => name.startsWith("environment-host-build-")),
		).toHaveLength(0);
		expect(fs.readFileSync(path.join(config.configDir, ".env"), "utf8")).toBe(
			`TOKEN=${secret}\n`,
		);
		expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
		expect((await app.environments.snapshot()).runs[0]?.error).toBeTruthy();
	}, 15000);

test("cancelling native host Maven preparation joins its original process group and never dispatches Java or the image adapter", async () => {
	const { app, fake, invocation, events, engine } = await setup("block");
	fake.setResponses([call("env_build", { app: "api" })]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await eventually(
		async () => events(),
		(entries) => entries.some((entry) => entry.phase === "mvn"),
	);
	const pid = events()[0]?.pid;
	if (!pid) throw new Error("Missing synthetic Maven PID");
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(() => process.kill(pid, 0)).toThrow();
	expect(events().map((entry) => entry.phase)).toEqual(["mvn"]);
	expect(engine().history).toHaveLength(0);
}, 15000);

test("authenticated host-preparation schema refuses run actions, unknown protocols, uncaptured recipes, foreign contexts and hidden BuildKit secret exposure", async () => {
	const { app, config } = await setup();
	const definition = JSON.parse(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		),
		base = definition.projects[0].targets[0],
		host = serve(app),
		url = new URL(host.url),
		token = new URLSearchParams(url.hash.slice(1)).get("token");
	try {
		for (const [index, target] of [
			{ ...base, action: "run" },
			{ ...base, container: { ...base.container, hostPreparation: "unknown" } },
			{
				...base,
				container: { ...base.container, dockerfileSource: undefined },
			},
			{ ...base, container: { ...base.container, context: "target" } },
			{
				...base,
				container: {
					...base.container,
					buildSecrets: { credential: { env: "SERVICE_TOKEN" } },
				},
			},
		].entries()) {
			const response = await fetch(new URL("/api/environments/drafts", url), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					requestId: `host-fence-${index}`,
					content: JSON.stringify({
						...definition,
						projects: [
							{
								...definition.projects[0],
								defaults: undefined,
								targets: [target],
							},
						],
					}),
				}),
			});
			expect(response.status).toBe(200);
			const draft = await response.json();
			const checked = await fetch(
				new URL("/api/environments/drafts/preflight", url),
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						requestId: `host-check-${index}`,
						id: draft.id,
						revision: draft.revision,
						digest: draft.digest,
					}),
				},
			);
			expect(await checked.json()).toMatchObject({
				schemaAccepted: null,
				completed: false,
			});
		}
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
	} finally {
		host.stop();
	}
});

test("cancelling native layer extraction settles the original Java group before private artifact cleanup and never dispatches an image build", async () => {
	const { app, config, fake, invocation, events, engine } =
		await setup("java-block");
	fake.setResponses([call("env_build", { app: "api" })]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await eventually(
		async () => events(),
		(entries) => entries.some((entry) => entry.phase === "java"),
	);
	const pid = events().find((entry) => entry.phase === "java")?.pid;
	if (!pid) throw new Error("Missing synthetic Java PID");
	expect(
		fs
			.readdirSync(config.stateDir)
			.some((name) => name.startsWith("environment-host-build-")),
	).toBe(true);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(() => process.kill(pid, 0)).toThrow();
	expect(engine().history).toHaveLength(0);
	expect(events().map((entry) => entry.phase)).toEqual(["mvn", "java"]);
	expect(
		fs
			.readdirSync(config.stateDir)
			.filter((name) => name.startsWith("environment-host-build-")),
	).toHaveLength(0);
}, 15000);

test("rejecting exact host-build review starts no host tool, private context or engine effect", async () => {
	const { app, config, fake, invocation, events, engine } = await setup();
	fake.setResponses([
		call("env_build", { app: "api" }),
		fauxAssistantMessage("No host or image build authorized."),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	await app.decide(review.id, review.revision, "rejected", "Do not build");
	await app.harness.waitForTask(task as TaskId, context);
	expect(events()).toHaveLength(0);
	expect(engine().history).toHaveLength(0);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(
		fs
			.readdirSync(config.stateDir)
			.filter((name) => name.startsWith("environment-host-build-")),
	).toHaveLength(0);
}, 15000);
