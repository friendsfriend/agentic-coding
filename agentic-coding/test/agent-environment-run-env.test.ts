// The run environment's agent environment capability
// (`add-agent-environment-tools`, task 1.2): every durable run is handed the
// server's URL and the capability `environmentTokenFor` derives for
// `workflow:<id>`, and that capability authorizes exactly that owner.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	clearEnvironmentServer,
	environmentOwnerFor,
	environmentRunEnv,
	environmentServer,
	publishEnvironmentServer,
} from "../src/agent-host/environment-capability.ts";
import {
	authorizeEnvironmentRequest,
	createInstanceAuthority,
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
} from "../src/server/auth.ts";
import { writeAgentRunEnv } from "../src/workflow/run-env.ts";

const authority = createInstanceAuthority("inst-1", "instance-token-value");

function withServer<T>(run: () => T): T {
	try {
		publishEnvironmentServer({
			url: "http://127.0.0.1:4050",
			token: authority.token,
		});
		return run();
	} finally {
		clearEnvironmentServer(authority.token);
	}
}

describe("agent environment run environment", () => {
	test("every workflow run receives the URL and its own owner capability", () => {
		withServer(() => {
			const env = environmentRunEnv("wf-alpha");
			expect(env.AGENTIC_ENV_URL).toBe("http://127.0.0.1:4050");
			expect(env.AGENTIC_ENV_TOKEN).toBe(
				environmentTokenFor(authority.token, environmentOwnerFor("wf-alpha")),
			);
			// The instance token itself never reaches a run.
			expect(env.AGENTIC_ENV_TOKEN).not.toBe(authority.token);
			// Another workflow's run gets a capability that cannot act for this one.
			expect(environmentRunEnv("wf-beta").AGENTIC_ENV_TOKEN).not.toBe(
				env.AGENTIC_ENV_TOKEN,
			);
		});
	});

	test("the minted capability authorizes its own owner and no other", () => {
		withServer(() => {
			const env = environmentRunEnv("wf-alpha");
			const request = new Request(
				"http://127.0.0.1:4050/api/v1/agent-env/list",
				{
					headers: {
						authorization: `Bearer ${env.AGENTIC_ENV_TOKEN}`,
						[ENVIRONMENT_OWNER_HEADER]: "workflow:wf-alpha",
					},
				},
			);
			expect(authorizeEnvironmentRequest(request, authority)).toBe(
				"workflow:wf-alpha",
			);
			const impostor = new Request(
				"http://127.0.0.1:4050/api/v1/agent-env/list",
				{
					headers: {
						authorization: `Bearer ${env.AGENTIC_ENV_TOKEN}`,
						[ENVIRONMENT_OWNER_HEADER]: "workflow:wf-beta",
					},
				},
			);
			expect(() => authorizeEnvironmentRequest(impostor, authority)).toThrow(
				"invalid agent environment capability",
			);
		});
	});

	test("the capability is written into the run environment file", () => {
		withServer(() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-run-env-"));
			try {
				const runEnvPath = writeAgentRunEnv({
					cwd: dir,
					runId: "run-1",
					environment: {
						HERDR_WORKFLOW_ID: "wf-alpha",
						HERDR_RUN_ID: "run-1",
						...environmentRunEnv("wf-alpha"),
					},
				});
				const contents = fs.readFileSync(runEnvPath, "utf8");
				expect(contents).toContain("AGENTIC_ENV_URL='http://127.0.0.1:4050'");
				expect(contents).toContain(
					`AGENTIC_ENV_TOKEN='${environmentTokenFor(authority.token, "workflow:wf-alpha")}'`,
				);
				expect(contents).not.toContain("instance-token-value");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test("a run outside the server process gets no capability at all", () => {
		expect(environmentServer()).toBeUndefined();
		expect(environmentRunEnv("wf-alpha")).toEqual({});
		// A run with no workflow id would otherwise claim a `workflow:` owner.
		withServer(() => {
			expect(environmentRunEnv("")).toEqual({});
			expect(environmentRunEnv("   ")).toEqual({});
		});
	});
});
