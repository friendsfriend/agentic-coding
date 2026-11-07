import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { EnvironmentRun } from "../src/environment/state.ts";
import { serve } from "../src/server/index.ts";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
// Minimal Kubernetes HTTP/CLI boundary: bounded PodList, Pod creation and
// UID-preconditioned deletion. No scheduler, container or cluster simulation.
const client = `import fs from "node:fs";
if(process.env.FIXTURE_CALLS)fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({parent:process.ppid,forward:process.argv.slice(2).includes("port-forward")})+"\\n");
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{pods:{},serial:0,gate:process.env.FIXTURE_GATE!=="closed"};
const args=process.argv.slice(2);
if(args.includes("port-forward")){setInterval(()=>{},1000);}
else if(args.includes("logs")){const lines=JSON.parse(process.env.FIXTURE_LOG_LINES??"[]");for(const line of lines)console.log(args.includes("--timestamps")?line.at+" "+line.text:line.text);if(args.includes("--follow"))setInterval(()=>{},1000);process.exitCode=0;}
else{
const method=args.find(v=>["get","create","delete"].includes(v)),uri=args[args.indexOf("--raw")+1],url=new URL(uri,"https://127.0.0.1"),name=url.pathname.split("/").at(-1);
console.error("private-api-output");let result;
if(method==="get"){const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const pod=s.pods[filter.slice("metadata.name=".length)];if(pod&&s.gate===false)pod.status.conditions=[{type:"Ready",status:"False"}];result={kind:"PodList",items:pod?[pod]:[]};}
else{const body=JSON.parse(fs.readFileSync(0,"utf8"));if(method==="create"){const name=body.metadata.name;if(s.pods[name])process.exit(1);body.metadata.uid="11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");body.metadata.resourceVersion=String(s.serial);body.status={phase:process.env.FIXTURE_UNREADY==="yes"?"Failed":"Running",conditions:[{type:"Ready",status:process.env.FIXTURE_UNREADY==="yes"?"False":"True"}],containerStatuses:process.env.FIXTURE_UNREADY==="yes"?[{name:"app",state:{terminated:{exitCode:7}}}]:[]};body.metadata.annotations={private:"private-api-output"};s.pods[name]=body;result=body;}
else if(method==="delete"){const pod=s.pods[name];if(!pod||body.preconditions?.uid!==pod.metadata.uid||body.preconditions?.resourceVersion!==pod.metadata.resourceVersion)process.exit(1);delete s.pods[name];result={kind:"Status",status:"Success"};}else process.exit(2);}
if(method!=="get")fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(result));}`;
test("explicit bare pods acquire only after approval, reach API readiness, clean up owned UIDs and preserve replacements", async () => {
	for (const scenario of ["ready", "replacement", "unready"]) {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configureLocalCluster(config, client, {
				FIXTURE_STATE: path.join(config.configDir, "pods.json"),
				FIXTURE_UNREADY: scenario === "unready" ? "yes" : "no",
				FIXTURE_GATE: scenario === "ready" ? "closed" : "open",
			});
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"FIXTURE_SECRET=fixture-pod-sensitive-value\n",
				{ mode: 0o600 },
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
									id: "pods",
									action: "run",
									runtime: "kubernetes",
									timeoutMs: 5000,
									kubernetes: {
										cluster: "local",
										namespace: "fixtures",
										image: "fixture/app:v1",
										replicas: 2,
										readinessProbe:
											scenario === "replacement"
												? { tcpSocket: { port: 8080 }, periodSeconds: 1 }
												: {
														httpGet: { path: "/ready", port: 8080 },
														periodSeconds: 1,
													},
									},
									secretRefs: { TOKEN: "FIXTURE_SECRET" },
								},
							],
						},
					],
				}),
			);
		});
		let transcript = "";
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_start", { apps: ["api"], runtime: "kubernetes" }),
				{ stopReason: "toolUse" },
			),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return scenario === "unready"
					? fauxAssistantMessage("Readiness failed")
					: fauxAssistantMessage(
							fauxToolCall("request_review", { path: ".", title: "Hold pods" }),
							{ stopReason: "toolUse" },
						);
			},
		]);
		const task = await app.startTask(invocation);
		await pendingReview(app, task);
		const stateFile = path.join(config.configDir, "pods.json");
		expect(fs.existsSync(stateFile)).toBe(false);
		await approve(app, task);
		let replacementName = "";
		const gate = (open: boolean) => {
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			state.gate = open;
			fs.writeFileSync(`${stateFile}.new`, JSON.stringify(state));
			fs.renameSync(`${stateFile}.new`, stateFile);
		};
		if (scenario === "ready") {
			await eventually(
				async () =>
					fs.existsSync(stateFile)
						? Object.keys(JSON.parse(fs.readFileSync(stateFile, "utf8")).pods)
								.length
						: 0,
				(count) => count === 2,
			);
			expect((await app.environments.snapshot()).runs[0]?.state).toBe(
				"reserved",
			);
			expect(transcript).toBe("");
			gate(true);
		}
		if (scenario !== "unready") {
			await pendingReview(app, task, "Hold pods");
			const run = (await app.environments.snapshot()).runs[0];
			expect(run?.state).toBe("running");
			expect(
				run?.runtimeStatuses?.filter((status) => status.health === "healthy"),
			).toHaveLength(2);
			if (scenario === "ready") {
				gate(false);
				await eventually(
					() => app.environments.snapshot(),
					(state) =>
						state.runs[0]?.runtimeStatuses?.every(
							(status) => status.health === "unhealthy",
						) === true,
				);
				expect((await app.environments.snapshot()).runs[0]?.state).toBe(
					"running",
				);
				gate(true);
				await eventually(
					() => app.environments.snapshot(),
					(state) =>
						state.runs[0]?.runtimeStatuses?.every(
							(status) => status.health === "healthy",
						) === true,
				);
			}
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			replacementName = Object.keys(state.pods)[0] ?? "";
			expect(state.pods[replacementName].spec.containers[0]).toMatchObject({
				image: "fixture/app:v1",
				readinessProbe:
					scenario === "replacement"
						? { tcpSocket: { port: 8080 } }
						: { httpGet: { path: "/ready", port: 8080, scheme: "HTTP" } },
				env: expect.arrayContaining([
					{ name: "TOKEN", value: "fixture-pod-sensitive-value" },
				]),
			});
			if (scenario === "replacement")
				state.pods[replacementName].metadata.uid =
					"ffffffff-2222-3333-4444-555555555555";
			state.pods.foreign = {
				kind: "Pod",
				metadata: {
					name: "foreign",
					namespace: "fixtures",
					uid: "aaaaaaaa-2222-3333-4444-555555555555",
				},
			};
			fs.writeFileSync(`${stateFile}.new`, JSON.stringify(state));
			fs.renameSync(`${stateFile}.new`, stateFile);
			await app.cancel(task);
		}
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript).not.toContain("private-api-output");
		expect(transcript).not.toContain("fixture-pod-sensitive-value");
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8")),
			run = (await app.environments.snapshot()).runs[0];
		if (scenario === "replacement") {
			expect(state.pods[replacementName]?.metadata.uid).toBe(
				"ffffffff-2222-3333-4444-555555555555",
			);
			expect(Object.keys(state.pods)).toHaveLength(2);
			expect(run?.state).toBe("interrupted");
		} else {
			expect(Object.keys(state.pods)).toEqual(
				scenario === "ready" ? ["foreign"] : [],
			);
			expect(
				run?.state,
				JSON.stringify({
					scenario,
					output: run?.output,
					error: run?.error,
					status: run?.runtimeStatuses,
				}),
			).toBe("exited");
		}
		expect(run?.exitCode).toBe(scenario === "unready" ? 7 : null);
		expect(
			fs
				.readdirSync(config.stateDir)
				.some((name) => name.startsWith("cluster-inspection-")),
		).toBe(false);
	}
}, 20000);

