import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderApi } from "../src/adapters/http/provider-api.ts";
import type {
	ProviderConfig,
	ProviderWriteIntent,
} from "../src/domain/provider.ts";
import { openProviderWriteJournal } from "../src/persistence/provider-write-journal.ts";

const github: ProviderConfig = {
	name: "github-fixture",
	type: "github",
	baseUrl: "https://api.github.example",
	username: "fixture",
	tokenRef: "GH_TOKEN",
};
const gitlab: ProviderConfig = {
	name: "gitlab-fixture",
	type: "gitlab",
	baseUrl: "https://gitlab.example",
	username: "fixture",
	tokenRef: "GL_TOKEN",
};
const tokens = {
	get: (reference: string) =>
		reference === "GH_TOKEN"
			? "gh-secret-value"
			: reference === "GL_TOKEN"
				? "gl-secret-value"
				: undefined,
};
const sha = "a".repeat(40);

function response(value: unknown, status = 200) {
	return new Response(value === null ? null : JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function confirmed(
	api: ReturnType<typeof createProviderApi>,
	intent: ProviderWriteIntent,
	signal: AbortSignal,
) {
	const preview = await api.write(intent, signal);
	if (preview.status !== "confirmation-required")
		throw new Error("no confirmation digest");
	return await api.write(
		{ ...intent, confirm: preview.digest } as ProviderWriteIntent,
		signal,
	);
}

function stateDirectory() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-writes-")),
	);
	fs.chmodSync(root, 0o700);
	return root;
}

