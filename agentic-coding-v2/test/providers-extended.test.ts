import { afterEach, expect, test } from "bun:test";
import { digest } from "../src/config.ts";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const seenArtifactAuth: (string | null)[] = [];
let artifactBase = "";
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname);
		if (path === "/artifact-logs") {
			seenArtifactAuth.push(request.headers.get("authorization"));
			return new Response("line1\nline2\n", {
				headers: { "content-type": "text/plain" },
			});
		}
		const json = (value: unknown, status = 200) =>
			Response.json(value, { status });
		if (path === "/repos/o/r/actions/runs/9/jobs")
			return json({
				jobs: [
					{
						id: 11,
						name: "build",
						status: "completed",
						html_url: "https://h/j",
					},
				],
			});
		if (path === "/repos/o/r/actions/jobs/11/logs")
			return new Response(null, {
				status: 302,
				headers: { location: `${artifactBase}/artifact-logs` },
			});
		if (path === "/repos/o/r/pulls/7/files")
			return json([
				{ filename: "a.ts", additions: 3, deletions: 1, patch: "@@ x" },
			]);
		if (path === "/repos/o/r/pulls/7/commits")
			return json([{ sha: "abc123", commit: { message: "fix" } }]);
		if (path === "/repos/o/r/pulls/7/reviews")
			return json([{ id: 21, state: "APPROVED", user: { login: "u" } }]);
		if (
			request.method === "POST" &&
			path === "/repos/o/r/pulls/7/reviews/21/dismissals"
		)
			return json({ id: 21, state: "DISMISSED" });
		if (
			request.method === "POST" &&
			path === "/repos/o/r/actions/runs/9/cancel"
		)
			return json({ id: 9, status: "requested" });
		if (request.method === "PATCH" && path === "/repos/o/r/issues/3")
			return json({ id: 3, labels: ["bug"], assignees: ["u"] });
		if (path === "/repos/o/r/labels")
			return json([{ name: "bug", color: "red" }]);
		if (path === "/repos/o/r/collaborators")
			return json([{ login: "u", role_name: "admin" }]);
		if (path === "/projects/o/r/merge_requests/7/changes")
			return json({ changes: [{ new_path: "b.ts", diff: "diff x" }] });
		if (path === "/projects/o/r/merge_requests/7/versions")
			return json([{ id: 1, head_commit_sha: "def456" }]);
		if (
			request.method === "POST" &&
			path === "/projects/o/r/merge_requests/7/rebase"
		)
			return json({ id: 7, rebase_in_progress: true });
		if (
			request.method === "POST" &&
			path === "/projects/o/r/merge_requests/7/discussions/d1/notes"
		)
			return json({ id: 5, body: "noted" });
		if (
			request.method === "POST" &&
			path === "/projects/o/r/merge_requests/7/discussions/d1"
		)
			return json({ id: "d1", resolved: true });
		if (request.method === "POST" && path === "/projects/o/r/issues/3")
			return json({ id: 3, labels: ["bug"], assignees: [] });
		if (path === "/projects/o/r/jobs/5/trace")
			return new Response("trace line\n", {
				headers: { "content-type": "text/plain" },
			});
		if (request.method === "POST" && path === "/projects/o/r/jobs/5/cancel")
			return json({ id: 5, status: "canceled" });
		if (path === "/projects/o/r/labels")
			return json([{ name: "bug", color: "red" }]);
		if (path === "/projects/o/r/members")
			return json([{ username: "b", access_level: 40 }]);
		if (path === "/projects/o/r/pipelines")
			return json([
				{ id: 6, ref: "main", status: "success", web_url: "https://h/p" },
			]);
		return new Response("no stub", { status: 500 });
	},
});
artifactBase = `http://127.0.0.1:${stub.port}`;
afterEach(() => {
	seenArtifactAuth.length = 0;
	delete process.env.PROVIDER_TEST_TOKEN;
});
const setup = async () => {
	const { app, config } = await fixture(true);
	process.env.PROVIDER_TEST_TOKEN = "stub-secret";
	config.providers.push(
		{
			name: "gh",
			type: "github",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "u",
			tokenRef: "PROVIDER_TEST_TOKEN",
		},
		{
			name: "gl",
			type: "gitlab",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "",
			tokenRef: "PROVIDER_TEST_TOKEN",
		},
	);
	const host = serve(app);
	const headers = {
		Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
		"Content-Type": "application/json",
	};
	const api = (route: string, body?: unknown) =>
		fetch(new URL(route, host.url), {
			method: body === undefined ? "GET" : "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { app, host, api };
};
const approval = (
	op: string,
	target: string,
	payload: Record<string, unknown>,
) => ({
	op,
	target,
	payload,
	approve: digest(JSON.stringify({ op, target, payload })),
});
test("job listing needs a run on github, pipelines list on gitlab", async () => {
	const { app, host, api } = await setup();
	try {
		const missing = await api("/api/providers/gh/pipelines/jobs?repo=o%2Fr");
		expect(missing.status).toBe(400);
		expect(await missing.text()).toContain("requires a run ID");
		const jobs = await (
			await api("/api/providers/gh/pipelines/jobs?repo=o%2Fr&run=9")
		).json();
		expect(jobs).toEqual([
			{
				id: "github-job-11",
				name: "build",
				status: "completed",
				url: "https://h/j",
			},
		]);
		const pipelines = await (
			await api("/api/providers/gl/pipelines/jobs?repo=o%2Fr")
		).json();
		expect(pipelines).toEqual([
			{
				id: "gitlab-pipeline-6",
				name: "main",
				status: "success",
				url: "https://h/p",
			},
		]);
	} finally {
		host.stop();
		await app.close();
	}
});
test("job logs follow the redirect without credentials", async () => {
	const { app, host, api } = await setup();
	try {
		const logs = await (
			await api("/api/providers/gh/pipelines/jobs/logs?repo=o%2Fr&job=11")
		).json();
		expect(logs).toEqual({ log: "line1\nline2\n", truncated: false });
		expect(seenArtifactAuth).toEqual([null]);
		const trace = await (
			await api("/api/providers/gl/pipelines/jobs/logs?repo=o%2Fr&job=5")
		).json();
		expect(trace).toEqual({ log: "trace line\n", truncated: false });
	} finally {
		host.stop();
		await app.close();
	}
});
test("change files and versions map on both hosts", async () => {
	const { app, host, api } = await setup();
	try {
		const files = await (
			await api("/api/providers/gh/changes/files?repo=o%2Fr&number=7")
		).json();
		expect(files).toEqual([
			{ path: "a.ts", additions: 3, deletions: 1, patch: "@@ x" },
		]);
		const commits = await (
			await api("/api/providers/gh/changes/versions?repo=o%2Fr&number=7")
		).json();
		expect(commits).toEqual([
			{ id: "github-commit-abc123", sha: "abc123", message: "fix" },
		]);
		const changes = await (
			await api("/api/providers/gl/changes/files?repo=o%2Fr&number=7")
		).json();
		expect(changes).toEqual([
			{ path: "b.ts", additions: null, deletions: null, patch: "diff x" },
		]);
		const versions = await (
			await api("/api/providers/gl/changes/versions?repo=o%2Fr&number=7")
		).json();
		expect(versions).toEqual([
			{ id: "gitlab-version-1", sha: "def456", message: "" },
		]);
	} finally {
		host.stop();
		await app.close();
	}
});
test("rebase is gitlab-only", async () => {
	const { app, host, api } = await setup();
	try {
		const ok = await (
			await api("/api/providers/gl/changes/rebase", {
				requestId: "r1",
				...approval("rebase-change", "o/r#7", {}),
			})
		).json();
		expect(ok).toEqual({ id: 7, rebase_in_progress: true });
		const no = await api("/api/providers/gh/changes/rebase", {
			requestId: "r2",
			...approval("rebase-change", "o/r#7", {}),
		});
		expect(no.status).toBe(400);
		expect(await no.text()).toContain("unsupported for this provider type");
	} finally {
		host.stop();
		await app.close();
	}
});
test("issue labels and assignees map per host", async () => {
	const { app, host, api } = await setup();
	try {
		const labels = await (
			await api("/api/providers/gh/issues/labels", {
				requestId: "l1",
				...approval("set-issue-labels", "o/r#3", { labels: ["bug"] }),
			})
		).json();
		expect(labels).toEqual({ id: 3, labels: ["bug"] });
		const assignees = await (
			await api("/api/providers/gl/issues/assignees", {
				requestId: "l2",
				...approval("set-issue-assignees", "o/r#3", { assignees: [] }),
			})
		).json();
		expect(assignees).toEqual({ id: 3, assignees: [] });
	} finally {
		host.stop();
		await app.close();
	}
});
test("discussion reply and resolution honor host support", async () => {
	const { app, host, api } = await setup();
	try {
		const reply = await (
			await api("/api/providers/gl/changes/discussions/reply", {
				requestId: "d1",
				...approval("reply-discussion", "o/r#7#d1", { body: "noted" }),
			})
		).json();
		expect(reply).toEqual({ id: 5, body: "noted" });
		const resolved = await (
			await api("/api/providers/gl/changes/discussions/resolve", {
				requestId: "d2",
				...approval("resolve-discussion", "o/r#7#d1", {}),
			})
		).json();
		expect(resolved).toEqual({ id: "d1", resolved: true });
		const no = await api("/api/providers/gh/changes/discussions/resolve", {
			requestId: "d3",
			...approval("resolve-discussion", "o/r#7#1", {}),
		});
		expect(no.status).toBe(400);
		expect(await no.text()).toContain("unsupported for this provider type");
	} finally {
		host.stop();
		await app.close();
	}
});
test("unapprove and cancel reach both hosts", async () => {
	const { app, host, api } = await setup();
	try {
		const dismissed = await (
			await api("/api/providers/gh/changes/unapprove", {
				requestId: "u1",
				...approval("unapprove-change", "o/r#7", {}),
			})
		).json();
		expect(dismissed).toEqual({ id: 21, state: "DISMISSED" });
		const canceled = await (
			await api("/api/providers/gl/pipelines/cancel", {
				requestId: "u2",
				...approval("cancel-job", "o/r#5", {}),
			})
		).json();
		expect(canceled).toEqual({ id: 5, status: "canceled" });
	} finally {
		host.stop();
		await app.close();
	}
});
test("repo labels and collaborators read on both hosts", async () => {
	const { app, host, api } = await setup();
	try {
		const labels = await (
			await api("/api/providers/gh/repos/labels?repo=o%2Fr")
		).json();
		expect(labels).toEqual([{ name: "bug", color: "red" }]);
		const members = await (
			await api("/api/providers/gl/repos/collaborators?repo=o%2Fr")
		).json();
		expect(members).toEqual([{ username: "b", access_level: 40 }]);
	} finally {
		host.stop();
		await app.close();
	}
});
