import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest } from "../src/config.ts";
import {
	compileComposeSource,
	readCompose,
} from "../src/environment/compose-config.ts";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// The parser containment-checks paths. One empty temporary directory is its only
// filesystem fixture: never a Git checkout, native store, listener or engine.
let parserWorkspace = "";
beforeAll(() => {
	parserWorkspace = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "compose-rules-")),
	);
});
afterAll(() => {
	fs.rmSync(parserWorkspace, { recursive: true, force: true });
});
function parseSource(content: string) {
	return compileComposeSource(
		parserWorkspace,
		readCompose({
			file: "compose.yaml",
			provider: "docker",
			socket: path.join(parserWorkspace, "absent-engine.sock"),
		}),
		{ source: content, contentDigest: digest(content) },
	);
}
const refusedSources: Array<[string, string]> = [
	[
		"unknown top-level field",
		`services:\n  api:\n    image: fixture:latest\nsecrets: {}\n`,
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
		"empty exec-form healthcheck",
		`services:\n  api:\n    image: fixture:latest\n    healthcheck:\n      test: [CMD]\n`,
	],
	[
		"healthcheck disable combination",
		`services:\n  api:\n    image: fixture:latest\n    healthcheck:\n      disable: true\n      test: curl localhost\n`,
	],
	[
		"literal service secret instead of a reference",
		`services:\n  api:\n    image: fixture:latest\n    x-secret-refs:\n      TOKEN: not-an-env-reference!\n`,
	],
	[
		"literal overrides service secret",
		`services:\n  api:\n    image: fixture:latest\n    x-secret-refs:\n      TOKEN: FIXTURE_TOKEN\n    environment:\n      TOKEN: public-override\n`,
	],
	[
		"oversized shared memory",
		`services:\n  api:\n    image: fixture:latest\n    shm_size: 9g\n`,
	],
	[
		"host mapping argument injection",
		`services:\n  api:\n    image: fixture:latest\n    extra_hosts: ['--privileged:host-gateway']\n`,
	],
	[
		"undeclared named volume",
		`services:\n  api:\n    image: fixture:latest\n    volumes:\n      - type: volume\n        source: data\n        target: /data\n`,
	],
	[
		"external volume adoption",
		`volumes:\n  data:\n    external: true\nservices:\n  api:\n    image: fixture:latest\n    volumes: [data:/data]\n`,
	],
	[
		"external network adoption",
		`networks:\n  existing:\n    external: true\nservices:\n  api:\n    image: fixture:latest\n    networks: [existing]\n`,
	],
	[
		"implicit environment inheritance",
		`services:\n  api:\n    image: fixture:latest\n    environment: [TOKEN]\n`,
	],
	[
		"unclosed command quote",
		`services:\n  api:\n    image: fixture:latest\n    command: "probe 'unclosed"\n`,
	],
	[
		"absolute bind source",
		`services:\n  api:\n    image: fixture:latest\n    volumes:\n      - type: bind\n        source: /data\n        target: /data\n`,
	],
	[
		"invalid restart policy",
		`services:\n  api:\n    image: fixture:latest\n    restart: on-failure:101\n`,
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

test.each(refusedSources)("Compose parser refuses %s", (_label, content) => {
	expect(() => parseSource(content)).toThrow();
});
test("Compose parser admits the supported subset without a runtime", () => {
	expect(() =>
		parseSource(
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
		),
	).not.toThrow();
});
test("staged Compose refuses unsupported effects, then parses, assembles and survives reopen", async () => {
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

		const rejected = await (
			await post("/api/environments/drafts/source", {
				requestId: "stage-unsupported",
				id: created.id,
				revision: created.revision,
				app: "api",
				target: "stack",
				content:
					"services:\n  api:\n    image: fixture:latest\n    privileged: true\n",
			})
		).json();
		const rejectCheck = (requestId: string, options: Record<string, unknown>) =>
			post("/api/environments/drafts/preflight", {
				requestId,
				id: created.id,
				revision: rejected.revision,
				digest: rejected.digest,
				...options,
			});
		const refused = await (
			await rejectCheck("refused-source", {
				app: "api",
				target: "stack",
				useStagedSource: true,
			})
		).json();
		expect(refused).toMatchObject({
			kind: "staged-compose-source",
			accepted: false,
		});
		const refusedCandidate = await (
			await rejectCheck("refused-candidate", {
				validateStagedCandidate: true,
			})
		).json();
		expect(
			refusedCandidate.entries.find(
				(entry: { app: string; target: string }) =>
					entry.app === "api" && entry.target === "stack",
			),
		).toMatchObject({ status: "refused" });
		expect(
			(
				await (
					await rejectCheck("refused-tree", { materializeStagedTree: true })
				).json()
			).accepted,
		).toBe(false);
		const staged = await (
			await post("/api/environments/drafts/source", {
				requestId: "stage",
				id: created.id,
				revision: rejected.revision,
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
