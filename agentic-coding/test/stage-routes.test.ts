// The stage read surfaces (`add-stage-testing-foundation`, task 2.3).
//
// Both routes are exercised through their real HTTP-shaped handlers against a
// throwaway configuration root: the dashboard/Settings read, the owner-capability
// read `stage_info` uses, the bounded version probe, and the credential write.
//
// The point of the whole file is the last paragraph: a `.env` value is seeded
// with a sentinel and *every* response is asserted not to contain it — a
// credential reaches Settings, `stage_info` and the logs or it does not reach
// anything.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_STAGES_PATH } from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import {
	handleStageCredentialRoute,
	handleStageRoute,
	type StageRouteDeps,
	StageRouteError,
	setStageCredential,
	stagesStatusValue,
} from "../src/server/stages/routes.ts";

const OWNER = "workflow:wf-stages";
/** Values that must never appear in a response. */
const PASSWORD_SENTINEL = "pw-sentinel-4b1e-do-not-leak";
const USERNAME_SENTINEL = "user-sentinel-77aa";

function configRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stage-routes-"));
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEnv(configDir: string, entries: Record<string, string>): void {
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(entries)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
}

function writeStage(
	configDir: string,
	ident: string,
	definition: unknown,
): void {
	writeJson(
		path.join(stagePaths(configDir).defsDir, `${ident}.json`),
		definition,
	);
}

/** One valid, allow-listed stage with a version probe and two roles. */
function stageFile(overrides: Record<string, unknown> = {}): unknown {
	return {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "read-only",
		data: { prefix: "stage-", notes: "throwaway rows only" },
		wiki: { processes: ["projects/grid/processes/integration"] },
		apps: {
			web: {
				label: "Grid web",
				url: "https://grid-int.example.test/",
				kind: "ui",
				version: { path: "/api/version", field: "version" },
				roles: {
					clerk: {
						login: "web-form",
						username: "${GRID_INT_CLERK_USERNAME}",
						password: "${GRID_INT_CLERK_PASSWORD}",
					},
				},
			},
		},
		logins: {
			"web-form": {
				kind: "form",
				steps: [
					{
						fields: [{ credential: "username", label: "User" }],
						submit: { role: "button", name: "Next" },
					},
					{ fields: [{ credential: "password", label: "Password" }] },
				],
			},
		},
		...overrides,
	};
}

/** Seed a root whose stage has one set credential, one missing one, and one
 * refused file. */
function seeded(): { configDir: string; deps: StageRouteDeps } {
	const configDir = configRoot();
	writeStage(configDir, "grid-int", stageFile());
	writeStage(
		configDir,
		"grid-broken",
		stageFile({ ident: "grid-broken", environment: "production" }),
	);
	writeEnv(configDir, {
		GRID_INT_CLERK_USERNAME: USERNAME_SENTINEL,
		GRID_INT_CLERK_PASSWORD: PASSWORD_SENTINEL,
	});
	return { configDir, deps: { configDir } };
}

async function get(
	deps: StageRouteDeps,
	routePath: string,
): Promise<{ status: number; text: string; value: Record<string, unknown> }> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleStageRoute(
		deps,
		new Request(url),
		new URL(url),
		OWNER,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return {
		status: response.status,
		text,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((parsed.error as Record<string, unknown>) ?? {}),
	};
}

