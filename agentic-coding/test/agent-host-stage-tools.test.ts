// The `agentic.stages` tool every durable run is offered
// (`add-stage-testing-foundation`, task 2.2).
//
// The tool is a read of the server's owner-scoped `/api/v1/agent-env/stages`
// surface. This file drives it against the *real* route handler over a
// throwaway configuration root, so what an agent sees is what the catalog, the
// route and the tool agree on — and the promise in its description is asserted:
// a credential reaches it as the *name* of the `.env` variable, never as a
// value.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { ENVIRONMENT_OWNER_HEADER } from "../src/agent-host/environment-capability.ts";
import {
	createStageExtension,
	STAGE_EXTENSION,
} from "../src/agent-host/stage-tools.ts";
import type { RunContextLookup } from "../src/agent-host/tools.ts";
import { AGENT_STAGES_PATH } from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import {
	handleStageRoute,
	type StageRouteDeps,
} from "../src/server/stages/routes.ts";

const PASSWORD_SENTINEL = "pw-sentinel-agent-host-do-not-leak";
const USERNAME_SENTINEL = "user-sentinel-agent-host";

const RUN_ENV = {
	HERDR_WORKFLOW_ID: "wf-alpha",
	HERDR_RUN_ID: "run-1",
	AGENTIC_ENV_URL: "http://127.0.0.1:4050",
	AGENTIC_ENV_TOKEN: "capability-for-wf-alpha",
};

interface Call {
	readonly url: string;
	readonly method: string;
	readonly owner: string | null;
	readonly authorization: string | null;
}

/** The real stage route, behind a recorded transport. */
function routeFetch(
	deps: StageRouteDeps,
	owner: string,
	calls: Call[],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			owner: headers.get(ENVIRONMENT_OWNER_HEADER),
			authorization: headers.get("authorization"),
		});
		const response = await handleStageRoute(
			deps,
			new Request(url, init),
			url,
			owner,
		);
		if (!response) throw new Error(`no route for ${url.pathname}`);
		return response;
	}) as unknown as typeof fetch;
}

/** One allowed stage (one credential set, one missing) and one refused file. */
function seeded(): { configDir: string; deps: StageRouteDeps } {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-tool-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	const definition = {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "read-only",
		apps: {
			web: {
				label: "Grid web",
				url: "https://grid-int.example.test/",
				kind: "ui",
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
				steps: [{ fields: [{ credential: "password", label: "Password" }] }],
			},
		},
		allowedOrigins: ["https://login.example.test"],
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(defsDir, "grid-prod.json"),
		`${JSON.stringify(
			{
				...definition,
				ident: "grid-prod",
				displayName: "Grid production",
				environment: "production",
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}\n`,
	);
	return { configDir, deps: { configDir } };
}

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface Executable {
	readonly name: string;
	readonly description?: string;
	execute(
		args: unknown,
		api: unknown,
		context: unknown,
	): Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

function toolOf(extension: Extension): Executable {
	const tool = (extension.tools ?? [])[0];
	if (!tool) throw new Error("the extension offers no tool");
	return tool as unknown as Executable;
}

const textOf = (blocks: readonly ContentBlock[]): string =>
	blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");

function lookup(env: Record<string, string>): RunContextLookup {
	return () => ({ runId: "run-1", cwd: "/tmp", env });
}

describe("stage_info", () => {
	test("one tool every durable run may be offered, described as value-free", () => {
		const extension = createStageExtension(lookup(RUN_ENV));
		expect(extension.name).toBe(STAGE_EXTENSION);
		expect((extension.tools ?? []).map((tool) => tool.name)).toEqual([
			"stage_info",
		]);
		const description = toolOf(extension).description ?? "";
		// The promise the tool is built on, in the text a model reads.
		expect(description).toContain("never returns a secret");
		expect(description).toContain("never as a value");
		// And how to use what it returns.
		expect(description).toContain("browser_open({ stage, stageApp })");
		expect(description).toContain("stage_login({ app, role })");
	});

	test("it reads the owner capability and answers the catalog without a value", async () => {
		const { deps } = seeded();
		const calls: Call[] = [];
		const server = routeFetch(deps, "workflow:wf-alpha", calls);
		const result = await toolOf(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
		).execute({}, { conversationId: 1 }, {});
		expect(result.isError).toBeUndefined();
		const text = textOf(result.content);

		// The read presented the run's own capability, on the agent surface.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`http://127.0.0.1:4050${AGENT_STAGES_PATH}`);
		expect(calls[0]?.authorization).toBe("Bearer capability-for-wf-alpha");
		expect(calls[0]?.owner).toBe("workflow:wf-alpha");

		// The structure an agent needs to decide what to drive.
		expect(text).toContain("grid-int");
		expect(text).toContain("Grid integration");
		expect(text).toContain("read-only");
		expect(text).toContain("https://grid-int.example.test");
		expect(text).toContain("clerk");
		expect(text).toContain("web-form");
		expect(text).toContain("https://login.example.test");

		// Credential *presence*: the name to set, and the fact that the other one
		// is there.
		expect(text).toContain("missing GRID_INT_CLERK_PASSWORD");
		expect(text).toContain("set");

		// A refused file is named with its diagnostics, so "my stage is not here"
		// has an answer.
		expect(text).toContain("grid-prod.json");
		expect(text).toContain("production-like");

		// And no value of any kind: not the one the `.env` holds, and the variable
		// it belongs to is named rather than quoted.
		expect(text).not.toContain(PASSWORD_SENTINEL);
		expect(text).not.toContain(USERNAME_SENTINEL);
	});

	test("one stage by ident, and an unknown stage answers the route's own code", async () => {
		const { deps } = seeded();
		const calls: Call[] = [];
		const entity = createStageExtension(lookup(RUN_ENV), {
			fetch: routeFetch(deps, "workflow:wf-alpha", calls),
		});
		const one = await toolOf(entity).execute(
			{ stage: "grid-int" },
			{ conversationId: 1 },
			{},
		);
		expect(one.isError).toBeUndefined();
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:4050${AGENT_STAGES_PATH}/grid-int`,
		);
		const listed = JSON.parse(textOf(one.content)) as {
			stages: Array<{ ident: string }>;
		};
		expect(listed.stages.map((stage) => stage.ident)).toEqual(["grid-int"]);

		const missing = await toolOf(entity).execute(
			{ stage: "grid-nope" },
			{ conversationId: 1 },
			{},
		);
		expect(missing.isError).toBe(true);
		// The failure carries the route's machine-readable code, so a run can tell
		// a typo from a refused file.
		expect(textOf(missing.content)).toContain("[stage-not-configured]");
	});

	test("a run without an environment capability is told the tool is unavailable", async () => {
		const { env } = { env: { ...RUN_ENV } };
		delete (env as Record<string, string>).AGENTIC_ENV_TOKEN;
		const result = await toolOf(
			createStageExtension(lookup(env as Record<string, string>)),
		).execute({}, { conversationId: 1 }, {});
		expect(result.isError).toBe(true);
		expect(textOf(result.content)).toContain("no agent environment capability");
	});
});
