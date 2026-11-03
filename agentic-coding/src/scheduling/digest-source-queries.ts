import { dailyDigestWindow } from "./daily-digest.ts";
/** Reviewed provider parameters; source text/model claims cannot widen evidence windows. */
export function digestSourceQueryPlan(nominalDue: number) {
	const window = dailyDigestWindow(nominalDue),
		start = new Date(window.start).toISOString(),
		end = new Date(window.end).toISOString();
	// Jira's query timezone is not advertised: widen discovery by a whole day,
	// do not upper-bound updated candidates during late execution, then filter real events.
	const lowerDate = new Date(window.start - 86400000)
		.toISOString()
		.slice(0, 10);
	return {
		window,
		jira: {
			jql: `(created >= "${lowerDate}" OR updated >= "${lowerDate}") ORDER BY updated ASC`,
			maxResults: 100,
			fields: [
				"summary",
				"created",
				"updated",
				"status",
				"priority",
				"resolution",
				"assignee",
				"duedate",
				"comment",
				"changelog",
			],
		},
		wiz: {
			list_issues: { created_after: start, created_before: end, first: 20 },
			list_posture_issues: {
				created_at_after: start,
				created_at_before: end,
				limit: 100,
			},
			list_attack_surface_findings: {
				first_seen_after: start,
				first_seen_before: end,
				limit: 100,
			},
		},
		gitlab: { query: "", source_branch: "", state: "all" },
		budgets: {
			reads: 1000,
			pagesPerScope: 100,
			inspectedPerScope: 10000,
			emittedEvents: 2000,
		},
	};
}