test("GitHub writes preview, confirm, replay and refuse changed intent", async () => {
	const stateDir = stateDirectory();
	const calls: string[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url.endsWith("/pulls/7") && method === "GET")
			return response({ head: { sha } });
		if (url.endsWith("/issues/7/comments"))
			return response({ id: 100, html_url: "https://example.invalid/100" });
		if (url.endsWith("/pulls/7/reviews"))
			return response({ id: 101, state: "APPROVED", commit_id: sha });
		if (url.endsWith("/actions/runs/9/rerun")) return response(null, 201);
		if (url.endsWith("/actions/runs/9/cancel")) return response(null, 201);
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([github], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		const preview = await api.write(
			{
				action: "comment-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				body: "hello",
				requestId: "comment-1",
			},
			signal,
		);
		expect(preview).toMatchObject({
			status: "confirmation-required",
			intent: {
				provider: "github-fixture",
				action: "comment-change",
				target: "org/repo:7",
			},
		});
		expect(calls).toEqual([]);
		if (preview.status !== "confirmation-required")
			throw new Error("no digest");
		const completed = await api.write(
			{
				action: "comment-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				body: "hello",
				requestId: "comment-1",
				confirm: preview.digest,
			},
			signal,
		);
		expect(completed).toMatchObject({
			status: "completed",
			receipt: {
				state: "completed",
				action: "comment-change",
				result: { id: 100 },
			},
		});
		expect(calls).toHaveLength(1);
		const replay = await api.write(
			{
				action: "comment-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				body: "hello",
				requestId: "comment-1",
				confirm: preview.digest,
			},
			signal,
		);
		expect(replay).toMatchObject({ status: "replayed" });
		expect(calls).toHaveLength(1);
		const changed = await api.write(
			{
				action: "comment-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				body: "different",
				requestId: "comment-1",
			},
			signal,
		);
		if (changed.status !== "confirmation-required")
			throw new Error("no digest");
		await expect(
			api.write(
				{
					action: "comment-change",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					body: "different",
					requestId: "comment-1",
					confirm: changed.digest,
				},
				signal,
			),
		).rejects.toMatchObject({ code: "request-conflict" });
		expect(JSON.stringify(api.writes())).not.toContain("gh-secret-value");

		const approve = await api.write(
			{
				action: "approve-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				sha,
				requestId: "approve-1",
			},
			signal,
		);
		if (approve.status !== "confirmation-required")
			throw new Error("no digest");
		const approved = await api.write(
			{
				action: "approve-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				sha,
				requestId: "approve-1",
				confirm: approve.digest,
			},
			signal,
		);
		expect(approved).toMatchObject({
			status: "completed",
			receipt: { result: { state: "APPROVED" } },
		});

		const retry = await api.write(
			{
				action: "retry-pipeline",
				provider: "github-fixture",
				repository: "org/repo",
				pipeline: 9,
				requestId: "retry-1",
			},
			signal,
		);
		if (retry.status !== "confirmation-required") throw new Error("no digest");
		expect(
			await api.write(
				{
					action: "retry-pipeline",
					provider: "github-fixture",
					repository: "org/repo",
					pipeline: 9,
					requestId: "retry-1",
					confirm: retry.digest,
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { status: "requested" } },
		});
		expect(
			await api.write(
				{
					action: "cancel-pipeline",
					provider: "github-fixture",
					repository: "org/repo",
					pipeline: 9,
					requestId: "cancel-1",
					confirm: (
						await api.write(
							{
								action: "cancel-pipeline",
								provider: "github-fixture",
								repository: "org/repo",
								pipeline: 9,
								requestId: "cancel-1",
							},
							signal,
						)
					).digest,
				},
				signal,
			),
		).toMatchObject({ status: "completed" });
		expect(api.writes("github-fixture")).toHaveLength(4);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("approval refuses a changed head and records the failed receipt", async () => {
	const stateDir = stateDirectory();
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		if (url.endsWith("/pulls/7") && (init?.method ?? "GET") === "GET")
			return response({ head: { sha: "b".repeat(40) } });
		return response({ message: "unexpected" }, 500);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([github], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		const preview = await api.write(
			{
				action: "approve-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				sha,
				requestId: "approve-stale",
			},
			signal,
		);
		if (preview.status !== "confirmation-required")
			throw new Error("no digest");
		await expect(
			api.write(
				{
					action: "approve-change",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					sha,
					requestId: "approve-stale",
					confirm: preview.digest,
				},
				signal,
			),
		).rejects.toMatchObject({ code: "provider-head-changed" });
		expect(api.writes()[0]).toMatchObject({
			state: "failed",
			error: "provider-head-changed",
		});
		const replay = await api.write(
			{
				action: "approve-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				sha,
				requestId: "approve-stale",
				confirm: preview.digest,
			},
			signal,
		);
		expect(replay).toMatchObject({ status: "replayed" });
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("GitLab writes use notes, exact approval and pipeline actions", async () => {
	const stateDir = stateDirectory();
	const calls: string[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url.endsWith("/merge_requests/4") && method === "GET")
			return response({ diff_refs: { head_sha: sha } });
		if (url.endsWith("/merge_requests/4/notes")) return response({ id: 200 });
		if (url.endsWith("/merge_requests/4/approve"))
			return response({ id: 201, state: "approved" });
		if (url.endsWith("/issues/5/notes")) return response({ id: 202 });
		if (url.endsWith("/pipelines/9/retry"))
			return response({ id: 9, status: "pending" });
		if (url.endsWith("/pipelines/9/cancel"))
			return response({ id: 9, status: "canceled" });
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([gitlab], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		const comment = await api.write(
			{
				action: "comment-change",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 4,
				body: "note",
				requestId: "comment-gl",
			},
			signal,
		);
		if (comment.status !== "confirmation-required")
			throw new Error("no digest");
		await api.write(
			{
				action: "comment-change",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 4,
				body: "note",
				requestId: "comment-gl",
				confirm: comment.digest,
			},
			signal,
		);
		const issue = await api.write(
			{
				action: "comment-issue",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 5,
				body: "note",
				requestId: "issue-gl",
			},
			signal,
		);
		if (issue.status !== "confirmation-required") throw new Error("no digest");
		await api.write(
			{
				action: "comment-issue",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 5,
				body: "note",
				requestId: "issue-gl",
				confirm: issue.digest,
			},
			signal,
		);
		const approve = await api.write(
			{
				action: "approve-change",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 4,
				sha,
				requestId: "approve-gl",
			},
			signal,
		);
		if (approve.status !== "confirmation-required")
			throw new Error("no digest");
		expect(
			await api.write(
				{
					action: "approve-change",
					provider: "gitlab-fixture",
					repository: "group/sub/repo",
					number: 4,
					sha,
					requestId: "approve-gl",
					confirm: approve.digest,
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { state: "approved" } },
		});
		const retry = await api.write(
			{
				action: "retry-pipeline",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				pipeline: 9,
				requestId: "retry-gl",
			},
			signal,
		);
		if (retry.status !== "confirmation-required") throw new Error("no digest");
		await api.write(
			{
				action: "retry-pipeline",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				pipeline: 9,
				requestId: "retry-gl",
				confirm: retry.digest,
			},
			signal,
		);
		const cancel = await api.write(
			{
				action: "cancel-pipeline",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				pipeline: 9,
				requestId: "cancel-gl",
			},
			signal,
		);
		if (cancel.status !== "confirmation-required") throw new Error("no digest");
		await api.write(
			{
				action: "cancel-pipeline",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				pipeline: 9,
				requestId: "cancel-gl",
				confirm: cancel.digest,
			},
			signal,
		);
		expect(calls.some((call) => call.includes("/api/v4/projects/"))).toBe(true);
		expect(JSON.stringify(api.writes())).not.toContain("gl-secret-value");
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("write journal marks interrupted attempts failed and refuses missing state", async () => {
	const stateDir = stateDirectory();
	try {
		const journal = openProviderWriteJournal(stateDir);
		journal.claim({
			requestId: "interrupted",
			provider: "github-fixture",
			action: "comment-change",
			target: "org/repo:1",
			digest: "a".repeat(64),
		});
		const reopened = openProviderWriteJournal(stateDir);
		expect(reopened.list()[0]).toMatchObject({
			state: "failed",
			error: "provider-write-interrupted",
		});
		const api = createProviderApi([github], tokens, (async () =>
			response({})) as unknown as typeof fetch);
		const signal = new AbortController().signal;
		const preview = await api.write(
			{
				action: "comment-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 1,
				body: "hello",
				requestId: "no-state",
			},
			signal,
		);
		if (preview.status !== "confirmation-required")
			throw new Error("no digest");
		await expect(
			api.write(
				{
					action: "comment-change",
					provider: "github-fixture",
					repository: "org/repo",
					number: 1,
					body: "hello",
					requestId: "no-state",
					confirm: preview.digest,
				},
				signal,
			),
		).rejects.toMatchObject({ code: "provider-write-unavailable" });
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("merge, issue-state and rebase writes use exact heads and replay", async () => {
	const stateDir = stateDirectory();
	const calls: string[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url.endsWith("/pulls/7") && method === "GET")
			return response({ head: { sha } });
		if (url.endsWith("/pulls/7/merge") && method === "PUT")
			return response({ sha, merged: true, message: "merged" });
		if (url.includes("/issues/8") && method === "PATCH")
			return response({ id: 8, state: "closed" });
		if (url.endsWith("/merge_requests/4") && method === "GET")
			return response({ diff_refs: { head_sha: sha } });
		if (url.endsWith("/merge_requests/4/merge") && method === "PUT")
			return response({ state: "merged" });
		if (url.endsWith("/merge_requests/4/rebase") && method === "POST")
			return response({ rebase_in_progress: true });
		if (url.endsWith("/issues/5") && method === "PUT")
			return response({ id: 5, state: "closed" });
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([github, gitlab], tokens, fetchImpl, {
			stateDir,
		});
		const signal = new AbortController().signal;
		const merge = await api.write(
			{
				action: "merge-change",
				provider: "github-fixture",
				repository: "org/repo",
				number: 7,
				sha,
				mergeMethod: "squash",
				requestId: "merge-1",
			},
			signal,
		);
		if (merge.status !== "confirmation-required") throw new Error("no digest");
		expect(
			await api.write(
				{
					action: "merge-change",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					sha,
					mergeMethod: "squash",
					requestId: "merge-1",
					confirm: merge.digest,
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { merged: true } },
		});

		const close = await api.write(
			{
				action: "set-issue-state",
				provider: "github-fixture",
				repository: "org/repo",
				number: 8,
				state: "closed",
				requestId: "issue-state-1",
			},
			signal,
		);
		if (close.status !== "confirmation-required") throw new Error("no digest");
		expect(
			await api.write(
				{
					action: "set-issue-state",
					provider: "github-fixture",
					repository: "org/repo",
					number: 8,
					state: "closed",
					requestId: "issue-state-1",
					confirm: close.digest,
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { state: "closed" } },
		});

		const rebase = await api.write(
			{
				action: "rebase-change",
				provider: "gitlab-fixture",
				repository: "group/sub/repo",
				number: 4,
				requestId: "rebase-1",
			},
			signal,
		);
		if (rebase.status !== "confirmation-required") throw new Error("no digest");
		expect(
			await api.write(
				{
					action: "rebase-change",
					provider: "gitlab-fixture",
					repository: "group/sub/repo",
					number: 4,
					requestId: "rebase-1",
					confirm: rebase.digest,
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { rebase_in_progress: true } },
		});
		expect(calls.some((call) => call.includes("/pulls/7/merge"))).toBe(true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("GitHub discussion, label, assignee and job writes", async () => {
	const stateDir = stateDirectory();
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/pulls/7") && method === "GET")
			return response({ head: { sha } });
		if (url.endsWith("/user")) return response({ login: "fixture" });
		if (url.includes("/pulls/7/reviews?per_page=100"))
			return response([
				{ id: 54, state: "COMMENTED", user: { login: "fixture" } },
				{ id: 55, state: "APPROVED", user: { login: "fixture" } },
			]);
		if (url.endsWith("/pulls/7/reviews/55/dismissals") && method === "PUT")
			return response({ id: 55, state: "DISMISSED" });
		if (url.endsWith("/pulls/7/comments/77/replies") && method === "POST")
			return response({ id: 78, html_url: "https://example.invalid/78" });
		if (url.endsWith("/issues/7/comments") && method === "POST")
			return response({ id: 79, html_url: "https://example.invalid/79" });
		if (url.endsWith("/issues/7/labels") && method === "POST")
			return response([{ name: "bug" }, { name: "triage" }]);
		if (url.endsWith("/issues/7") && method === "PATCH")
			return response({ id: 7, assignees: [{ login: "alice" }] });
		if (url.endsWith("/actions/jobs/12/rerun") && method === "POST")
			return response(null, 201);
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([github], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		expect(
			await confirmed(
				api,
				{
					action: "unapprove-change",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					sha,
					requestId: "unapprove-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: 55, state: "DISMISSED" } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "reply-discussion",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					scope: "change",
					discussionId: "77",
					body: "reply",
					requestId: "reply-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: 78 } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "reply-discussion",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					scope: "issue",
					discussionId: "77",
					body: "issue reply",
					requestId: "reply-2",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: 79 } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "add-labels",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					scope: "issue",
					labels: ["bug", "triage"],
					requestId: "labels-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { labels: ["bug", "triage"] } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "set-assignees",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					scope: "issue",
					assignees: ["alice"],
					requestId: "assignees-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { assignees: ["alice"] } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "retry-job",
					provider: "github-fixture",
					repository: "org/repo",
					job: 12,
					requestId: "job-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { target: "org/repo:job:12" },
		});
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("GitLab unapprove, discussion resolution, labels, assignees and job writes", async () => {
	const stateDir = stateDirectory();
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/merge_requests/4") && method === "GET")
			return response({ diff_refs: { head_sha: sha } });
		if (url.endsWith("/merge_requests/4/unapprove") && method === "POST")
			return response({ id: 4, state: "unapproved" });
		if (url.endsWith("/discussions/disc-1/notes") && method === "POST")
			return response({ id: 90, web_url: "https://gitlab.example/note/90" });
		if (url.endsWith("/discussions/disc-1?resolved=true") && method === "PUT")
			return response({ id: "disc-1", resolved: true });
		if (url.endsWith("/issues/5") && method === "PUT")
			return response({ id: 5, labels: ["bug"] });
		if (url.endsWith("/users?username=alice")) return response([{ id: 11 }]);
		if (url.endsWith("/merge_requests/4") && method === "PUT")
			return response({ iid: 4, assignee_ids: [11] });
		if (url.endsWith("/jobs/12/retry") && method === "POST")
			return response({ id: 12, status: "pending" });
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([gitlab], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		expect(
			await confirmed(
				api,
				{
					action: "unapprove-change",
					provider: "gitlab-fixture",
					repository: "group/repo",
					number: 4,
					sha,
					requestId: "unapprove-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { state: "unapproved" } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "reply-discussion",
					provider: "gitlab-fixture",
					repository: "group/repo",
					number: 4,
					scope: "change",
					discussionId: "disc-1",
					body: "reply",
					requestId: "reply-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: 90 } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "set-discussion-resolved",
					provider: "gitlab-fixture",
					repository: "group/repo",
					number: 4,
					discussionId: "disc-1",
					resolved: true,
					requestId: "resolve-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { resolved: true } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "add-labels",
					provider: "gitlab-fixture",
					repository: "group/repo",
					number: 5,
					scope: "issue",
					labels: ["bug"],
					requestId: "labels-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { labels: ["bug"] } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "set-assignees",
					provider: "gitlab-fixture",
					repository: "group/repo",
					number: 4,
					scope: "change",
					assignees: ["alice"],
					requestId: "assignees-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { assignees: ["alice"] } },
		});
		expect(
			await confirmed(
				api,
				{
					action: "retry-job",
					provider: "gitlab-fixture",
					repository: "group/repo",
					job: 12,
					requestId: "job-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { status: "pending" } },
		});
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("GitHub review-thread resolution uses GraphQL", async () => {
	const stateDir = stateDirectory();
	let resolved = false;
	const calls: string[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/api/graphql") && method === "POST") {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
				variables?: Record<string, unknown>;
			};
			const query = body.query ?? "";
			if (query.includes("reviewThreads")) {
				calls.push("threads");
				return response({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [
										{
											id: "THREAD1",
											isResolved: resolved,
											comments: { nodes: [{ databaseId: 77 }] },
										},
									],
								},
							},
						},
					},
				});
			}
			if (query.includes("unresolveReviewThread")) {
				calls.push(`unresolve:${String(body.variables?.threadId)}`);
				resolved = false;
				return response({
					data: {
						unresolveReviewThread: {
							thread: { id: "THREAD1", isResolved: false },
						},
					},
				});
			}
			if (query.includes("resolveReviewThread")) {
				calls.push(`resolve:${String(body.variables?.threadId)}`);
				resolved = true;
				return response({
					data: {
						resolveReviewThread: {
							thread: { id: "THREAD1", isResolved: true },
						},
					},
				});
			}
		}
		return response({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	try {
		const api = createProviderApi([github], tokens, fetchImpl, { stateDir });
		const signal = new AbortController().signal;
		expect(
			await confirmed(
				api,
				{
					action: "set-discussion-resolved",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					discussionId: "77",
					resolved: true,
					requestId: "resolve-gh-1",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: "THREAD1", isResolved: true } },
		});
		expect(calls).toContain("resolve:THREAD1");
		expect(
			await confirmed(
				api,
				{
					action: "set-discussion-resolved",
					provider: "github-fixture",
					repository: "org/repo",
					number: 7,
					discussionId: "77",
					resolved: false,
					requestId: "resolve-gh-2",
				},
				signal,
			),
		).toMatchObject({
			status: "completed",
			receipt: { result: { id: "THREAD1", isResolved: false } },
		});
		expect(calls).toContain("unresolve:THREAD1");
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
