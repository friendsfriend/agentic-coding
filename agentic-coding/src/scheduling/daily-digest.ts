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
	readonly source: "jira" | "wiz" | "gitlab" | "azure-monitor" | "new-relic";
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
		| "comment"
		| "merged"
		| "log-error"
		| "review-comment"
		| "pipeline-failed";
	readonly service?: string;
	readonly signature?: string;
	readonly count?: number;
	readonly countExact?: boolean;
	readonly provenance?: string;
	readonly lastAt?: number;
	readonly status?: string;
	readonly exposure?: string;
	readonly resourceScope?: string;
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
	readonly attempts?: number;
	readonly failures?: number;
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
	if (event.source === "azure-monitor" || event.source === "new-relic")
		return {
			importance:
				event.severity === "critical" || event.severity === "high"
					? "Important"
					: event.severity === "medium"
						? "Relevant"
						: "Minor",
			reason: event.severity
				? "Observed production errors; customer impact is not established"
				: "Severity unavailable; urgency and customer impact not inferred",
			action:
				"Inspect the signature and service traces, verify impact and assign an owner",
		};
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
	if (!event.verifiedRenovate)
		return {
			importance: ["merged", "review-comment", "pipeline-failed"].includes(
				event.kind,
			)
				? "Relevant"
				: "Minor",
			reason:
				event.kind === "updated-unverified"
					? "Updated timestamp only; substantive activity unverified"
					: "Evidenced merge-request activity",
			action:
				"Review the linked merge request and available discussion or pipeline evidence",
		};
	if (event.securityEvidence)
		return {
			importance: "Important",
			reason: `${event.kind === "created" ? "Verified Renovate creation: " : ""}Verified Renovate security update with advisory evidence`,
			action:
				"Review the advisory and merge request; no approval or merge was performed",
		};
	if (event.updateType === "major")
		return {
			importance: "Relevant",
			reason: `${event.kind === "created" ? "Verified Renovate creation: " : ""}Verified major dependency update`,
			action: "Review compatibility and migration notes",
		};
	return {
		importance: "Minor",
		reason: `${event.kind === "created" ? "Verified Renovate creation: " : ""}${event.updateType ? "Verified patch/minor dependency update" : "Dependency update type unavailable; urgency not inferred"}`,
		action: "Review the dependency change when convenient",
	};
}
function safeText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control characters from untrusted source text
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.replace(
				/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
				"$1=redacted",
			)
			.replace(/[\\`*_{}[\]<>#|!]/g, " ")
			.slice(0, 300)
	);
}
function safeLink(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			value.length > 1024 ||
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
			(event.source === "azure-monitor" || event.source === "new-relic") &&
			(!event.provenance ||
				!event.service ||
				!event.signature ||
				!Number.isSafeInteger(event.count) ||
				(event.count ?? 0) < 1)
		)
			continue;
		const key = JSON.stringify([
			event.source,
			event.source === "wiz"
				? "findings"
				: event.source === "jira"
					? "issues"
					: event.scope,
			event.id,
			event.eventId,
		]);
		const prior = unique.get(key);
		// Enrichment may add authoritative attribution/urgency to an earlier search
		// event. Keep that evidence without turning two reads into two activities.
		if (
			!prior ||
			(event.verifiedRenovate && !prior.verifiedRenovate) ||
			(event.urgency && !prior.urgency) ||
			(!prior.url && event.url)
		)
			unique.set(key, event);
	}
	return [...unique.values()].sort(
		(a, b) => a.at - b.at || a.id.localeCompare(b.id),
	);
}
const requiredDigestSources = [
	"jira",
	"wiz",
	"gitlab",
	"azure-monitor",
	"new-relic",
] as const;
export function digestCoverageVerdict(coverage: readonly DigestCoverage[]) {
	const missingSources = requiredDigestSources.filter(
		(source) => !coverage.some((entry) => entry.source === source),
	);
	const incompleteScopes = coverage
		.filter(
			(entry) =>
				entry.status !== "success" ||
				entry.truncated ||
				entry.missingFields.length ||
				entry.diagnostics.length,
		)
		.map((entry) => ({ source: entry.source, scope: entry.scope }));
	return {
		status:
			!missingSources.length && !incompleteScopes.length
				? ("complete" as const)
				: ("incomplete" as const),
		missingSources,
		incompleteScopeCount: incompleteScopes.length,
		incompleteScopes: incompleteScopes.slice(0, 100).map((entry) => ({
			source: safeText(entry.source),
			scope: safeText(entry.scope),
		})),
	};
}
export interface DigestReportInput {
	occurrenceId: string;
	nominalDue: number;
	executedAt: number;
	events: readonly DigestEvidence[];
	coverage: readonly DigestCoverage[];
}
export function renderDailyDigest(input: DigestReportInput): string {
	return renderDailyDigestReport(input).text;
}
export function renderDailyDigestReport(input: DigestReportInput) {
	const window = dailyDigestWindow(input.nominalDue);
	const collectedEvents = digestEvents(input.events, window);
	const events = collectedEvents.slice(0, 2000);
	const sourceCoverage = input.coverage.map((entry) => ({
		...entry,
		status:
			entry.status === "success" &&
			(entry.truncated ||
				entry.missingFields.length > 0 ||
				entry.diagnostics.length > 0)
				? ("partial" as const)
				: entry.status,
	}));
	if (collectedEvents.length > events.length)
		sourceCoverage.push({
			source: "report",
			scope: "evidence",
			status: "partial",
			pages: 0,
			items: collectedEvents.length,
			truncated: true,
			missingFields: [],
			diagnostics: ["final-evidence-event-cap"],
		});
	if (events.some((event) => !safeLink(event.url)))
		sourceCoverage.push({
			source: "report",
			scope: "evidence-links",
			status: "partial",
			pages: 0,
			items: events.filter((event) => !safeLink(event.url)).length,
			truncated: false,
			missingFields: ["sanitized-or-unavailable-source-links"],
			diagnostics: [],
		});
	for (const source of requiredDigestSources)
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
	lines.push("\n## Analysis and prioritized next actions");
	const priorities = events.filter(
		(event) => classifyDigestEvidence(event).importance === "Important",
	);
	lines.push(
		`${events.length} timestamp-evidenced event(s); ${priorities.length} important. Delivery to this session does not certify report coverage. No causal relationship or customer impact is inferred across sources.`,
	);
	lines.push(
		`Observed workload: ${events.filter((event) => event.source === "jira" && ["status", "assignee", "priority", "resolution", "sprint", "due-date"].includes(event.kind)).length} verified Jira movements; ${events.filter((event) => event.source === "wiz").length} new Wiz findings; ${events.filter((event) => event.source === "gitlab" && event.kind !== "updated-unverified").length} evidenced MR activities. Production signature groups remain separate: Azure ${events.filter((event) => event.source === "azure-monitor").length}, New Relic ${events.filter((event) => event.source === "new-relic").length}; counts are not added across platforms.`,
	);
	const nextActions = new Map<string, DigestEvidence>();
	for (const event of [
		...priorities,
		...events.filter(
			(event) => classifyDigestEvidence(event).importance === "Relevant",
		),
	]) {
		const key = JSON.stringify([
			event.source,
			event.scope,
			event.resourceScope,
			event.service,
			event.signature,
			classifyDigestEvidence(event).action,
		]);
		if (!nextActions.has(key)) nextActions.set(key, event);
	}
	for (const event of [...nextActions.values()].slice(0, 5))
		lines.push(
			`- ${safeText(event.source)} ${safeText(event.id)}: ${classifyDigestEvidence(event).action}.`,
		);
	if (priorities.length > 5)
		lines.push(
			`${priorities.length - 5} additional important events appear below.`,
		);
	lines.push("\n## Required-source coverage");
	for (const source of requiredDigestSources) {
		const entries = sourceCoverage.filter((entry) => entry.source === source);
		const first = entries[0];
		if (!first) continue;
		const status = entries.every(
			(entry) =>
				entry.status === "success" &&
				!entry.truncated &&
				!entry.missingFields.length &&
				!entry.diagnostics.length,
		)
			? "success"
			: entries.every((entry) => entry.status === "unavailable")
				? "unavailable"
				: "partial";
		lines.push(
			`- ${source} / ${entries.length === 1 ? safeText(first.scope) : `${entries.length} declared scopes`}: ${status}${entries.some((entry) => entry.truncated) ? "; capped" : ""}.`,
		);
	}
	let detailBudget = 32000,
		coverageBudget = 14000,
		omittedEvents = collectedEvents.length - events.length,
		omittedScopes = 0,
		omittedMetadata = 0;
	const detail = (line: string) => {
		const size = new TextEncoder().encode(`${line}\n`).byteLength;
		if (size > detailBudget) return false;
		detailBudget -= size;
		lines.push(line);
		return true;
	};
	for (const importance of ["Important", "Relevant", "Minor"] as const) {
		lines.push(`\n## ${importance}`);
		const selected = events.filter(
			(event) => classifyDigestEvidence(event).importance === importance,
		);
		if (!selected.length)
			lines.push(
				"No verified items in this category from the covered results; see coverage limitations below.",
			);
		const groups = new Map<string, DigestEvidence[]>();
		for (const event of selected) {
			const key =
				event.source === "wiz" &&
				event.resourceScope &&
				event.exposure &&
				event.status
					? JSON.stringify([
							event.source,
							event.title,
							event.scope,
							event.resourceScope,
							event.status,
							event.exposure,
							event.severity,
						])
					: event.signature
						? JSON.stringify([
								event.source,
								event.service,
								event.signature,
								event.provenance,
								event.severity,
							])
						: JSON.stringify([
								event.source,
								event.scope,
								event.id,
								event.eventId,
							]);
			const group = groups.get(key) ?? [];
			group.push(event);
			groups.set(key, group);
		}
		for (const members of groups.values()) {
			const event = members[0];
			if (!event) continue;
			if (members.length > 1)
				detail(
					`Grouped ${members.length} related findings; up to 10 member identities and links below. One recommendation applies to this group.`,
				);
			const { reason, action } = classifyDigestEvidence(event);
			const url = safeLink(event.url);
			if (
				!detail(
					`- ${safeText(event.id)} — ${safeText(event.title)} (${safeText(event.source)} / ${safeText(event.scope)}, ${event.kind}, ${new Date(event.at).toISOString()}${event.severity ? `, severity ${event.severity}` : ""}${event.status ? `, observed status ${safeText(event.status)}` : ""}${event.exposure ? `, exposure ${safeText(event.exposure)}` : ""}${event.resourceScope ? `, resource scope ${safeText(event.resourceScope)}` : ""}): ${reason}. ${action}.${url ? ` [Source](${url})` : " Source link unavailable or sanitized."}`,
				)
			) {
				omittedEvents += members.length;
				continue;
			}
			if (
				event.count !== undefined &&
				!detail(
					`  Production service ${safeText(event.service ?? "unknown")}; ${event.countExact ? "exact" : "at least"} ${event.count} error(s); provenance ${safeText(event.provenance ?? "unavailable")}; last observed ${new Date(event.lastAt ?? event.at).toISOString()}.`,
				)
			)
				omittedMetadata++;
			omittedEvents += Math.max(0, members.length - 10);
			for (const member of members.slice(1, 10)) {
				const link = safeLink(member.url);
				if (
					!detail(
						`  - ${safeText(member.id)}${link ? ` [Source](${link})` : " — source link unavailable"}`,
					)
				)
					omittedEvents++;
			}
		}
	}
	lines.push("\n## Source coverage");
	if (!input.coverage.length)
		lines.push(
			"Unavailable: no source coverage was supplied. This is not an empty-result claim.",
		);
	for (const coverage of sourceCoverage) {
		const line = `- ${safeText(coverage.source)} / ${safeText(coverage.scope)}: ${coverage.status}; ${coverage.pages} page(s), ${coverage.items} item(s)${coverage.attempts !== undefined ? `; ${coverage.attempts} actual dispatch attempt(s), ${coverage.failures ?? 0} failed` : ""}; truncated: ${coverage.truncated}; missing fields: ${coverage.missingFields.slice(0, 5).map(safeText).join(", ") || "none reported"}; diagnostics: ${coverage.diagnostics.slice(0, 5).map(safeText).join(", ") || "none"}.`;
		const size = new TextEncoder().encode(`${line}\n`).byteLength;
		if (
			size > coverageBudget ||
			coverage.missingFields.length > 5 ||
			coverage.diagnostics.length > 5
		)
			omittedScopes++;
		if (size <= coverageBudget) {
			coverageBudget -= size;
			lines.push(line);
		}
	}
	if (omittedEvents || omittedScopes || omittedMetadata) {
		sourceCoverage.push({
			source: "report",
			scope: "presentation",
			status: "partial",
			pages: 0,
			items: omittedEvents,
			truncated: true,
			missingFields: [],
			diagnostics: ["report-presentation-cap"],
		});
		lines.push(
			`Report presentation capped: ${omittedEvents} event/member identities omitted; ${omittedScopes} scoped coverage entries omitted or abbreviated; ${omittedMetadata} production metadata rows omitted. Limits: 2,000 final events, 10 members/group, 32,000 item-detail bytes and 14,000 coverage-detail bytes. Review providers for omitted evidence; this is not complete coverage.`,
		);
	}
	const verdict = digestCoverageVerdict(sourceCoverage);
	if (verdict.status === "incomplete")
		lines[6] = "Coverage: partial or unavailable; see declared scopes below";
	return { text: lines.join("\n"), coverage: verdict };
}
export interface DigestPage<T> {
	readonly items: readonly T[];
	readonly next?: string;
	readonly truncated?: boolean;
	readonly missingFields?: readonly string[];
	readonly diagnostics?: readonly string[];
}