test("killed Pod hosts retain only diagnostic UIDs and quarantine occupancy without client calls until authenticated inspection", async () => {
	const state = await fixture(true, (config) => {
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
						targets: [
							{
								id: "pods",
								action: "run",
								runtime: "kubernetes",
								timeoutMs: 5000,
								kubernetes: {
									cluster: "local",
									namespace: "fixtures",
									image: "fixture/app:v1",
									replicas: 1,
								},
							},
						],
					},
				],
			}),
		);
	});
	await state.app.close();
	apps.splice(apps.indexOf(state.app), 1);
	const inputFile = path.join(state.config.stateDir, "pod-host-input.json"),
		readyFile = path.join(state.config.stateDir, "pod-host-ready.json"),
		podFile = path.join(state.config.configDir, "pods.json"),
		callsFile = path.join(state.config.configDir, "pod-calls.jsonl");
	const foreign = {
		kind: "Pod",
		metadata: {
			name: "foreign",
			namespace: "fixtures",
			uid: "aaaaaaaa-2222-3333-4444-555555555555",
		},
	};
	fs.writeFileSync(
		podFile,
		JSON.stringify({ pods: { foreign }, serial: 0, gate: true }),
	);
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: state.config,
			invocation: state.invocation,
			readyFile,
			target: "pods",
			runtime: "kubernetes",
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: state.invocation.repository,
			env: { PATH: process.env.PATH, HOME: state.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
				id: number;
				run: EnvironmentRun;
			},
			statuses = ready.run.runtimeStatuses ?? [];
		expect(statuses).toHaveLength(1);
		const uid = statuses[0]?.id;
		if (!uid) throw new Error("Missing live Pod UID observation");
		expect(statuses[0]).toMatchObject({
			kind: "pod",
			state: "running",
			owned: true,
		});
		host.kill("SIGKILL");
		await host.exited;
		// A pre-crash client may enter after SIGKILL. Attribute observations to
		// the emitting host rather than claiming crash cancels already-issued effects.
		// PIDs here are fixture audit data only, never cleanup/adoption authority.
		const callsFromRestoredHost = () =>
			fs
				.readFileSync(callsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { parent: number })
				.filter((call) => call.parent === process.pid);
		const restored = await state.open(),
			quarantined = (await restored.environments.snapshot()).runs[0];
		if (!quarantined) throw new Error("Missing interrupted Pod receipt");
		expect(quarantined).toMatchObject({ state: "interrupted", exitCode: null });
		expect(quarantined.runtimeStatuses?.map((status) => status.id)).toEqual(
			statuses.map((status) => status.id),
		);
		expect(
			quarantined.runtimeStatuses?.every(
				(status) =>
					status.state === "unknown" &&
					status.owned === null &&
					status.health === null,
			),
		).toBe(true);
		await expect(
			restored.environments.stopOnce("pod-crash-stop", ready.id, ["api"]),
		).rejects.toThrow();
		await restored.cancel(ready.id);
		const cancelled = await restored.harness.waitForTask(
			ready.id as TaskId,
			context,
		);
		expect(cancelled.state.outcome).toMatchObject({
			status: "aborted",
			reason: expect.stringContaining("Resources remain quarantined"),
		});
		expect(callsFromRestoredHost()).toEqual([]);
		// The fixture operator removes only these synthetic UIDs, not a namespace,
		// labels or names that could authorize touching an unrelated/replacement Pod.
		const pods = JSON.parse(fs.readFileSync(podFile, "utf8")),
			uids = new Set(statuses.map((status) => status.id));
		expect(
			Object.values(
				pods.pods as Record<string, { metadata: { uid: string } }>,
			).map((pod) => pod.metadata.uid),
		).toContain(uid);
		for (const [name, pod] of Object.entries(
			pods.pods as Record<string, { metadata: { uid: string } }>,
		))
			if (uids.has(pod.metadata.uid)) delete pods.pods[name];
		expect(pods.pods).toEqual({ foreign });
		fs.writeFileSync(podFile, JSON.stringify(pods));
		const server = serve(restored);
		try {
			const url = new URL(server.url),
				endpoint = `${url.origin}/api/environments/release`,
				body = JSON.stringify({
					id: quarantined.id,
					revision: quarantined.revision,
					inspectionConfirmed: true,
				});
			expect((await fetch(endpoint, { method: "POST", body })).status).toBe(
				401,
			);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
							"Content-Type": "application/json",
						},
						body,
					})
				).status,
			).toBe(200);
			expect((await restored.environments.snapshot()).runs[0]).toMatchObject({
				state: "exited",
				exitCode: null,
				inspection: { revision: quarantined.revision },
			});
			expect(callsFromRestoredHost()).toEqual([]);
		} finally {
			await server.stop();
		}
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
	}
}, 15000);

