import { expect, test } from "bun:test";
import {
	classifyDigestEvidence,
	type DigestCoverage,
	dailyDigestWindow,
	renderDailyDigest,
} from "../src/scheduling/daily-digest.ts";
import { normalizeDigestSourcePage } from "../src/scheduling/digest-sources.ts";

const nominalDue = Date.parse("2026-03-17T08:00:00Z"),
	window = dailyDigestWindow(nominalDue);
const coverage = (
	source: string,
	status: DigestCoverage["status"],
): DigestCoverage => ({
	source,
	scope: "synthetic",
	status,
	pages: status === "success" ? 1 : 0,
	items: 0,
	truncated: false,
	missingFields: [],
	diagnostics: status === "success" ? [] : ["permission-denied"],
});
const render = (sources: DigestCoverage[]) =>
	renderDailyDigest({
		occurrenceId: "synthetic",
		nominalDue,
		executedAt: nominalDue,
		events: [],
		coverage: sources,
	});

test("omitted sources cannot be rendered as complete and total outages never claim empty success", () => {
	const partial = render([coverage("wiz", "success")]);
	expect(partial).toContain("partial or unavailable");
	expect(partial).toContain("jira / expected-source-not-reported: unavailable");
	expect(partial).toContain(
		"gitlab / expected-source-not-reported: unavailable",
	);
	const unavailable = render([
		coverage("jira", "unavailable"),
		coverage("wiz", "unavailable"),
		coverage("gitlab", "unavailable"),
	]);
	expect(unavailable).toContain("permission-denied");
	expect(unavailable).not.toContain("Coverage: complete");
	expect(
		render([
			coverage("jira", "success"),
			coverage("wiz", "success"),
			coverage("gitlab", "success"),
		]),
	).toContain("complete for declared scopes");
});

test("Jira nested history/comment caps remain visible and observed done status does not invent urgency", () => {
	const value = {
		key: "A-1",
		self: "https://jira.invalid/rest/api/3/issue/A-1",
		fields: {
			summary: "Synthetic bug",
			created: "2026-03-16T09:00:00Z",
			priority: { name: "Critical" },
			status: { name: "Done", statusCategory: { key: "done" } },
			duedate: "2026-03-17",
			comment: {
				total: 2,
				comments: [
					{
						id: "c1",
						created: "2026-03-16T10:00:00Z",
						body: "private comment must not appear",
					},
				],
			},
		},
		changelog: {
			total: 3,
			histories: [
				{
					id: "h1",
					created: "2026-03-16T11:00:00Z",
					items: [{ field: "resolution" }],
				},
			],
		},
	};
	const page = normalizeDigestSourcePage({
		source: "jira",
		scope: "synthetic",
		window,
		value,
	});
	expect(page.items).toHaveLength(3);
	expect(page.missingFields).toContain("changelog-pages-remaining");
	expect(page.missingFields).toContain("comment-pages-remaining");
	expect(JSON.stringify(page)).not.toContain("private comment");
	expect(
		page.items.every(
			(event) =>
				event.status === "Done" &&
				classifyDigestEvidence(event).importance !== "Important",
		),
	).toBe(true);
	value.fields.status = {
		name: "In progress",
		statusCategory: { key: "indeterminate" },
	};
	value.fields.priority.name = "Critical";
	const active = normalizeDigestSourcePage({
		source: "jira",
		scope: "synthetic",
		window,
		value,
	});
	expect(
		active.items.every(
			(event) => classifyDigestEvidence(event).importance === "Important",
		),
	).toBe(true);
});

test("a direct Jira history page retains parent event identity rather than inventing issue creation", () => {
	const page = normalizeDigestSourcePage({
		source: "jira",
		scope: "synthetic",
		window,
		context: {
			id: "A-1",
			title: "Synthetic bug",
			url: "https://jira.invalid/browse/A-1",
		},
		value: {
			id: "h1",
			created: "2026-03-16T11:00:00Z",
			items: [{ field: "resolution" }],
		},
	});
	expect(page.items).toHaveLength(1);
	expect(page.items[0]).toMatchObject({
		id: "A-1",
		eventId: "h1:0",
		kind: "resolution",
	});
});
