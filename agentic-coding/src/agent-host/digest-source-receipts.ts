import type {
	DigestCoverage,
	DigestEvidence,
} from "../scheduling/daily-digest.ts";
import { dailyDigestWindow, digestEvents } from "../scheduling/daily-digest.ts";
import { DigestCollection } from "../scheduling/digest-collection.ts";
import { decodeDigestSource } from "../scheduling/digest-source-decoding.ts";
import { digestSourceQueryPlan } from "../scheduling/digest-source-queries.ts";
import { normalizeDigestSourcePage } from "../scheduling/digest-sources.ts";
export interface DigestOccurrence {
	readonly occurrenceId: string;
	readonly nominalDue: number;
	readonly settingsRevision?: string;
}
interface State extends DigestOccurrence {
	ledger: DigestCollection;
	events: DigestEvidence[];
	reads: number;
	metrics: Map<string, { attempts: number; failures: number }>;
	failureRecorded: WeakSet<object>;
	failed: DigestCoverage[];
	candidates: Set<string>;
	details: Set<string>;
	history: Set<string>;
	comments: Set<string>;
	contexts: Map<string, { id: string; title: string; url: string }>;
	pending: Map<DigestReadReceipt, { result: unknown; bytes: number }>;
	pendingBytes: number;
	expectedProjects: Set<string>;
	discovery?: DigestCoverage;
}
export interface DigestReadReceipt {
	readonly conversationId: string;
	readonly state: State;
	readonly source: "jira" | "wiz" | "gitlab";
	readonly scope: string;
	readonly evidenceScope?: string;
	readonly cursor?: string;
	readonly detailId?: string;
	readonly commentId?: string;
	readonly mrContextKey?: string;
	readonly mrDetail?: boolean;
	readonly mrComments?: boolean;
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function canonical(name: string) {
	const key = name.replaceAll("-", "_");
	return key.startsWith("mcp__tools_") ? `pi__${key.slice(5)}` : key;
}
/** Actual executed reads, not model normalization calls, own report coverage. */
export class DigestSourceReceipts {
	private readonly states = new Map<string, State>();
	private state(conversationId: string, occurrence: DigestOccurrence): State {
		let state = this.states.get(conversationId);
		if (
			!state ||
			state.occurrenceId !== occurrence.occurrenceId ||
			state.nominalDue !== occurrence.nominalDue ||
			state.settingsRevision !== occurrence.settingsRevision
		) {
			if (!state && this.states.size >= 32)
				throw new Error("Digest receipt context cap.");
			state = {
				...occurrence,
				ledger: new DigestCollection(),
				events: [],
				reads: 0,
				metrics: new Map(),
				failureRecorded: new WeakSet(),
				failed: [],
				candidates: new Set(),
				details: new Set(),
				history: new Set(),
				comments: new Set(),
				contexts: new Map(),
				pending: new Map(),
				pendingBytes: 0,
				expectedProjects: new Set(),
			};
			this.states.set(conversationId, state);
		}
		return state;
	}
	expectGitLab(
		conversationId: string,
		occurrence: DigestOccurrence,
		result: {
			projects: readonly { host: string; project: string }[];
			diagnostics: readonly string[];
			truncated: boolean;
		},
	) {
		const state = this.state(conversationId, occurrence);
		for (const project of result.projects)
			state.expectedProjects.add(`${project.host}/${project.project}:`);
		state.discovery = {
			source: "gitlab",
			scope: "repository-discovery",
			pages: 0,
			items: result.projects.length,
			status:
				result.diagnostics.length || result.truncated ? "partial" : "success",
			truncated: result.truncated,
			missingFields: [],
			diagnostics: result.projects.length
				? [...result.diagnostics]
				: [...result.diagnostics, "no-local-projects-no-query"],
		};
	}
	begin(
		conversationId: string,
		occurrence: DigestOccurrence,
		name: string,
		args: Record<string, unknown>,
		gitlabHost: string | undefined,
	): DigestReadReceipt | undefined {
		const key = canonical(name);
		let source: DigestReadReceipt["source"],
			scope: string,
			evidenceScope: string | undefined,
			cursor: string | undefined,
			detailId: string | undefined,
			commentId: string | undefined,
			mrContextKey: string | undefined,
			mrDetail: boolean | undefined,
			mrComments: boolean | undefined;
		if (key.includes("jira_cloud")) {
			if (key.endsWith("get_projects")) return undefined;
			source = "jira";
			scope = "all-accessible-projects";
			cursor =
				typeof args.nextPageToken === "string"
					? args.nextPageToken
					: typeof args.startAt === "number" && args.startAt > 0
						? String(args.startAt)
						: undefined;
			if (key.endsWith("get_issue") && typeof args.issueKey === "string") {
				detailId = args.issueKey;
				scope = `detail:${detailId}`;
			}
			if (key.endsWith("get_comments") && typeof args.issueKey === "string") {
				commentId = args.issueKey;
				scope = `comments:${commentId}`;
			}
		} else if (
			key === "mcp__wiz__execute" &&
			typeof args.tool_name === "string"
		) {
			source = "wiz";
			scope = args.tool_name;
			const parameters = record(args.parameters);
			cursor =
				typeof parameters?.after === "string" ? parameters.after : undefined;
		} else if (key.includes("gitlab")) {
			const project = key.includes("__index__")
				? args.project_id
				: args.project;
			if (typeof project !== "string") return undefined;
			const iid = args.mrIid ?? args.mr_iid;
			const prefix = `${gitlabHost ?? "unbound"}/${decodeURIComponent(project)}`;
			source = "gitlab";
			evidenceScope = prefix;
			scope = `${prefix}:${key.split("__").at(-1)}:${typeof iid === "number" || typeof iid === "string" ? iid : "candidates"}`;
			if (
				(typeof iid === "number" || typeof iid === "string") &&
				/^\d+$/.test(String(iid))
			)
				mrContextKey = `${prefix}:${iid}`;
			mrDetail = key.endsWith("gitlab_mr_get");
			mrComments =
				key.endsWith("gitlab_mr_list_comments") ||
				key.endsWith("gitlab_list_mr_discussions");
		} else return undefined;
		const state = this.state(conversationId, occurrence);
		if (++state.reads > 1000 || !state.ledger.canNormalize(source, scope)) {
			this.fail(
				{ conversationId, state, source, scope },
				"actual-source-read-cap",
			);
			throw new Error(
				"Cumulative digest source read cap; report incomplete coverage.",
			);
		}
		const metricKey = JSON.stringify([source, scope]),
			metric = state.metrics.get(metricKey) ?? { attempts: 0, failures: 0 };
		metric.attempts++;
		state.metrics.set(metricKey, metric);
		const receipt = {
			conversationId,
			state,
			source,
			scope,
			...(evidenceScope ? { evidenceScope } : {}),
			...(cursor ? { cursor } : {}),
			...(detailId ? { detailId } : {}),
			...(commentId ? { commentId } : {}),
			...(mrContextKey ? { mrContextKey, mrDetail, mrComments } : {}),
		};
		const plan = digestSourceQueryPlan(occurrence.nominalDue);
		if (
			source === "jira" &&
			key.includes("search") &&
			args.jql !== plan.jira.jql
		)
			this.fail(receipt, "jira-accessible-project-query-scope-unverified");
		if (source === "wiz") {
			const expected = plan.wiz[scope as keyof typeof plan.wiz];
			const params = record(args.parameters) ?? {};
			const size = params[scope === "list_issues" ? "first" : "limit"];
			if (
				expected &&
				((size !== undefined &&
					(!Number.isInteger(size) ||
						Number(size) < 1 ||
						Number(size) > (scope === "list_issues" ? 20 : 100))) ||
					Object.entries(expected).some(
						([field, value]) =>
							field !== "first" && field !== "limit" && params[field] !== value,
					) ||
					Object.keys(params).some(
						(field) => ![...Object.keys(expected), "after"].includes(field),
					))
			)
				this.fail(receipt, "wiz-nominal-window-or-domain-scope-unverified");
		}
		if (
			source === "gitlab" &&
			key.includes("search") &&
			(args.state !== "all" ||
				(args.query !== undefined && args.query !== "") ||
				(args.source_branch !== undefined && args.source_branch !== ""))
		)
			this.fail(receipt, "gitlab-full-project-activity-query-unverified");
		return receipt;
	}
	complete(receipt: DigestReadReceipt, result: unknown) {
		const root = record(result);
		if (root?.isError === true) {
			this.fail(receipt, "actual-source-read-failed");
			return;
		}
		const value =
			root?.structuredOutput ??
			(root?.output ? { content: root.output } : result);
		const decoded = decodeDigestSource(value, receipt.source).value;
		const detail = record(decoded),
			fields = record(detail?.fields);
		if (receipt.detailId && detail?.key === receipt.detailId) {
			receipt.state.details.add(receipt.detailId);
			if (Array.isArray(record(detail.changelog)?.histories))
				receipt.state.history.add(receipt.detailId);
			const title = fields?.summary,
				url = detail.self ?? detail.url;
			if (typeof title === "string")
				receipt.state.contexts.set(receipt.detailId, {
					id: receipt.detailId,
					title: title.slice(0, 300),
					url: typeof url === "string" ? url.slice(0, 4096) : "",
				});
		}
		if (receipt.commentId) receipt.state.comments.add(receipt.commentId);
		if (
			receipt.mrDetail &&
			receipt.mrContextKey &&
			(typeof detail?.id === "string" || typeof detail?.id === "number") &&
			typeof detail.title === "string" &&
			typeof detail.web_url === "string"
		)
			receipt.state.contexts.set(receipt.mrContextKey, {
				id: String(detail.id),
				title: detail.title.slice(0, 300),
				url: detail.web_url.slice(0, 4096),
			});
		const context = receipt.commentId
			? receipt.state.contexts.get(receipt.commentId)
			: receipt.mrComments && receipt.mrContextKey
				? receipt.state.contexts.get(receipt.mrContextKey)
				: undefined;
		const contextKey =
			receipt.commentId ??
			(receipt.mrComments ? receipt.mrContextKey : undefined);
		if (contextKey && !context) {
			const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
			if (receipt.state.pendingBytes + bytes > 1_000_000) {
				this.fail(receipt, "pending-source-context-cap");
				return;
			}
			receipt.state.pending.set(receipt, { result, bytes });
			receipt.state.pendingBytes += bytes;
			return;
		}
		const page = normalizeDigestSourcePage({
			source: receipt.source,
			scope: receipt.scope,
			value,
			...(context ? { context } : {}),
			window: dailyDigestWindow(receipt.state.nominalDue),
		});
		if (receipt.source === "jira" && Array.isArray(detail?.issues))
			for (const issue of detail.issues) {
				const key = record(issue)?.key;
				if (typeof key === "string") receipt.state.candidates.add(key);
			}
		for (const candidate of page.candidates)
			receipt.state.candidates.add(candidate.id);
		receipt.state.ledger.record(
			receipt.source,
			receipt.scope,
			page,
			receipt.cursor,
		);
		const remaining = Math.max(0, 2000 - receipt.state.events.length);
		receipt.state.events.push(
			...page.items.slice(0, remaining).map((event) => ({
				...event,
				scope:
					receipt.evidenceScope ??
					(receipt.source === "jira" ? "issues" : event.scope),
			})),
		);
		if (page.items.length > remaining)
			this.fail(receipt, "actual-source-event-cap");
		for (const [pendingReceipt, pending] of receipt.state.pending) {
			const key = pendingReceipt.commentId ?? pendingReceipt.mrContextKey;
			if (!key || !receipt.state.contexts.has(key)) continue;
			receipt.state.pending.delete(pendingReceipt);
			receipt.state.pendingBytes -= pending.bytes;
			this.complete(pendingReceipt, pending.result);
		}
	}
	fail(receipt: DigestReadReceipt, diagnostic = "actual-source-read-failed") {
		if (
			[
				"actual-source-read-failed",
				"source-receipt-normalization-failed",
			].includes(diagnostic) &&
			!receipt.state.failureRecorded.has(receipt)
		) {
			const metric = receipt.state.metrics.get(
				JSON.stringify([receipt.source, receipt.scope]),
			);
			if (metric) metric.failures++;
			receipt.state.failureRecorded.add(receipt);
		}
		if (
			receipt.state.failed.some(
				(item) =>
					item.source === receipt.source &&
					item.scope === receipt.scope &&
					item.diagnostics.includes(diagnostic),
			) ||
			receipt.state.failed.length >= 1000
		)
			return;
		receipt.state.failed.push({
			source: receipt.source,
			scope: receipt.scope,
			status: "unavailable",
			pages: 0,
			items: 0,
			truncated: diagnostic.endsWith("cap"),
			missingFields: [],
			diagnostics: [diagnostic],
		});
	}
	snapshot(
		conversationId: string,
		occurrence: DigestOccurrence,
	):
		| { events: readonly DigestEvidence[]; coverage: readonly DigestCoverage[] }
		| undefined {
		const state = this.states.get(conversationId);
		if (
			!state ||
			state.nominalDue !== occurrence.nominalDue ||
			state.occurrenceId !== occurrence.occurrenceId ||
			state.settingsRevision !== occurrence.settingsRevision
		)
			return undefined;
		const unresolved = [...state.candidates].some(
			(id) => !state.details.has(id),
		);
		const unresolvedHistory = [...state.candidates].some(
			(id) => !state.history.has(id),
		);
		const gaps: DigestCoverage[] = [...state.pending.keys()].map((receipt) => ({
			source: receipt.source,
			scope: receipt.scope,
			status: "unavailable",
			pages: 0,
			items: 0,
			truncated: false,
			missingFields: ["source-context"],
			diagnostics: ["source-context-not-collected"],
		}));
		const ledgerCoverage = state.ledger.coverage();
		if (state.discovery) gaps.push(state.discovery);
		if (ledgerCoverage.some((entry) => entry.source === "wiz"))
			for (const scope of [
				"list_issues",
				"list_posture_issues",
				"list_attack_surface_findings",
			])
				if (
					!ledgerCoverage.some(
						(entry) => entry.source === "wiz" && entry.scope === scope,
					)
				)
					gaps.push({
						source: "wiz",
						scope,
						status: "unavailable",
						pages: 0,
						items: 0,
						truncated: false,
						missingFields: [],
						diagnostics: ["reviewed-wiz-domain-not-collected"],
					});
		for (const project of state.expectedProjects)
			if (
				!ledgerCoverage.some(
					(entry) =>
						entry.source === "gitlab" && entry.scope.startsWith(project),
				)
			)
				gaps.push({
					source: "gitlab",
					scope: project.slice(0, -1),
					status: "unavailable",
					pages: 0,
					items: 0,
					truncated: false,
					missingFields: [],
					diagnostics: ["authorized-project-not-queried"],
				});
		for (const id of state.candidates)
			for (const [kind, seen] of [
				["detail", state.details],
				["comments", state.comments],
			] as const)
				if (!seen.has(id))
					gaps.push({
						source: "jira",
						scope: `${kind}:${id}`,
						status: "unavailable",
						pages: 0,
						items: 0,
						truncated: false,
						missingFields: [],
						diagnostics: [`jira-candidate-${kind}-not-collected`],
					});
		const coverage = [
			...gaps,
			...state.ledger.coverage().map((entry) => {
				if (entry.source !== "jira" || unresolved) return entry;
				const diagnostics = entry.diagnostics.filter(
					(code) =>
						code !== "jira-candidate-detail-required" &&
						(unresolvedHistory ||
							code !== "jira-history-capability-unavailable"),
				);
				let missingFields = entry.missingFields.filter(
					(code) =>
						code !== "jira-candidate-detail-required" &&
						(unresolvedHistory ||
							code !== "jira-history-capability-unavailable"),
				);
				if (
					!missingFields.some(
						(code) => code !== "source-decoding-or-detail-gap",
					)
				)
					missingFields = [];
				return {
					...entry,
					diagnostics,
					missingFields,
					status:
						!diagnostics.length && !missingFields.length && !entry.truncated
							? ("success" as const)
							: entry.status,
				};
			}),
			...state.failed,
		];
		const merged = new Map<string, DigestCoverage>();
		for (const entry of coverage) {
			const key = JSON.stringify([entry.source, entry.scope]),
				prior = merged.get(key);
			merged.set(
				key,
				prior
					? {
							...entry,
							pages: prior.pages + entry.pages,
							items: prior.items + entry.items,
							status:
								prior.status === "unavailable" && entry.status === "unavailable"
									? "unavailable"
									: prior.status === "success" && entry.status === "success"
										? "success"
										: "partial",
							truncated: prior.truncated || entry.truncated,
							missingFields: [
								...new Set([...prior.missingFields, ...entry.missingFields]),
							],
							diagnostics: [
								...new Set([...prior.diagnostics, ...entry.diagnostics]),
							],
						}
					: entry,
			);
		}
		return {
			events: digestEvents(
				state.events,
				dailyDigestWindow(occurrence.nominalDue),
			),
			coverage: [...merged.values()].map((entry) => ({
				...entry,
				...(state.metrics.get(JSON.stringify([entry.source, entry.scope])) ?? {
					attempts: 0,
					failures: 0,
				}),
			})),
		};
	}
}
