import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// The Kubernetes adapter admits bare pods only. Draft creation stores content
// unvalidated; the schema inspection boundary refuses unsupported targets
// there, before approval, reservation or any cluster contact. Parser details
// stay withheld by design, so this proves the refusal boundary, not messages.
const base = {
	cluster: "fixture",
	namespace: "work",
	image: "fixture:latest",
	command: ["run"],
	replicas: 1,
	readinessProbe: {
		httpGet: { path: "/ready", port: 8080 },
		periodSeconds: 10,
		timeoutSeconds: 5,
	},
	portForwards: [{ local: 18080, remote: 8080 }],
};
const refusedTargets: Array<[string, Record<string, unknown>]> = [
	["unknown target field", { hostNetwork: true }],
	["default namespace", { namespace: "default" }],
	["kube-system namespace", { namespace: "kube-system" }],
	["non-array command", { command: "run" }],
	["zero replicas", { replicas: 0 }],
	["excess replicas", { replicas: 17 }],
	["forwards with several replicas", { replicas: 2 }],
	[
		"forward bind field",
		{ portForwards: [{ local: 18080, remote: 8080, address: "0.0.0.0" }] },
	],
	[
		"duplicate forward locals",
		{
			portForwards: [
				{ local: 18080, remote: 8080 },
				{ local: 18080, remote: 9090 },
			],
		},
	],
	["out-of-range forward port", { portForwards: [{ local: 0, remote: 8080 }] }],
	["exec probe", { readinessProbe: { exec: { command: ["check"] } } }],
	["grpc probe", { readinessProbe: { grpc: { port: 8080 } } }],
	[
		"probe host override",
		{
			readinessProbe: {
				httpGet: { path: "/ready", port: 8080, host: "example" },
			},
		},
	],
	[
		"both probe kinds",
		{
			readinessProbe: {
				httpGet: { path: "/ready", port: 8080 },
				tcpSocket: { port: 8080 },
			},
		},
	],
	["no probe kind", { readinessProbe: {} }],
	[
		"timeout beyond period",
		{
			readinessProbe: {
				tcpSocket: { port: 8080 },
				periodSeconds: 10,
				timeoutSeconds: 20,
			},
		},
	],
	[
		"non-relative probe path",
		{ readinessProbe: { httpGet: { path: "ready", port: 8080 } } },
	],
];
test.each(refusedTargets)(
	"schema inspection refuses a draft with %s",
	async (label, override) => {
		void label;
		const { app, config } = await fixture(true, (config) => {
			fs.chmodSync(config.stateDir, 0o700);
			fs.mkdirSync(config.configDir, { mode: 0o700 });
		});
		const host = serve(app);
		try {
			const headers = {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
			const created = await (
				await fetch(new URL("/api/environments/drafts", host.url), {
					method: "POST",
					headers,
					body: JSON.stringify({
						requestId: "stored-unvalidated",
						content: JSON.stringify({
							version: 1,
							projects: [
								{
									id: "api",
									kind: "app",
									repository: config.repositories[0] ?? "",
									targets: [
										{
											id: "pods",
											action: "run",
											runtime: "kubernetes",
											kubernetes: { ...base, ...override },
										},
									],
								},
							],
						}),
					}),
				})
			).json();
			const loaded = await (
				await fetch(
					new URL(`/api/environments/drafts?id=${created.id}`, host.url),
					{
						headers,
					},
				)
			).json();
			expect(loaded.schema.valid).toBe(false);
		} finally {
			host.stop();
			await app.close();
		}
	},
);
test("schema inspection still admits the supported bare-pod subset", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	try {
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		};
		const created = await (
			await fetch(new URL("/api/environments/drafts", host.url), {
				method: "POST",
				headers,
				body: JSON.stringify({
					requestId: "bare-pods",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: config.repositories[0] ?? "",
								targets: [
									{
										id: "pods",
										action: "run",
										runtime: "kubernetes",
										kubernetes: {
											...base,
											readinessProbe: { tcpSocket: { port: 5432 } },
										},
									},
								],
							},
						],
					}),
				}),
			})
		).json();
		const loaded = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{
					headers,
				},
			)
		).json();
		expect(loaded.schema.valid).toBe(true);
	} finally {
		host.stop();
		await app.close();
	}
});
