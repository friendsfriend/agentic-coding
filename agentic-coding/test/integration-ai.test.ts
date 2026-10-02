// AI and session routes (`port-git-providers-and-ai-to-bun`, tasks 4.2-4.3).
// The Pi runtime is replaced by a script on PATH, so the analysis stream is
// exercised end to end without an agent or a live provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAiRoute } from "../src/server/integrations/ai-routes.ts";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
} from "../src/server/integrations/routes.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const ORIGINAL_PATH = process.env.PATH;
let binDir = "";
let repoDir = "";

function writeFakePi(script: string): void {
	const target = path.join(binDir, "pi");
	fs.writeFileSync(target, script, { mode: 0o755 });
}

/** A fake `pi` whose `--print` mode answers with a fixed analysis summary. */
const RPC_SCRIPT = `#!/bin/sh
if [ "$1" = "--print" ]; then
  printf '%s' "analysis output"
  exit 0
fi
IFS= read -r prompt
exit 0
`;

const SILENT_SCRIPT = `#!/bin/sh
if [ "$1" = "--print" ]; then
  exit 0
fi
IFS= read -r prompt
exit 0
`;

function runGit(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function providerStore(): ProviderStore {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-routes-"));
	const providersDir = path.join(configDir, "providers");
	fs.mkdirSync(providersDir, { recursive: true });
	fs.writeFileSync(
		path.join(providersDir, "gl.json"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
		JSON.stringify({ name: "gl", type: "gitlab", token: "${GL}" }),
	);
	fs.writeFileSync(path.join(configDir, ".env"), "GL=token\n");
	const store = new ProviderStore(providersDir, path.join(configDir, ".env"));
	store.load();
	return store;
}

interface Recorded {
	method: string;
	url: string;
	body: string;
}

/** Services with one GitLab app whose checkout is the temp repository. */
function services(
	fetchFn: typeof fetch,
	overrides: { app?: Record<string, unknown> } = {},
): IntegrationServices & { recorded: Recorded[] } {
	const app = {
		ident: "demo",
		repositoryPath: "https://gitlab.example.com/acme/devenv.git",
		localDirectoryPath: repoDir,
		branch: "main",
		mainWorktreeBranch: "main",
		provider: "gl",
		...overrides.app,
	};
	return {
		providers: providerStore(),
		git: new GitRepository(),
		apps: {
			getAppByIdent: (ident) => (ident === app.ident ? app : undefined),
			getApps: () => [app],
			updateAppActiveWorktree: () => {},
			loadConfig: () => {},
		},
		fetch: fetchFn,
		recorded: [],
	} as IntegrationServices & { recorded: Recorded[] };
}

/** A GitLab fetch that answers the review flow and records the writes. */
function gitlabFetch(recorded: Recorded[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		recorded.push({ method, url, body });
		if (url.includes("/versions"))
			return new Response(
				JSON.stringify([
					{
						base_commit_sha: "def4567890abcdef7890abcdef7890abcdef7890",
						head_commit_sha: "abc1234567890abcdef7890abcdef7890abcdef",
						start_commit_sha: "def4567890abcdef7890abcdef7890abcdef7890",
					},
				]),
				{ status: 200 },
			);
		if (url.includes("/discussions"))
			return new Response('{"id":"abc"}', { status: 201 });
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
}

function jsonRequest(route: string, body: unknown): Request {
	return new Request(`http://127.0.0.1${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function sseEvents(
	body: string,
): { delta?: string; error?: string; done?: boolean }[] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)));
}

beforeEach(() => {
	binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
	process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
	repoDir = createRepoFixture(
		fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-repo-"))),
		{ files: { "README.md": "hello\n" } },
	);
	runGit(["branch", "fix-login"], repoDir);
});

afterEach(() => {
	process.env.PATH = ORIGINAL_PATH;
	fs.rmSync(binDir, { recursive: true, force: true });
	fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("pi session route", () => {
	test("answers with the agents envelope", async () => {
		// An empty agent directory, so the assertion does not depend on the
		// developer's own sessions.
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const url = new URL("http://127.0.0.1/api/pi-sessions");
			const response = await handleLegacyRoute(
				services(gitlabFetch([])),
				new Request(url),
				url,
			);
			expect(response?.status).toBe(200);
			expect(await response?.json()).toEqual({ agents: [] });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("log analysis routes", () => {
	test("a non-stream analysis returns the pi summary", async () => {
		writeFakePi(RPC_SCRIPT);
		const response = await handleAiRoute(
			jsonRequest("/api/ai/analyze-logs", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs"),
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ summary: "analysis output" });
	});

	test("a missing logs field is rejected", async () => {
		const response = await handleAiRoute(
			jsonRequest("/api/ai/analyze-logs", { logs: "" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs"),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "logs field required",
		});
	});

	test("a missing pi answers 503", async () => {
		// Only the empty fake-bin directory is on PATH, so no real Pi is found.
		process.env.PATH = binDir;
		const response = await handleAiRoute(
			jsonRequest("/api/ai/analyze-logs", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs"),
		);
		expect(response?.status).toBe(503);
		expect(await response?.json()).toMatchObject({
			message: "pi not found in PATH",
		});
	});

	test("the stream route emits the buffered output as one delta", async () => {
		writeFakePi(RPC_SCRIPT);
		const response = await handleAiRoute(
			jsonRequest("/api/ai/analyze-logs-stream", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs-stream"),
		);
		expect(response?.status).toBe(200);
		expect(sseEvents((await response?.text()) ?? "")).toEqual([
			{ delta: "analysis output" },
			{ done: true },
		]);
	});

	test("the stream route reports a silent pi as an empty analysis", async () => {
		writeFakePi(SILENT_SCRIPT);
		const response = await handleAiRoute(
			jsonRequest("/api/ai/analyze-logs-stream", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs-stream"),
		);
		// An exit-0 run with no output is an empty analysis, exactly as the Go
		// handler treated it.
		expect(sseEvents((await response?.text()) ?? "")).toEqual([{ done: true }]);
	});
});
