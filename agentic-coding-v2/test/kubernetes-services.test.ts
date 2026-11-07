import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { readKubernetes } from "../src/environment/kubernetes-config.ts";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// ClusterIP services over the same bounded CLI: declared name/port/targetPort
// only, owner-label selector, occupied names refused without adoption and
// UID-preconditioned deletion. No NodePort/external/headless support.
const client = `import fs from "node:fs";
const calls=process.env.FIXTURE_CALLS;
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{pods:{},services:{},serial:0};
const args=process.argv.slice(2);
if(args.includes("port-forward")){setInterval(()=>{},1000);}
else if(args.includes("logs")){const lines=JSON.parse(process.env.FIXTURE_LOG_LINES??"[]");for(const line of lines)console.log(line.text);if(args.includes("--follow"))setInterval(()=>{},1000);process.exitCode=0;}
else{
const method=args.find(v=>["get","create","delete"].includes(v)),uri=args[args.indexOf("--raw")+1],url=new URL(uri,"https://127.0.0.1"),parts=url.pathname.split("/"),name=parts.at(-1),svc=parts.includes("services");
console.error("private-api-output");let result;
const uid=()=>"11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");
if(method==="get"){if(svc){const found=s.services[name];if(!found)process.exit(1);result=found;}
else{const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const pod=s.pods[filter.slice("metadata.name=".length)];result={kind:"PodList",items:pod?[pod]:[]};}}
else{const body=JSON.parse(fs.readFileSync(0,"utf8"));const key=svc?"services":"pods";
if(method==="create"){if(s[key][body.metadata.name])process.exit(1);body.metadata.uid=uid();body.metadata.resourceVersion=String(s.serial);if(svc){body.metadata.namespace="fixtures";body.spec.clusterIP="10.96.0."+s.serial;body.status={};}else{body.status={phase:"Running",conditions:[{type:"Ready",status:"True"}],containerStatuses:[]};}s[key][body.metadata.name]=body;result=body;if(calls)fs.appendFileSync(calls,"create "+key+"/"+body.metadata.name+"\\n");}
else if(method==="delete"){const found=s[key][name];if(!found||body.preconditions?.uid!==found.metadata.uid||(body.preconditions?.resourceVersion&&body.preconditions.resourceVersion!==found.metadata.resourceVersion))process.exit(1);delete s[key][name];result={kind:"Status",status:"Success"};}else process.exit(2);}
if(method!=="get")fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(result));}`;
const target = (services?: unknown) => ({
	id: "pods",
	action: "run",
	runtime: "kubernetes",
	timeoutMs: 5000,
	kubernetes: {
		cluster: "local",
		namespace: "fixtures",
		image: "fixture/app:v1",
		replicas: 1,
		...(services === undefined ? {} : { services }),
	},
});
const configure = (services?: unknown) => (config: Config) => {
	configureLocalCluster(config, client, {
		FIXTURE_STATE: path.join(config.configDir, "pods.json"),
		FIXTURE_CALLS: path.join(config.configDir, "pod-calls.jsonl"),
	});
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [target(services)],
				},
			],
		}),
	);
};
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxToolCall(name, args);

test("ClusterIP service declarations admit bounded entries and refuse overrides", () => {
	const base = {
		cluster: "local",
		namespace: "fixtures",
		image: "fixture/app:v1",
	};
	expect(
		readKubernetes({
			...base,
			services: [{ name: "api", port: 80, targetPort: 8080 }],
		}).services,
	).toEqual([{ name: "api", port: 80, targetPort: 8080 }]);
	expect(readKubernetes(base).services).toEqual([]);
	for (const services of [
		[{ name: "api", port: 80, targetPort: 8080, type: "ClusterIP" }],
		[{ name: "API", port: 80, targetPort: 8080 }],
		[{ name: "-api", port: 80, targetPort: 8080 }],
		[{ name: "api-", port: 80, targetPort: 8080 }],
		[{ name: "a".repeat(64), port: 80, targetPort: 8080 }],
		[{ name: "api", port: 0, targetPort: 8080 }],
		[{ name: "api", port: 80, targetPort: 65536 }],
		[
			{ name: "api", port: 80, targetPort: 8080 },
			{ name: "api", port: 81, targetPort: 8080 },
		],
		[
			{ name: "api", port: 80, targetPort: 8080 },
			{ name: "web", port: 80, targetPort: 8080 },
		],
		[
			{ name: "a", port: 1, targetPort: 1 },
			{ name: "b", port: 2, targetPort: 2 },
			{ name: "c", port: 3, targetPort: 3 },
			{ name: "d", port: 4, targetPort: 4 },
			{ name: "e", port: 5, targetPort: 5 },
		],
		"api",
		["api"],
	])
		expect(() => readKubernetes({ ...base, services })).toThrow();
});

