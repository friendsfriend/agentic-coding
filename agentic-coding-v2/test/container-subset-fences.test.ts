import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// The container adapter admits declared loopback-only targets: every narrowing
// refusal fires at schema inspection, before approval or any engine contact.
// Parser details stay withheld by design, so this proves the refusal boundary,
// not the messages.
const refusedTargets: Array<[string, Record<string, unknown>]> = [
	["unknown field", { privileged: true }],
	["relative socket", { socket: "engine.sock" }],
	["image with whitespace", { image: "fixture late st" }],
	["image with leading dash", { image: "-evil" }],
	["invalid name", { name: "/bad" }],
	["literal build argument", { buildArgs: ["SECRET=abc"] }],
	["out-of-range port", { ports: [{ host: 0, container: 8080 }] }],
	[
		"non-loopback publish address",
		{ ports: [{ host: 18080, container: 8080, address: "example.com" }] },
	],
	[
		"invalid port protocol",
		{ ports: [{ host: 18080, container: 8080, protocol: "sctp" }] },
	],
	["absolute mount source", { mounts: [{ source: "/data", target: "/data" }] }],
	["multiline health command", { health: { command: "check\nbypass" } }],
	[
		"unitless health duration",
		{ health: { command: "check", interval: "soon" } },
	],
	["out-of-range health retries", { health: { command: "check", retries: 0 } }],
	["non-boolean completion", { completion: "yes" }],
	["unknown readiness", { readiness: "sometimes" }],
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
											id: "run",
											action: "run",
											runtime: "docker",
											container: {
												socket: `${config.stateDir}/engine.sock`,
												image: "fixture:latest",
												...override,
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
			expect(loaded.schema.valid).toBe(false);
		} finally {
			host.stop();
			await app.close();
		}
	},
);
test("schema inspection still admits the supported container subset", async () => {
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
					requestId: "loopback-only",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: config.repositories[0] ?? "",
								targets: [
									{
										id: "run",
										action: "run",
										runtime: "docker",
										container: {
											socket: `${config.stateDir}/engine.sock`,
											image: "fixture:latest",
											command: ["run"],
											ports: [{ host: 18080, container: 8080 }],
											mounts: [{ source: "data", target: "/data" }],
											health: { command: "check --ready" },
											readiness: "healthy",
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
