import { expect, test } from "bun:test";
import {
	dailyDigestWindow,
	digestEvents,
} from "../src/scheduling/daily-digest.ts";
import { normalizeDigestSourcePage } from "../src/scheduling/digest-sources.ts";

const due = Date.parse("2026-03-30T07:00:00Z"),
	at = new Date(due - 1000).toISOString(),
	window = dailyDigestWindow(due);
test("Jira adapters preserve real event identity and exact comments/changelog pagination without dumping private bodies", () => {
	const page = normalizeDigestSourcePage({
		source: "jira",
		scope: "all-accessible",
		window,
		value: {
			issues: [
				{
					key: "FAKE-1",
					self: "https://jira.example.invalid/rest/api/3/issue/1",
					fields: {
						summary: "Synthetic task",
						created: at,
						updated: at,
						priority: { name: "Highest" },
						comment: {
							comments: [
								{
									id: "comment",
									created: at,
									body: "private raw comment must not appear",
								},
							],
						},
					},
					changelog: {
						histories: [
							{
								id: "history",
								created: at,
								items: [
									{ field: "status", fromString: "Open", toString: "Closed" },
									{ field: "assignee" },
								],
							},
						],
					},
				},
			],
			total: 2,
			startAt: 0,
		},
	});
	expect(page.next).toBe("1");
	expect(page.items.map((item) => item.kind)).toEqual([
		"created",
		"status",
		"assignee",
		"comment",
	]);
	expect(page.items[1]?.eventId).toBe("history:0");
	expect(page.items[0]?.url).toBe("https://jira.example.invalid/browse/FAKE-1");
	expect(JSON.stringify(page)).not.toContain("private raw");
	const updated = normalizeDigestSourcePage({
		source: "jira",
		scope: "all-accessible",
		window,
		value: {
			issues: [
				{ key: "FAKE-2", fields: { summary: "Synthetic", updated: at } },
			],
		},
	});
	expect(updated.items.map((item) => item.kind)).toEqual([
		"updated-unverified",
	]);
	expect(updated.missingFields).toContain("created");
	const context = {
		id: "FAKE-1",
		title: "Synthetic",
		url: "https://jira.example.invalid/browse/FAKE-1",
	};
	const comments = normalizeDigestSourcePage({
		source: "jira",
		scope: "comments",
		context,
		window,
		value: {
			comments: [{ id: "comment", created: at, body: "private" }],
			startAt: 0,
			total: 2,
		},
	});
	expect(comments.items[0]?.kind).toBe("comment");
	expect(comments.next).toBe("1");
	const history = normalizeDigestSourcePage({
		source: "jira",
		scope: "history",
		context,
		window,
		value: {
			values: [{ id: "history", created: at, items: [{ field: "priority" }] }],
			isLast: true,
		},
	});
	expect(history.items[0]?.kind).toBe("priority");
});
test("Wiz NEW findings use first-created/seen evidence, retain domain pagination gaps and deduplicate overlapping domains", () => {
	const first = normalizeDigestSourcePage({
		source: "wiz",
		scope: "issues",
		window,
		value: {
			data: {
				issues: {
					nodes: [
						{ id: "fake", title: "Synthetic", createdAt: at, severity: "HIGH" },
						{
							id: "old",
							title: "Old",
							createdAt: "2020-01-01T00:00:00Z",
							updatedAt: at,
						},
						{ id: "missing", updatedAt: at },
					],
					pageInfo: { hasNextPage: true, endCursor: "opaque-next" },
				},
			},
		},
	});
	expect(first.next).toBe("opaque-next");
	expect(first.items).toHaveLength(1);
	expect(first.items[0]?.severity).toBe("high");
	expect(first.missingFields).toContain("created-or-first-seen");
	const overlap = normalizeDigestSourcePage({
		source: "wiz",
		scope: "posture",
		window,
		value: { findings: [{ id: "fake", firstSeenAt: at }] },
	});
	expect(digestEvents([...first.items, ...overlap.items], window)).toHaveLength(
		1,
	);
	const broken = normalizeDigestSourcePage({
		source: "wiz",
		scope: "unsupported",
		window,
		value: { nodes: [], pageInfo: { hasNextPage: true } },
	});
	expect(broken.truncated).toBe(true);
	expect(broken.diagnostics).toContain("pagination-continuation-unavailable");
});
test("GitLab MR adapter accepts only authenticated Renovate bot identity and actual creation evidence", () => {
	const mr = {
		id: 12,
		title: "Synthetic major",
		web_url:
			"https://gitlab.example.invalid/team/nested/repo/-/merge_requests/12",
		created_at: at,
		author: { username: "renovate", bot: true },
		labels: ["renovate:major"],
	};
	const page = normalizeDigestSourcePage({
		source: "gitlab",
		scope: "gitlab.example.invalid/team/nested/repo",
		window,
		value: [
			mr,
			{
				...mr,
				id: 13,
				author: { username: "someone", bot: false },
				source_branch: "renovate/fake",
			},
			{ ...mr, id: 14, author: { username: "renovate" } },
			{ ...mr, id: 15, created_at: "2020-01-01T00:00:00Z", updated_at: at },
		],
	});
	expect(page.items).toHaveLength(1);
	expect(page.items[0]?.id).toBe("12");
	expect(page.items[0]?.updateType).toBe("major");
	expect(page.missingFields).toContain("authenticated-renovate-bot-identity");
	expect(page.diagnostics).toContain("renovate-author-not-verified-excluded");
	const unknown = normalizeDigestSourcePage({
		source: "gitlab",
		scope: "fake",
		window,
		value: { error: "private failure body" },
	});
	expect(unknown.missingFields).toContain("recognized-result-array");
	expect(JSON.stringify(unknown)).not.toContain("private failure");
});