test("a single owned replica exposes its pod log buffer with the pod's own timestamps", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configureLocalCluster(config, client, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_LOG_LINES: JSON.stringify([
				{ at: "2000-01-01T00:00:00.000000001Z", text: "old [x] first" },
				{ at: "2000-01-02T00:00:00.000000002Z", text: "old [x] second" },
				{ at: "2999-12-31T23:59:59.999999999Z", text: "new [x] third" },
			]),
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
						targets: [
							{
								id: "pods",
								action: "run",
								runtime: "kubernetes",
								timeoutMs: 5000,
								kubernetes: {
									cluster: "local",
									namespace: "fixtures",
									image: "fixture/app:v1",
									replicas: 1,
									readinessProbe: {
										httpGet: { path: "/ready", port: 8080 },
										periodSeconds: 1,
									},
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
			fauxToolCall("request_review", { path: ".", title: "Hold pod" }),
			{ stopReason: "toolUse" },
		),
	]);
	const task = await app.startTask({ ...invocation, requestId: "pod-logs" });
	await approve(app, task);
	await pendingReview(app, task, "Hold pod");
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs[0]?.ready === true,
	);
	const observed = await app.environments.selectedLogs("api", task, {
		grep: "[x]",
		since: "2500-01-01T00:00:00Z",
	});
	const run = observed.runs[0];
	expect(run?.output).toBe("new [x] third\n");
	expect(run?.timeSelection).toMatchObject({
		basis: "provider-event-time-completed-lines",
		availability: "available",
	});
	expect(run?.framing).toBe("single-pod-buffer-provider-event-time");
	expect(JSON.stringify(observed)).not.toContain("2999-");
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const pods = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "pods.json"), "utf8"),
	);
	expect(Object.keys(pods.pods)).toHaveLength(0);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
}, 20000);

