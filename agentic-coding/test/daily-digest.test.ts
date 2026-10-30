import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	boundGitLabProjects,
	collectionCallAllowed,
	collectionToolVisible,
} from "../src/agent-host/collection-policy.ts";
import {
	classifyDigestEvidence,
	type DigestEvidence,
	dailyDigestWindow,
	digestEvents,
	renderDailyDigest,
} from "../src/scheduling/daily-digest.ts";
import { collectDigestPages } from "../src/server/scheduling/digest-pagination.ts";
import {
	discoverLocalGitLabProjects,
	gitLabRemote,
} from "../src/server/scheduling/digest-repositories.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { force: true, recursive: true });
});
const due = Date.parse("2026-03-30T07:00:00Z");
const event: DigestEvidence = {
	source: "jira",
	scope: "all accessible projects",
	id: "A-1",
	eventId: "created",
	title: "Synthetic task",
	url: "https://example.invalid/A-1",
	at: due - 1000,
	kind: "created",
};
test("GitLab source binding rejects absent and wrong hosts even when the project path matches", () => {
	const projects = [
		{ host: "gitlab-a.example.invalid", project: "team/repo" },
		{ host: "gitlab-b.example.invalid", project: "team/repo" },
	];
	expect(boundGitLabProjects(projects, undefined)).toEqual([]);
	expect(boundGitLabProjects(projects, "unknown.example.invalid")).toEqual([]);
	expect(boundGitLabProjects(projects, "gitlab-b.example.invalid")).toEqual([
		projects[1],
	]);
});
test("all-source failure stays diagnostic and untrusted report links/control characters do not leak credentials", () => {
	const report = renderDailyDigest({
		occurrenceId: "synthetic",
		nominalDue: due,
		executedAt: due + 1000,
		events: [
			{
				...event,
				title: "Synthetic\u001b[31m",
				url: "https://example.invalid/path?access_token=secret-test-value",
			},
		],
		coverage: [
			{
				source: "jira",
				scope: "all-accessible",
				status: "unavailable",
				pages: 0,
				items: 0,
				truncated: false,
				missingFields: [],
				diagnostics: ["source-query-failed-check-integration-access"],
			},
		],
	});
	expect(report).toContain("partial or unavailable");
	expect(report).toContain("unavailable");
	expect(report).not.toContain("secret-test-value");
	expect(report).not.toContain(String.fromCharCode(27));
});
test("Monday/DST window is exactly 24h with half-open bounds", () => {
	const window = dailyDigestWindow(due);
	expect(window.start).toBe(due - 86_400_000);
	expect(
		digestEvents(
			[
				{ ...event, at: window.start },
				{ ...event, eventId: "end", at: window.end },
			],
			window,
		),
	).toHaveLength(1);
});
test("timestamps never invent movement, updated Wiz findings and arbitrary MRs are excluded", () => {
	expect(
		classifyDigestEvidence({ ...event, kind: "updated-unverified" }).importance,
	).toBe("Minor");
	expect(
		classifyDigestEvidence({ ...event, kind: "assignee" }).importance,
	).toBe("Relevant");
	expect(
		classifyDigestEvidence({ ...event, source: "wiz", severity: "high" })
			.importance,
	).toBe("Important");
	expect(
		classifyDigestEvidence({
			...event,
			source: "gitlab",
			verifiedRenovate: true,
		}).importance,
	).toBe("Minor");
	expect(
		digestEvents(
			[
				event,
				event,
				{ ...event, source: "wiz", kind: "status" },
				{ ...event, source: "gitlab" },
			],
			dailyDigestWindow(due),
		),
	).toEqual([event]);
});
test("pagination retains successful pages through outages and never claims failed access is empty", async () => {
	let calls = 0;
	const partial = await collectDigestPages(
		async () => {
			if (++calls === 2) throw new Error("synthetic outage");
			return { items: [event], next: "next" };
		},
		{ source: "jira", scope: "all", maxPages: 3, maxItems: 10 },
	);
	expect(partial.items).toEqual([event]);
	expect(partial.coverage.status).toBe("partial");
	const unavailable = await collectDigestPages(
		async () => {
			throw new Error("private error not reproduced");
		},
		{ source: "wiz", scope: "domain", maxPages: 3, maxItems: 10 },
	);
	expect(unavailable.coverage.status).toBe("unavailable");
	expect(JSON.stringify(unavailable)).not.toContain("private error");
	const report = renderDailyDigest({
		occurrenceId: "fake",
		nominalDue: due,
		executedAt: due + 1000,
		events: partial.items,
		coverage: [partial.coverage, unavailable.coverage],
	});
	expect(report).toContain("Synthetic task");
	expect(report).toContain("unavailable");
	expect(report).toContain("preceding 24 hours");
});
test("cursor loops and caps are visible; missing fields preserve partial coverage", async () => {
	const result = await collectDigestPages(
		async () => ({
			items: [1, 2, 3],
			next: "same",
			missingFields: ["severity"],
		}),
		{ source: "wiz", scope: "fake", maxPages: 3, maxItems: 4 },
	);
	expect(result.items).toHaveLength(4);
	expect(result.coverage.truncated).toBe(true);
	expect(result.coverage.status).toBe("partial");
});
test("collection denies shell/writes/remediation and generic MCP mutation dispatch", () => {
	for (const name of [
		"bash",
		"write",
		"edit",
		"start_workflow",
		"pi__tools-jira-cloud__jira_cloud_add_comment",
	])
		expect(collectionToolVisible(name)).toBe(false);
	expect(
		collectionCallAllowed("mcp__wiz__execute", {
			tool_name: "list_issues",
			parameters: {},
		}),
	).toBe(true);
	expect(
		collectionCallAllowed("mcp__wiz__execute", { tool_name: "delete_issue" }),
	).toBe(false);
	expect(
		collectionCallAllowed("mcp__wiz__execute", {
			tool_name: "list_unknown_tool",
		}),
	).toBe(false);
	expect(
		collectionCallAllowed("pi__tools-jira-cloud__jira_cloud_search", {
			jql: "updated >= -1d",
		}),
	).toBe(true);
});
test("GitLab scope checks the consumed provider argument, denies alias/fallback smuggling and accepts canonical URL encoding", () => {
	for (const name of [
		"pi__index__gitlab_search_merge_requests",
		"mcp__index__gitlab_search_merge_requests",
	]) {
		expect(
			collectionCallAllowed(name, { project_id: "group/repo" }, ["group/repo"]),
		).toBe(true);
		expect(
			collectionCallAllowed(name, { project_id: "group%2Frepo" }, [
				"group/repo",
			]),
		).toBe(true);
		expect(
			collectionCallAllowed(name, { project: "group/repo" }, ["group/repo"]),
		).toBe(false);
		expect(
			collectionCallAllowed(
				name,
				{ project: "group/repo", project_id: "foreign/repo" },
				["group/repo"],
			),
		).toBe(false);
		expect(
			collectionCallAllowed(name, { project_id: "group%252Frepo" }, [
				"group/repo",
			]),
		).toBe(false);
	}
	expect(
		collectionCallAllowed(
			"pi__tools_gitlab__gitlab_mr_get",
			{ project: "group/repo", project_id: "foreign/repo" },
			["group/repo"],
		),
	).toBe(false);
	expect(
		collectionCallAllowed(
			"pi__tools_gitlab__gitlab_mr_get",
			{ project_id: "group/repo" },
			["group/repo"],
		),
	).toBe(false);
});

test("GitLab remote identities deduplicate SSH/HTTPS and preserve namespaces/hosts", async () => {
	const hosts = ["gitlab.example.invalid", "other.example.invalid"];
	expect(
		gitLabRemote("git@gitlab.example.invalid:team/sub/repo.git", hosts),
	).toEqual(
		gitLabRemote("https://gitlab.example.invalid/team/sub/repo.git", hosts),
	);
	expect(
		gitLabRemote("https://github.com/team/repo.git", hosts),
	).toBeUndefined();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "digest-repos-"));
	roots.push(root);
	for (const repo of ["one", "two"])
		fs.mkdirSync(path.join(root, repo, ".git"), { recursive: true });
	const result = await discoverLocalGitLabProjects({
		roots: [root, root],
		hosts,
		remotes: async () => ["git@gitlab.example.invalid:team/sub/repo.git"],
	});
	expect(result.projects).toHaveLength(1);
	expect(result.truncated).toBe(false);
});