describe("stage read routes", () => {
	test("the dashboard read lists the catalog and the refused files, without a probe", () => {
		const { configDir, deps } = seeded();
		const value = stagesStatusValue(deps);
		expect(value.configDir).toBe(configDir);
		expect(value.stages.map((stage) => stage.ident)).toEqual(["grid-int"]);
		const stage = value.stages[0];
		expect(stage?.displayName).toBe("Grid integration");
		expect(stage?.access).toBe("read-only");
		expect(stage?.origins).toEqual(["https://grid-int.example.test"]);
		expect(stage?.apps[0]?.roles[0]?.credentials).toEqual([
			{
				field: "username",
				variable: "GRID_INT_CLERK_USERNAME",
				status: "set",
			},
			{
				field: "password",
				variable: "GRID_INT_CLERK_PASSWORD",
				status: "set",
			},
		]);
		// The bounds a stage session is held to, its data conventions and its
		// knowledge hints are part of the read: a run cannot follow a `writable`
		// stage's cleanup or read its process pages without them.
		expect(Object.keys(stage?.limits ?? {}).sort()).toEqual([
			"maxActionsPerMinute",
			"maxLoginHandoffSeconds",
			"maxRecordingMinutes",
			"maxScreenshots",
			"maxSessions",
			"maxWaitSeconds",
		]);
		expect(stage?.data).toEqual({
			prefix: "stage-",
			notes: "throwaway rows only",
		});
		expect(stage?.wiki).toEqual({
			processes: ["projects/grid/processes/integration"],
		});
		// The dashboard read is a read: no probe runs, so no host is contacted.
		expect(stage?.apps[0]?.version).toBeUndefined();
		expect(value.excluded.map((entry) => entry.file)).toEqual([
			"grid-broken.json",
		]);
		expect(value.excluded[0]?.diagnostics[0]).toContain("production-like");
	});

	test("the agent read probes a version and answers `not discoverable` on a timeout", async () => {
		const { deps } = seeded();
		const ok = await get(
			{ ...deps, probe: async () => ({ version: "9.9.9" }) },
			AGENT_STAGES_PATH,
		);
		expect(ok.status).toBe(200);
		const stage = (ok.value.stages as Array<Record<string, unknown>>)[0];
		const app = ((stage?.apps ?? []) as Array<Record<string, unknown>>)[0];
		expect(app?.version).toEqual({
			path: "/api/version",
			field: "version",
			status: "ok",
			value: "9.9.9",
		});

		// A host that does not answer is `not discoverable`, not a failed read (and
		// not a hung one: the route bounds any probe).
		const timedOut = await get(
			{ ...deps, probe: () => new Promise(() => {}), probeTimeoutMs: 25 },
			AGENT_STAGES_PATH,
		);
		expect(timedOut.status).toBe(200);
		const timedOutApp = (
			((timedOut.value.stages as Array<Record<string, unknown>>)[0]?.apps ??
				[]) as Array<Record<string, unknown>>
		)[0];
		expect(timedOutApp?.version).toEqual({
			path: "/api/version",
			field: "version",
			status: "not discoverable",
		});
	});

	test("a version probe stays on the app's own origin", async () => {
		const configDir = configRoot();
		// An absolute `path` would move the probe to another host, which the catalog
		// never validated (the policy's deny list included).
		writeStage(
			configDir,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						version: { path: "https://elsewhere.example.test/api", field: "v" },
					},
				},
			}),
		);
		let probed = 0;
		const value = await get(
			{
				configDir,
				probe: async () => {
					probed += 1;
					return { v: "9.9.9" };
				},
			},
			AGENT_STAGES_PATH,
		);
		expect(value.status).toBe(200);
		const app = (
			((value.value.stages as Array<Record<string, unknown>>)[0]?.apps ??
				[]) as Array<Record<string, unknown>>
		)[0];
		expect(app?.version).toMatchObject({ status: "not discoverable" });
		// Not merely reported as not discoverable: never contacted.
		expect(probed).toBe(0);
	});

	test("one stage by ident, and a refusal that names why it is missing", async () => {
		const { deps } = seeded();
		const one = await get(deps, `${AGENT_STAGES_PATH}/grid-int`);
		expect(one.status).toBe(200);
		expect((one.value.stages as Array<Record<string, unknown>>).length).toBe(1);

		const refused = await get(deps, `${AGENT_STAGES_PATH}/grid-broken`);
		expect(refused.status).toBe(404);
		expect(String(refused.value.code)).toBe("stage-not-configured");
		expect(String(refused.value.message)).toContain("production-like");

		const unknown = await get(deps, `${AGENT_STAGES_PATH}/grid-nope`);
		expect(unknown.status).toBe(404);
		expect(String(unknown.value.code)).toBe("stage-not-configured");
		expect(String(unknown.value.message)).toContain("no stage");

		const malformed = await get(deps, `${AGENT_STAGES_PATH}/Grid_INT`);
		expect(malformed.status).toBe(400);
		expect(String(malformed.value.message)).toContain("stage ident");
	});

	test("no response carries a `.env` value", async () => {
		const { deps } = seeded();
		const responses = [
			JSON.stringify(stagesStatusValue(deps)),
			JSON.stringify(
				await get(
					{ ...deps, probe: async () => ({ version: "1" }) },
					AGENT_STAGES_PATH,
				),
			),
			JSON.stringify(await get(deps, `${AGENT_STAGES_PATH}/grid-int`)),
			// The credential write's answer is a status, never the value it stored.
			JSON.stringify(
				await setStageCredential(deps, {
					variable: "GRID_INT_CLERK_PASSWORD",
					value: "a-new-secret-sentinel",
				}),
			),
			JSON.stringify(
				(stagesStatusValue(deps).stages[0]?.apps[0]?.roles ?? []).map(
					(role) => role.credentials,
				),
			),
		];
		for (const text of responses) {
			expect(text).not.toContain(PASSWORD_SENTINEL);
			expect(text).not.toContain(USERNAME_SENTINEL);
			expect(text).not.toContain("a-new-secret-sentinel");
		}
	});
});

