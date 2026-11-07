import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// The native Compose adapter refuses unsupported effects rather than guessing.
// Staging stores bytes unvalidated; the check and candidate boundaries refuse
// to parse them, and materialization requires a complete candidate. Parser and
// source details stay withheld by design, so this proves the refusal boundary,
// not the messages.
const refusedSources: Array<[string, string]> = [
	[
		"unknown top-level field",
		`services:\n  api:\n    image: fixture:latest\nnetworks: {}\n`,
	],
	[
		"unknown service field",
		`services:\n  api:\n    image: fixture:latest\n    privileged: true\n`,
	],
	["interpolation", `services:\n  api:\n    image: fixture:\${TAG}\n`],
	["invalid YAML", "services:\n  api: [unclosed\n"],
	["empty service set", "services: {}\n"],
	[
		"invalid service identifier",
		`services:\n  API:\n    image: fixture:latest\n`,
	],
	[
		"dependency cycle",
		"services:\n  a:\n    image: fixture:latest\n    depends_on: [b]\n  b:\n    image: fixture:latest\n    depends_on: [a]\n",
	],
	[
		"unknown dependency",
		`services:\n  api:\n    image: fixture:latest\n    depends_on: [ghost]\n`,
	],
	[
		"unsupported dependency condition",
		"services:\n  api:\n    image: fixture:latest\n    depends_on:\n      db:\n        condition: whenever\n  db:\n    image: fixture:latest\n",
	],
	[
		"exec-form healthcheck",
		`services:\n  api:\n    image: fixture:latest\n    healthcheck:\n      test: [CMD, curl, localhost]\n`,
	],
	[
		"healthcheck disable combination",
		`services:\n  api:\n    image: fixture:latest\n    healthcheck:\n      disable: true\n      test: curl localhost\n`,
	],
	[
		"named volume",
		`services:\n  api:\n    image: fixture:latest\n    volumes:\n      - type: volume\n        source: data\n        target: /data\n`,
	],
	[
		"absolute bind source",
		`services:\n  api:\n    image: fixture:latest\n    volumes:\n      - type: bind\n        source: /data\n        target: /data\n`,
	],
	[
		"restart policy",
		`services:\n  api:\n    image: fixture:latest\n    restart: always\n`,
	],
	[
		"multiple env files",
		`services:\n  api:\n    image: fixture:latest\n    env_file:\n      - one.env\n      - two.env\n`,
	],
	[
		"non-string environment",
		`services:\n  api:\n    image: fixture:latest\n    environment:\n      PORT: 8080\n`,
	],
];
test.each(refusedSources)(
	"staged Compose source with %s is stored but refused at every validation boundary",
	async (label, content) => {
		void label;
		const { app, config, open } = await fixture(true, (config) => {
			fs.chmodSync(config.stateDir, 0o700);
			fs.mkdirSync(config.configDir, { mode: 0o700 });
		});
		void open;
		const host = serve(app);
		try {
			const headers = () => ({
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			});
			const post = (route: string, body: unknown) =>
				fetch(new URL(route, host.url), {
					method: "POST",
					headers: headers(),
					body: JSON.stringify(body),
				});
			const repo = config.repositories[0] ?? "";
			const created = await (
				await post("/api/environments/drafts", {
					requestId: "create",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: repo,
								targets: [
									{
										id: "stack",
										action: "run",
										runtime: "compose",
										compose: {
											file: "compose.yaml",
											provider: "docker",
											socket: path.join(config.stateDir, "absent-engine.sock"),
										},
									},
								],
							},
						],
					}),
				})
			).json();
			const staged = await (
				await post("/api/environments/drafts/source", {
					requestId: "stage",
					id: created.id,
					revision: created.revision,
					app: "api",
					target: "stack",
					content,
				})
			).json();
			const check = {
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				app: "api",
				target: "stack",
				useStagedSource: true,
			};
			const refused = await (
				await post("/api/environments/drafts/preflight", {
					...check,
					requestId: "check",
				})
			).json();
			expect(refused).toMatchObject({
				kind: "staged-compose-source",
				accepted: false,
			});
			const candidate = await (
				await post("/api/environments/drafts/preflight", {
					requestId: "candidate",
					id: created.id,
					revision: staged.revision,
					digest: staged.digest,
					validateStagedCandidate: true,
				})
			).json();
			expect(
				candidate.entries.find(
					(entry: { app: string; target: string }) =>
						entry.app === "api" && entry.target === "stack",
				).status,
			).toBe("refused");
			const assembled = await (
				await post("/api/environments/drafts/preflight", {
					requestId: "assemble",
					id: created.id,
					revision: staged.revision,
					digest: staged.digest,
					materializeStagedTree: true,
				})
			).json();
			expect(assembled.accepted).toBe(false);
		} finally {
			host.stop();
			await app.close();
		}
	},
);
test("the supported Compose subset parses, assembles and survives reopen", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let host = serve(app);
	try {
		const headers = () => ({
			Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		});
		const post = (route: string, body: unknown) =>
			fetch(new URL(route, host.url), {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
			});
		const repo = config.repositories[0] ?? "";
		const created = await (
			await post("/api/environments/drafts", {
				requestId: "create",
				content: JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: repo,
							targets: [
								{
									id: "stack",
									action: "run",
									runtime: "compose",
									compose: {
										file: "compose.yaml",
										provider: "docker",
										socket: path.join(config.stateDir, "absent-engine.sock"),
									},
								},
							],
						},
					],
				}),
			})
		).json();
		const staged = await (
			await post("/api/environments/drafts/source", {
				requestId: "stage",
				id: created.id,
				revision: created.revision,
				app: "api",
				target: "stack",
				content:
					"services:\n" +
					"  db:\n" +
					"    image: fixture-db:latest\n" +
					"    restart: no\n" +
					"  api:\n" +
					"    image: fixture:latest\n" +
					"    command: [serve, --port, '8080']\n" +
					"    environment:\n" +
					"      PORT: '8080'\n" +
					"    ports:\n" +
					"      - target: 8080\n" +
					"        published: 18080\n" +
					"    volumes:\n" +
					"      - type: bind\n" +
					"        source: ./data\n" +
					"        target: /data\n" +
					"    depends_on:\n" +
					"      db:\n" +
					"        condition: service_started\n" +
					"    healthcheck:\n" +
					"      test: curl --fail http://localhost:8080\n",
			})
		).json();
		const check = {
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			app: "api",
			target: "stack",
			useStagedSource: true,
		};
		const accepted = await (
			await post("/api/environments/drafts/preflight", {
				...check,
				requestId: "check",
			})
		).json();
		expect(accepted).toMatchObject({
			kind: "staged-compose-source",
			accepted: true,
			serviceCount: 2,
		});
		const candidate = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "candidate",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				validateStagedCandidate: true,
			})
		).json();
		expect(
			candidate.entries.find(
				(entry: { app: string; target: string }) =>
					entry.app === "api" && entry.target === "stack",
			),
		).toMatchObject({ status: "parsed", serviceCount: 2 });
		const assembled = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "assemble",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
			})
		).json();
		expect(assembled.accepted).toBe(true);
		host.stop();
		await app.close();
		host = serve(await open());
		expect(
			await (
				await post("/api/environments/drafts/preflight", {
					...check,
					requestId: "recheck",
				})
			).json(),
		).toMatchObject({ accepted: true, serviceCount: 2 });
	} finally {
		host.stop();
	}
});
