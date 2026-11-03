import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Minimal Kubernetes HTTP/CLI boundary: bounded PodList, Pod creation and
// UID-preconditioned deletion. No scheduler, container or cluster simulation.
const client = `import fs from "node:fs";
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{pods:{},serial:0};
const args=process.argv.slice(2),method=args.find(v=>["get","create","delete"].includes(v)),uri=args[args.indexOf("--raw")+1],url=new URL(uri,"https://127.0.0.1"),name=url.pathname.split("/").at(-1);
console.error("private-api-output");let result;
if(method==="get"){const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const pod=s.pods[filter.slice("metadata.name=".length)];result={kind:"PodList",items:pod?[pod]:[]};}
else{const body=JSON.parse(fs.readFileSync(0,"utf8"));if(method==="create"){const name=body.metadata.name;if(s.pods[name])process.exit(1);body.metadata.uid="11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");body.metadata.resourceVersion=String(s.serial);body.status={phase:process.env.FIXTURE_UNREADY==="yes"?"Failed":"Running",conditions:[{type:"Ready",status:process.env.FIXTURE_UNREADY==="yes"?"False":"True"}],containerStatuses:process.env.FIXTURE_UNREADY==="yes"?[{name:"app",state:{terminated:{exitCode:7}}}]:[]};body.metadata.annotations={private:"private-api-output"};s.pods[name]=body;result=body;}
else if(method==="delete"){const pod=s.pods[name];if(!pod||body.preconditions?.uid!==pod.metadata.uid||body.preconditions?.resourceVersion!==pod.metadata.resourceVersion)process.exit(1);delete s.pods[name];result={kind:"Status",status:"Success"};}else process.exit(2);}
if(method!=="get")fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(result));`;
test("explicit bare pods acquire only after approval, reach API readiness, clean up owned UIDs and preserve replacements", async () => {
	for (const scenario of ["ready", "replacement", "unready"]) {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configureLocalCluster(config, client, {
				FIXTURE_STATE: path.join(config.configDir, "pods.json"),
				FIXTURE_UNREADY: scenario === "unready" ? "yes" : "no",
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
		if (scenario !== "unready") {
			await pendingReview(app, task, "Hold pods");
			const run = (await app.environments.snapshot()).runs[0];
			expect(run?.state).toBe("running");
			expect(
				run?.runtimeStatuses?.filter((status) => status.health === "healthy"),
			).toHaveLength(2);
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			replacementName = Object.keys(state.pods)[0] ?? "";
			expect(state.pods[replacementName].spec.containers[0]).toMatchObject({
				image: "fixture/app:v1",
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
