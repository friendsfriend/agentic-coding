// AI and session routes (`port-git-providers-and-ai-to-bun`,
// tasks 4.2-4.5). The Pi runtime is replaced by a script on PATH, so the
// stream lifecycle, the callback scoping and the checkout cleanup are exercised
// end to end without an agent or a live provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	crReviewSessions,
	handleAiRoute,
} from "../src/server/integrations/ai-routes.ts";
import { reviewEventStream } from "../src/server/integrations/cr-review.ts";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
} from "../src/server/integrations/routes.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

const ORIGINAL_PATH = process.env.PATH;
let binDir = "";
let repoDir = "";

function writeFakePi(script: string): void {
	const target = path.join(binDir, "pi");
	fs.writeFileSync(target, script, { mode: 0o755 });
}

/** A fake `pi` that streams two deltas and posts both callback comment kinds. */
const RPC_SCRIPT = `#!/bin/sh
if [ "$1" = "--print" ]; then
  printf '%s' "analysis output"
  exit 0
fi
IFS= read -r prompt
url=$(printf '%s' "$prompt" | sed -n 's/.*\\(http:\\/\\/127\\.0\\.0\\.1:[0-9]*\\/api\\/ai\\/cr-comment-callback\\/[a-f0-9]*\\).*/\\1/p' | head -1)
printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"reviewing"}}'
printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":" hmm"}}'
printf '%s\\n' '{"type":"tool_execution_start","toolName":"bash","args":{"command":"git diff"}}'
if [ -n "$url" ]; then
  curl -s -X POST "$url" -H 'Content-Type: application/json' -d '{"file":"src/login.ts","line":12,"comment":"Null check missing"}' > /dev/null
  curl -s -X POST "$url" -H 'Content-Type: application/json' -d '{"comment":"Overall fine"}' > /dev/null
fi
printf '%s\\n' '{"type":"agent_end"}'
`;

const SILENT_SCRIPT = `#!/bin/sh
if [ "$1" = "--print" ]; then
  exit 0
fi
IFS= read -r prompt
exit 0
`;

