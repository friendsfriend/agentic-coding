// Pure evidence and rendering boundary. External text never grants authority.
export interface DigestWindow {
	readonly start: number;
	readonly end: number;
}
export function dailyDigestWindow(nominalDue: number): DigestWindow {
	if (!Number.isSafeInteger(nominalDue) || nominalDue < 86_400_000)
		throw new Error("Invalid nominal digest occurrence time.");
	return { start: nominalDue - 86_400_000, end: nominalDue };
}
export function inDigestWindow(
	time: number | undefined,
	window: DigestWindow,
): boolean {
	return (
		time !== undefined &&
		Number.isFinite(time) &&
		time >= window.start &&
		time < window.end
	);
}
export type DigestImportance = "Important" | "Relevant" | "Minor";
export interface DigestEvidence {
	readonly source: "jira" | "wiz" | "gitlab";
	readonly scope: string;
	readonly id: string;
	readonly eventId: string;
	readonly title: string;
	readonly url: string;
	readonly at: number;
	readonly kind:
		| "created"
		| "updated-unverified"
		| "status"
		| "assignee"
		| "priority"
		| "resolution"
		| "sprint"
		| "due-date"
		| "comment";
	readonly status?: string;
	readonly exposure?: string;
	readonly severity?: "critical" | "high" | "medium" | "low" | "informational";
	readonly urgency?: "highest" | "critical";
	readonly blockingMovement?: boolean;
	readonly securityEvidence?: boolean;
	readonly verifiedRenovate?: boolean;
	readonly updateType?: "major" | "minor" | "patch";
}
export interface DigestCoverage {
	readonly source: string;
	readonly scope: string;
	readonly status: "success" | "partial" | "unavailable";
	readonly pages: number;
	readonly items: number;
	readonly truncated: boolean;
	readonly missingFields: readonly string[];
	/** Bounded nonsecret codes, never raw provider errors or response bodies. */
	readonly diagnostics: readonly string[];
}
export function classifyDigestEvidence(event: DigestEvidence): {
	importance: DigestImportance;
	reason: string;
	action: string;
} {
	if (event.source === "jira") {
		if (event.urgency || event.blockingMovement)
			return {
				importance: "Important",
				reason: "Evidenced highest/critical urgency or blocking movement",
				action: "Review urgency and the next responsible action in Jira",
			};
		if (
			[
				"status",
				"assignee",
				"priority",
				"resolution",
				"sprint",
				"due-date",
			].includes(event.kind)
		)
			return {
				importance: "Relevant",
				reason: "Verified task movement",
				action: "Review the recorded change and ownership",
			};
		return {
			importance: "Minor",
			reason:
				event.kind === "updated-unverified"
					? "Updated timestamp only; movement unverified"
					: "Routine task creation or comment",
			action: "Read the linked task if relevant",
		};
	}
	if (event.source === "wiz") {
		if (event.severity === "critical" || event.severity === "high")
			return {
				importance: "Important",
				reason: "New finding with evidenced critical/high severity",
				action:
					"Triage exposure and remediation in Wiz; no action was performed",
			};
		if (event.severity === "medium")
			return {
				importance: "Relevant",
				reason: "New medium-severity finding",
				action: "Review finding and ownership in Wiz",
			};
		return {
			importance: "Minor",
			reason: event.severity
				? "Low/informational new finding"
				: "Severity unavailable; urgency not inferred",
			action: "Verify severity and impact in Wiz",
		};
	}
	if (event.securityEvidence)
		return {
			importance: "Important",
			reason: "Verified Renovate security update with advisory evidence",
			action:
				"Review the advisory and merge request; no approval or merge was performed",
		};
	if (event.updateType === "major")
		return {
			importance: "Relevant",
			reason: "Verified major dependency update",
			action: "Review compatibility and migration notes",
		};
	return {
		importance: "Minor",
		reason: event.updateType
			? "Verified patch/minor dependency update"
			: "Dependency update type unavailable; urgency not inferred",
		action: "Review the dependency change when convenient",
	};
}
function safeText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control characters from untrusted source text
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.replace(/[\\`*_{}[\]<>#|!]/g, " ")
			.slice(0, 300)
	);
}
function safeLink(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			[
				...url.searchParams.keys(),
				...new URLSearchParams(url.hash.slice(1)).keys(),
			].some((key) =>
				/token|secret|password|credential|api.?key|access.?key|signature|authorization|bearer|jwt|^(auth|code|session|key|sig)$/i.test(
					key,
				),
			)
		)
			return undefined;
		return url.href.replace(/[()]/g, (character) =>
			encodeURIComponent(character),
		);
	} catch {
		return undefined;
	}
}
export function digestEvents(
	events: readonly DigestEvidence[],
	window: DigestWindow,
): DigestEvidence[] {
	const unique = new Map<string, DigestEvidence>();
	for (const event of events) {
		if (!inDigestWindow(event.at, window)) continue;
		if (event.source === "wiz" && event.kind !== "created") continue;
		if (
			event.source === "gitlab" &&
			(event.kind !== "created" || !event.verifiedRenovate)
		)
			continue;
		const key = JSON.stringify([
			event.source,
			event.source === "wiz" ? "findings" : event.scope,
			event.id,
			event.eventId,
		]);
		if (!unique.has(key)) unique.set(key, event);
	}
	return [...unique.values()].sort(
		(a, b) => a.at - b.at || a.id.localeCompare(b.id),
	);
}
export function renderDailyDigest(input: {
	occurrenceId: string;
	nominalDue: number;
	executedAt: number;
	events: readonly DigestEvidence[];
	coverage: readonly DigestCoverage[];
}): string {
	const window = dailyDigestWindow(input.nominalDue);
	const events = digestEvents(input.events, window);
	const sourceCoverage = [...input.coverage];
	for (const source of ["jira", "wiz", "gitlab"])
		if (!sourceCoverage.some((entry) => entry.source === source))
			sourceCoverage.push({
				source,
				scope: "expected-source-not-reported",
				status: "unavailable",
				pages: 0,
				items: 0,
				truncated: false,
				missingFields: [],
				diagnostics: ["source-coverage-not-supplied"],
			});
	const lines = [
		"# Daily task digest",
		`Occurrence: ${safeText(input.occurrenceId)}`,
		`Nominal due: ${new Date(input.nominalDue).toISOString()}`,
		`Executed: ${new Date(input.executedAt).toISOString()}`,
		`Window: [${new Date(window.start).toISOString()}, ${new Date(window.end).toISOString()}) — preceding 24 hours, including Monday.`,
		"Late execution never widens the nominal window. Sources are read-only; recommendations were not executed.",
		`Coverage: ${sourceCoverage.length > 0 && sourceCoverage.every((source) => source.status === "success" && !source.truncated && source.missingFields.length === 0) ? "complete for declared scopes" : "partial or unavailable; see declared scopes below"}`,
	];
	for (const importance of ["Important", "Relevant", "Minor"] as const) {
		lines.push(`\n## ${importance}`);
		const selected = events.filter(
			(event) => classifyDigestEvidence(event).importance === importance,
		);
		if (!selected.length)
			lines.push(
				"No verified items in this category from the covered results; see coverage limitations below.",
			);
		for (const event of selected) {
			const { reason, action } = classifyDigestEvidence(event);
			const url = safeLink(event.url);
			lines.push(
				`- ${safeText(event.id)} — ${safeText(event.title)} (${safeText(event.source)} / ${safeText(event.scope)}, ${event.kind}, ${new Date(event.at).toISOString()}${event.severity ? `, severity ${event.severity}` : ""}${event.status ? `, observed status ${safeText(event.status)}` : ""}${event.exposure ? `, exposure ${safeText(event.exposure)}` : ""}): ${reason}. ${action}.${url ? ` [Source](${url})` : " Source link unavailable."}`,
			);
		}
	}
	lines.push("\n## Source coverage");
	if (!input.coverage.length)
		lines.push(
			"Unavailable: no source coverage was supplied. This is not an empty-result claim.",
		);
	for (const coverage of sourceCoverage)
		lines.push(
			`- ${safeText(coverage.source)} / ${safeText(coverage.scope)}: ${coverage.status}; ${coverage.pages} page(s), ${coverage.items} item(s); truncated: ${coverage.truncated}; missing fields: ${coverage.missingFields.map(safeText).join(", ") || "none reported"}; diagnostics: ${coverage.diagnostics.map(safeText).join(", ") || "none"}.`,
		);
	return lines.join("\n");
}
export interface DigestPage<T> {
	readonly items: readonly T[];
	readonly next?: string;
	readonly truncated?: boolean;
	readonly missingFields?: readonly string[];
	readonly diagnostics?: readonly string[];
}