test("a port forward with several replicas is refused instead of choosing a pod", async () => {
	await expect(
		fixture(false, (config) => {
			configureLocalCluster(config, client, {
				FIXTURE_STATE: path.join(config.configDir, "pods.json"),
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
							targets: [
								{
									id: "pods",
									action: "run",
									runtime: "kubernetes",
									kubernetes: {
										cluster: "local",
										namespace: "fixtures",
										image: "fixture/app:v1",
										replicas: 2,
										portForwards: [{ local: 18080, remote: 8080 }],
									},
								},
							],
						},
					],
				}),
			);
		}),
	).rejects.toThrow("exactly one replica");
});

test("a declared port forward is loopback-only and joined into cancellation cleanup", async () => {
	const calls = (config: { configDir: string }) =>
		fs
			.readFileSync(path.join(config.configDir, "client-calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configureLocalCluster(config, client, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_LOG_LINES: "[]",
			FIXTURE_CALLS: path.join(config.configDir, "client-calls.jsonl"),
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
						targets: [
							{
								id: "pods",
								action: "run",
								runtime: "kubernetes",
								timeoutMs: 5000,
								kubernetes: {
									cluster: "local",
									namespace: "fixtures",
									image: "fixture/app:v1",
									replicas: 1,
									portForwards: [{ local: 18080, remote: 8080 }],
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
			fauxToolCall("request_review", { path: ".", title: "Hold forward" }),
			{ stopReason: "toolUse" },
		),
	]);
	const task = await app.startTask({ ...invocation, requestId: "pod-forward" });
	await approve(app, task);
	await pendingReview(app, task, "Hold forward");
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs[0]?.ready === true,
	);
	const forwarded = calls(config).filter((call) => call.forward === true);
	expect(forwarded).toHaveLength(1);
	// A forward is not readiness or endpoint authority for the run.
	expect((await app.environments.snapshot()).runs[0]?.ready).toBe(true);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const pods = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "pods.json"), "utf8"),
	);
	expect(Object.keys(pods.pods)).toHaveLength(0);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
}, 20000);