// Closes stdout before sleeping: a real Pi session does not hold its output
// pipe open while it is idle, and an inherited pipe would keep the reader
// blocked past the review bound.
const SLEEPING_SCRIPT = `#!/bin/sh
if [ "$1" = "--print" ]; then
  sleep 30
  exit 0
fi
IFS= read -r prompt
exec 1>&-
sleep 30
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
	repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-repo-")));
	runGit(["init", "-q", "-b", "main"], repoDir);
	fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
	runGit(["add", "README.md"], repoDir);
	runGit(["commit", "-q", "-m", "init"], repoDir);
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
			services(gitlabFetch([])),
			jsonRequest("/api/ai/analyze-logs", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs"),
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ summary: "analysis output" });
	});

	test("a missing logs field is rejected", async () => {
		const response = await handleAiRoute(
			services(gitlabFetch([])),
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
			services(gitlabFetch([])),
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
			services(gitlabFetch([])),
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
			services(gitlabFetch([])),
			jsonRequest("/api/ai/analyze-logs-stream", { logs: "boom" }),
			new URL("http://127.0.0.1/api/ai/analyze-logs-stream"),
		);
		// An exit-0 run with no output is an empty analysis, exactly as the Go
		// handler treated it.
		expect(sseEvents((await response?.text()) ?? "")).toEqual([{ done: true }]);
	});
});

describe("change-request review stream", () => {
	test("streams mapped events, posts scoped comments and removes its checkout", async () => {
		writeFakePi(RPC_SCRIPT);
		const recorded: Recorded[] = [];
		const testServices = services(gitlabFetch(recorded));
		const checkoutsBefore = new Set(fs.readdirSync(os.tmpdir()));
		// A real listener, because the review agent reaches the callback over
		// HTTP the way a Pi session does.
		const server = await startWorkflowServer({ integrations: testServices });
		let body: string;
		try {
			const response = await fetch(`${server.url}/api/ai/cr-review-stream`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${server.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					appIdent: "demo",
					crIID: 9,
					sourceBranch: "fix-login",
					prompt: "Review this change request",
				}),
			});
			expect(response.status).toBe(200);
			body = await response.text();
		} finally {
			await server.stop();
		}
		const events = sseEvents(body);
		expect(events).toEqual([
			{ delta: "reviewing" },
			{ delta: " hmm" },
			{ delta: "\n> `git diff`\n" },
			{ done: true },
		]);

		// The comments went to the session's own change request, with the AI
		// attribution, and the inline one carried a position built from the
		// version SHAs.
		const posts = recorded.filter((entry) => entry.method === "POST");
		expect(posts.length).toBe(2);
		expect(posts[0].url).toContain("/merge_requests/9/discussions");
		expect(posts[0].body).toContain("AI Review");
		expect(posts[0].body).toContain("Null check missing");
		expect(posts[0].body).toContain("abc1234567890abcdef7890abcdef7890abcdef");
		expect(posts[1].body).not.toContain("position");

		// The token is revoked and the owned checkout is gone.
		expect(crReviewSessions.size).toBe(0);
		expect(
			fs
				.readdirSync(os.tmpdir())
				.filter(
					(name) => name.startsWith("cr-review-") && !checkoutsBefore.has(name),
				),
		).toEqual([]);
	});

	test("a pre-existing worktree is preserved", async () => {
		writeFakePi(RPC_SCRIPT);
		const existing = path.join(
			path.dirname(repoDir),
			`${path.basename(repoDir)}.existing`,
		);
		runGit(["worktree", "add", existing, "fix-login"], repoDir);
		try {
			const response = await handleAiRoute(
				services(gitlabFetch([])),
				jsonRequest("/api/ai/cr-review-stream", {
					appIdent: "demo",
					crIID: 9,
					sourceBranch: "fix-login",
					prompt: "Review",
				}),
				new URL("http://127.0.0.1/api/ai/cr-review-stream"),
			);
			await response?.text();
			expect(fs.existsSync(existing)).toBe(true);
			// Only the review's own checkout is registered and removed.
			const list = Bun.spawnSync(
				["git", "-C", repoDir, "worktree", "list", "--porcelain"],
				{ stdout: "pipe", stderr: "pipe" },
			).stdout.toString();
			expect(list).toContain(existing);
			expect(list).not.toContain("cr-review-");
		} finally {
			runGit(["worktree", "remove", "--force", existing], repoDir);
		}
	});

	test("an unknown branch reports the checkout failure as an error event", async () => {
		writeFakePi(RPC_SCRIPT);
		const response = await handleAiRoute(
			services(gitlabFetch([])),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				crIID: 9,
				sourceBranch: "no-such-branch",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		const events = sseEvents((await response?.text()) ?? "");
		expect(events[0]?.error).toContain(
			'Could not check out branch "no-such-branch"',
		);
		// Nothing was registered for a review that never started.
		expect(crReviewSessions.size).toBe(0);
	});

	test("a review without a change request posts no comments and registers no token", async () => {
		writeFakePi(RPC_SCRIPT);
		const recorded: Recorded[] = [];
		const response = await handleAiRoute(
			services(gitlabFetch(recorded)),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				crIID: 0,
				sourceBranch: "fix-login",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		await response?.text();
		expect(recorded.length).toBe(0);
		expect(crReviewSessions.size).toBe(0);
	});

	test("a missing app or checkout is rejected before the stream starts", async () => {
		const missingApp = await handleAiRoute(
			services(gitlabFetch([])),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "nope",
				sourceBranch: "fix-login",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		expect(missingApp?.status).toBe(404);
		const noCheckout = await handleAiRoute(
			services(gitlabFetch([]), { app: { localDirectoryPath: "" } }),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				sourceBranch: "fix-login",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		expect(noCheckout?.status).toBe(422);
		const noPrompt = await handleAiRoute(
			services(gitlabFetch([])),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				sourceBranch: "fix-login",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		expect(noPrompt?.status).toBe(400);
	});

	test("a silent pi reports that it produced no output", async () => {
		writeFakePi(SILENT_SCRIPT);
		const response = await handleAiRoute(
			services(gitlabFetch([])),
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				crIID: 9,
				sourceBranch: "fix-login",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		const events = sseEvents((await response?.text()) ?? "");
		expect(events[0]?.error).toBe("pi error: pi produced no output");
		expect(crReviewSessions.size).toBe(0);
	});

	test("a review that exceeds its bound is cancelled and cleaned up", async () => {
		writeFakePi(SLEEPING_SCRIPT);
		const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "review-bound-"));
		const response = reviewEventStream(
			{
				appIdent: "demo",
				crIid: 9,
				sourceBranch: "fix-login",
				prompt: "Review",
				repoDir: checkout,
				callbackUrl: "http://127.0.0.1/api/ai/cr-comment-callback/deadbeef",
			},
			{ timeoutMs: 150 },
		);
		const events = sseEvents(await response.text());
		expect(events[0]?.error).toBe("review timed out after 5 minutes");
		expect(fs.existsSync(path.join(checkout, "REVIEW_PROMPT.md"))).toBe(false);
		fs.rmSync(checkout, { recursive: true, force: true });
	});
});

describe("review comment callback authorization", () => {
	test("an unknown or expired token is rejected without posting", async () => {
		const recorded: Recorded[] = [];
		const response = await handleAiRoute(
			services(gitlabFetch(recorded)),
			jsonRequest("/api/ai/cr-comment-callback/deadbeef", { comment: "hi" }),
			new URL("http://127.0.0.1/api/ai/cr-comment-callback/deadbeef"),
		);
		expect(response?.status).toBe(401);
		expect(await response?.json()).toMatchObject({
			message: "unknown or expired review session token",
		});
		expect(recorded.length).toBe(0);
	});

	test("the path capability exempts only the callback route", async () => {
		const testServices = services(gitlabFetch([]));
		const server = await startWorkflowServer({ integrations: testServices });
		try {
			// The callback is reachable without the instance token (the agent has
			// none); an unknown token still fails.
			const callback = await fetch(
				`${server.url}/api/ai/cr-comment-callback/deadbeef`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ comment: "hi" }),
				},
			);
			expect(callback.status).toBe(401);
			expect(await callback.json()).toMatchObject({
				message: "unknown or expired review session token",
			});
			// Every other route still requires the instance capability.
			const other = await fetch(`${server.url}/api/pi-sessions`);
			expect(other.status).toBe(401);
			const otherAi = await fetch(`${server.url}/api/ai/analyze-logs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ logs: "x" }),
			});
			expect(otherAi.status).toBe(401);
		} finally {
			await server.stop();
		}
	});

	test("the token is unusable after its stream ends", async () => {
		writeFakePi(RPC_SCRIPT);
		const recorded: Recorded[] = [];
		const testServices = services(gitlabFetch(recorded));
		// Capture the token the stream handed to the agent.
		const token = "";
		const response = await handleAiRoute(
			testServices,
			jsonRequest("/api/ai/cr-review-stream", {
				appIdent: "demo",
				crIID: 9,
				sourceBranch: "fix-login",
				prompt: "Review",
			}),
			new URL("http://127.0.0.1/api/ai/cr-review-stream"),
		);
		await response?.text();
		// The token was only ever inside the prompt, which is gone with the
		// checkout; nothing durable holds it.
		expect(token).toBe("");
		expect(crReviewSessions.size).toBe(0);
		const after = await handleAiRoute(
			testServices,
			jsonRequest("/api/ai/cr-comment-callback/abcdef", { comment: "hi" }),
			new URL("http://127.0.0.1/api/ai/cr-comment-callback/abcdef"),
		);
		expect(after?.status).toBe(401);
	});

	test("a comment without text is rejected and a body is required", async () => {
		const registered = crReviewSessions;
		registered.register("token-1", "demo", 9);
		try {
			const noComment = await handleAiRoute(
				services(gitlabFetch([])),
				jsonRequest("/api/ai/cr-comment-callback/token-1", {}),
				new URL("http://127.0.0.1/api/ai/cr-comment-callback/token-1"),
			);
			expect(noComment?.status).toBe(400);
			expect(await noComment?.json()).toMatchObject({
				message: "comment field required",
			});
		} finally {
			registered.deregister("token-1");
		}
	});

	test("a comment failure is reported as an ok:false result, not an HTTP error", async () => {
		crReviewSessions.register("token-2", "demo", 9);
		try {
			const failingFetch = (async () =>
				new Response('{"message":"403 Forbidden"}', {
					status: 403,
				})) as unknown as typeof fetch;
			const response = await handleAiRoute(
				services(failingFetch),
				jsonRequest("/api/ai/cr-comment-callback/token-2", {
					comment: "hi",
				}),
				new URL("http://127.0.0.1/api/ai/cr-comment-callback/token-2"),
			);
			expect(response?.status).toBe(200);
			expect(await response?.json()).toMatchObject({ ok: false });
		} finally {
			crReviewSessions.deregister("token-2");
		}
	});

	test("a token whose app has no GitLab provider cannot post anywhere", async () => {
		crReviewSessions.register("token-3", "demo", 9);
		try {
			const response = await handleAiRoute(
				services(gitlabFetch([]), { app: { provider: "missing" } }),
				jsonRequest("/api/ai/cr-comment-callback/token-3", { comment: "hi" }),
				new URL("http://127.0.0.1/api/ai/cr-comment-callback/token-3"),
			);
			expect(response?.status).toBe(502);
			expect(await response?.json()).toMatchObject({
				message:
					'GitLab client error: no token configured for provider "missing"',
			});
		} finally {
			crReviewSessions.deregister("token-3");
		}
	});
});
