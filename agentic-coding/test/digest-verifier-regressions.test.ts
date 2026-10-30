import { expect, test } from "bun:test";
import {
	classifyDigestEvidence,
	dailyDigestWindow,
	renderDailyDigest,
} from "../src/scheduling/daily-digest.ts";
import {
	DIGEST_SOURCE_EVENT_BUDGET,
	DIGEST_SOURCE_NESTED_BUDGET,
	normalizeDigestSourcePage,
} from "../src/scheduling/digest-sources.ts";

const due = Date.parse("2026-03-30T07:00:00Z"),
	at = new Date(due - 1000).toISOString(),
	window = dailyDigestWindow(due);

test("nested Jira work and event allocation stop during traversal, including irrelevant/out-of-window data", () => {
	for (const inWindow of [true, false]) {
		let inspected = 0;
		const change = {
			get field() {
				inspected++;
				return "status";
			},
			fromString: "Open",
			toString: "Closed",
		};
		const page = normalizeDigestSourcePage({
			source: "jira",
			scope: "synthetic",
			window,
			value: {
				issues: [
					{
						key: "BUDGET-1",
						fields: {
							summary: "bounded",
							created: inWindow ? at : "2000-01-01",
							comment: {
								comments: Array(20000).fill({ id: "comment", created: at }),
							},
						},
						changelog: {
							histories: [
								{
									id: "history",
									created: inWindow ? at : "2000-01-01",
									items: Array(20000).fill(change),
								},
							],
						},
					},
				],
			},
		});
		expect(page.truncated).toBe(true);
		expect(page.items.length).toBeLessThanOrEqual(DIGEST_SOURCE_EVENT_BUDGET);
		expect(inspected).toBeLessThanOrEqual(DIGEST_SOURCE_NESTED_BUDGET);
		expect(page.diagnostics).toContain(
			inWindow ? "normalized-event-cap" : "source-nested-inspection-cap",
		);
		if (inWindow) expect(page.items).toHaveLength(DIGEST_SOURCE_EVENT_BUDGET);
		else expect(page.items).toHaveLength(0);
	}
	let commentsInspected = 0;
	const comment = {
		id: "comment",
		get created() {
			commentsInspected++;
			return "2000-01-01";
		},
	};
	const comments = normalizeDigestSourcePage({
		source: "jira",
		scope: "synthetic",
		window,
		value: {
			issues: [{ key: "BUDGET-2", comments: Array(20000).fill(comment) }],
		},
	});
	expect(commentsInspected).toBe(DIGEST_SOURCE_NESTED_BUDGET);
	expect(comments.truncated).toBe(true);
	expect(comments.diagnostics).toContain("source-nested-inspection-cap");
});

test("normalized verified Renovate security/major/minor/patch and medium Wiz evidence occupy their independent report categories", () => {
	const cases = [
		{
			id: "security-both",
			labels: ["security"],
			description: "https://github.com/advisories/GHSA-abcd-1234-efgh",
			expected: "Important",
		},
		{
			id: "security-label-only",
			labels: ["security"],
			description: "no advisory",
			expected: "Minor",
		},
		{
			id: "security-advisory-only",
			labels: [],
			description: "https://github.com/advisories/GHSA-abcd-1234-efgh",
			expected: "Minor",
		},
		{ id: "major", labels: ["renovate:major"], expected: "Relevant" },
		{ id: "minor", labels: ["renovate:minor"], expected: "Minor" },
		{ id: "patch", labels: ["renovate:patch"], expected: "Minor" },
	] as const;
	const events = cases.flatMap(
		(item) =>
			normalizeDigestSourcePage({
				source: "gitlab",
				scope: "local/project",
				window,
				value: [
					{
						...item,
						title: item.id,
						web_url: `https://gitlab.example.invalid/local/project/-/merge_requests/${item.id}`,
						created_at: at,
						author: { username: "renovate", bot: true },
					},
				],
			}).items,
	);
	const wiz = normalizeDigestSourcePage({
		source: "wiz",
		scope: "synthetic",
		window,
		value: [
			{
				id: "medium-wiz",
				title: "medium-wiz",
				severity: "MEDIUM",
				createdAt: at,
				url: "https://wiz.example.invalid/medium",
			},
		],
	}).items;
	const report = renderDailyDigest({
		occurrenceId: "synthetic",
		nominalDue: due,
		executedAt: due,
		events: [...events, ...wiz],
		coverage: [],
	});
	for (const item of [
		...cases,
		{ id: "medium-wiz", expected: "Relevant" as const },
	]) {
		const event = [...events, ...wiz].find((event) => event.id === item.id);
		if (!event) throw new Error("Missing normalized fixture event");
		expect(classifyDigestEvidence(event).importance).toBe(item.expected);
		for (const category of ["Important", "Relevant", "Minor"]) {
			const section =
				report.split(`## ${category}\n`)[1]?.split("\n## ")[0] ?? "";
			expect(section.includes(`- ${item.id} —`)).toBe(
				category === item.expected,
			);
		}
	}
});