describe("stage credential flow", () => {
	test("only a referenced variable may be written, and only its own key changes", async () => {
		const { configDir, deps } = seeded();
		const before = fs.readFileSync(path.join(configDir, ".env"), "utf8");
		const value = await setStageCredential(deps, {
			variable: "GRID_INT_CLERK_PASSWORD",
			value: "rotated-secret",
		});
		expect(value).toEqual({
			variable: "GRID_INT_CLERK_PASSWORD",
			status: "set",
		});
		const after = fs.readFileSync(path.join(configDir, ".env"), "utf8");
		expect(after).toContain("GRID_INT_CLERK_PASSWORD=rotated-secret");
		// The variable that was already set is untouched, and nothing else was
		// added: this is not a general `.env` writer.
		expect(after).toContain(`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}`);
		expect(after.split("\n").filter((line) => line.trim() !== "")).toHaveLength(
			before.split("\n").filter((line) => line.trim() !== "").length,
		);
	});

	test("an unreferenced variable is refused with a code and no value", async () => {
		const { configDir, deps } = seeded();
		let refused: unknown;
		try {
			await setStageCredential(deps, {
				variable: "UNRELATED_SECRET",
				value: "never-stored",
			});
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(StageRouteError);
		expect((refused as StageRouteError).code).toBe("credential-unknown");
		expect((refused as StageRouteError).status).toBe(404);
		expect(String(refused)).not.toContain("never-stored");
		expect(fs.readFileSync(path.join(configDir, ".env"), "utf8")).not.toContain(
			"UNRELATED_SECRET",
		);
	});

	test("the route answers its own status codes and never echoes a value", async () => {
		const { deps } = seeded();
		const url = "http://127.0.0.1:4050/api/v1/stages/credential";
		const post = (body: unknown): Promise<Response> =>
			handleStageCredentialRoute(
				deps,
				new Request(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);

		const unknown = await post({ variable: "NOT_REFERENCED", value: "x" });
		expect(unknown.status).toBe(404);
		expect(await unknown.text()).toContain("credential-unknown");

		const malformed = await post({ variable: "not a variable", value: "x" });
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).toContain("bad-request");

		const written = await post({
			variable: "GRID_INT_CLERK_PASSWORD",
			value: "route-secret",
		});
		expect(written.status).toBe(200);
		const text = await written.text();
		expect(text).toContain('"status":"set"');
		expect(text).not.toContain("route-secret");
	});
});
