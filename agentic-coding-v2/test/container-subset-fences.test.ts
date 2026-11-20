import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server/index.ts";
import { environmentSchema } from "./fixtures/environment-schema.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Test every refusal at its data-only rule; one authenticated scenario below
// verifies persistence/inspection, masked details and no execution.
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
	"schema refuses a container with %s",
	(_label, override) => {
		expect(() =>
			environmentSchema([
				{
					id: "run",
					action: "run",
					runtime: "docker",
					container: {
						socket: "/schema-fixture/engine.sock",
						image: "fixture:latest",
						...override,
					},
				},
			]),
		).toThrow();
	},
);
test("schema inspection still admits the supported container subset", () => {
	expect(
		environmentSchema(
			[
				{
					id: "run",
					action: "run",
					runtime: "docker",
					container: {
						socket: `/schema-fixture/engine.sock`,
						image: "fixture:latest",
						command: ["run"],
						ports: [{ host: 18080, container: 8080 }],
						mounts: [{ source: "data", target: "/data" }],
						health: { command: "check --ready" },
						readiness: "healthy",
					},
				},
			],
			"app",
		),
	).toHaveLength(1);
});
test("authenticated draft inspection accepts supported fields and withholds semantic refusal details", async () => {
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
		const invalid = JSON.parse(loaded.content);
		invalid.projects[0].targets[0].container.privileged =
			"private-schema-marker";
		const updated = await fetch(new URL("/api/environments/drafts", host.url), {
			method: "POST",
			headers,
			body: JSON.stringify({
				requestId: "unsupported-field",
				id: created.id,
				revision: created.revision,
				content: JSON.stringify(invalid),
			}),
		});
		expect(updated.status).toBe(200);
		const refused = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{ headers },
			)
		).json();
		expect(refused.schema).toMatchObject({
			valid: false,
			scope: "schema-only",
		});
		expect(refused.schema.message).not.toContain("private-schema-marker");
		expect((await app.snapshot()).environments.runs).toHaveLength(0);
	} finally {
		host.stop();
		await app.close();
	}
});