test("declared services select run pods before startup and delete with UID preconditions", async () => {
	const { app, config, fake, invocation } = await fixture(
		false,
		configure([{ name: "api", port: 80, targetPort: 8080 }]),
	);
	fake.setResponses([
		fauxAssistantMessage(
			call("env_start", { apps: ["api"], runtime: "kubernetes" }),
			{
				stopReason: "toolUse",
			},
		),
		() =>
			fauxAssistantMessage(
				call("request_review", { path: ".", title: "Hold services" }),
				{ stopReason: "toolUse" },
			),
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Hold services");
	const stateFile = path.join(config.configDir, "pods.json");
	await eventually(
		() =>
			fs.existsSync(stateFile)
				? JSON.parse(fs.readFileSync(stateFile, "utf8"))
				: null,
		(state: { services?: { api?: unknown }; pods?: unknown } | null) =>
			Boolean(state?.services?.api && state?.pods !== undefined),
	);
	const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const service = state.services.api;
	expect(service).toMatchObject({
		kind: "Service",
		spec: {
			type: "ClusterIP",
			ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }],
		},
	});
	expect(typeof service.spec.clusterIP).toBe("string");
	const podName = Object.keys(state.pods)[0] ?? "";
	const pod = state.pods[podName];
	expect(service.metadata.labels).toEqual(pod.metadata.labels);
	expect(service.spec.selector).toEqual(pod.metadata.labels);
	const calls = fs.readFileSync(
		path.join(config.configDir, "pod-calls.jsonl"),
		"utf8",
	);
	expect(calls.indexOf("create services/api")).toBeLessThan(
		calls.indexOf("create pods/"),
	);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const closed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	expect(closed.services).toEqual({});
	expect(closed.pods).toEqual({});
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
}, 30000);

test("occupied service names refuse without adoption and lost services quarantine cleanup", async () => {
	for (const failure of ["occupied", "missing"] as const) {
		const { app, config, fake, invocation } = await fixture(
			false,
			configure([{ name: "api", port: 80, targetPort: 8080 }]),
		);
		const stateFile = path.join(config.configDir, "pods.json");
		if (failure === "occupied")
			fs.writeFileSync(
				stateFile,
				JSON.stringify({
					pods: {},
					services: {
						api: {
							kind: "Service",
							metadata: {
								name: "api",
								namespace: "fixtures",
								uid: "aaaaaaaa-2222-3333-4444-555555555555",
								resourceVersion: "9",
								labels: { foreign: "true" },
							},
							spec: { clusterIP: "10.96.0.9" },
						},
					},
					serial: 9,
				}),
			);
		let transcript = "";
		fake.setResponses([
			fauxAssistantMessage(
				call("env_start", { apps: ["api"], runtime: "kubernetes" }),
				{
					stopReason: "toolUse",
				},
			),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return failure === "occupied"
					? fauxAssistantMessage("Service refused")
					: fauxAssistantMessage(
							call("request_review", { path: ".", title: "Hold missing" }),
							{ stopReason: "toolUse" },
						);
			},
		]);
		const task = await app.startTask(invocation);
		await pendingReview(app, task);
		await approve(app, task);
		if (failure === "occupied") {
			await app.harness.waitForTask(task as TaskId, context);
			expect(transcript).toContain("Environment execution did not complete");
			const run = (await app.environments.snapshot()).runs[0];
			expect(run?.state).toBe("exited");
			expect(
				JSON.stringify(await app.environments.logs("api", task)),
			).toContain("Service name is occupied");
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			expect(Object.keys(state.pods)).toEqual([]);
			expect(state.services.api.metadata.uid).toBe(
				"aaaaaaaa-2222-3333-4444-555555555555",
			);
		} else {
			await pendingReview(app, task, "Hold missing");
			await eventually(
				() =>
					fs.existsSync(stateFile)
						? JSON.parse(fs.readFileSync(stateFile, "utf8"))
						: null,
				(state: { services?: { api?: unknown } } | null) =>
					state?.services?.api !== undefined,
			);
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			delete state.services.api;
			fs.writeFileSync(stateFile, JSON.stringify(state));
			await app.cancel(task);
			await app.harness.waitForTask(task as TaskId, context);
			const run = (await app.environments.snapshot()).runs[0];
			expect(run?.state).toBe("interrupted");
			expect(run?.error).toContain("cleanup");
			expect(
				JSON.stringify(await app.environments.logs("api", task)),
			).toContain("Kubernetes service cleanup is uncertain");
		}
	}
}, 30000);
