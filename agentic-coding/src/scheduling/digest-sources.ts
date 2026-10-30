import {
	type DigestEvidence,
	type DigestPage,
	type DigestWindow,
	inDigestWindow,
} from "./daily-digest.ts";

export const DIGEST_SOURCE_NESTED_BUDGET = 4000;
export const DIGEST_SOURCE_EVENT_BUDGET = 2000;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: {};
}
function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
function identity(value: unknown): string | undefined {
	return typeof value === "number" && Number.isSafeInteger(value)
		? String(value)
		: string(value);
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function time(value: unknown): number | undefined {
	const parsed =
		typeof value === "number" ? value : Date.parse(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : undefined;
}
export interface DigestSourceContext {
	readonly id: string;
	readonly title: string;
	readonly url: string;
}
/** Explicit provider response adapters. Unsupported shapes stay visible, never become empty success.
 * Raw descriptions/comment bodies are deliberately not copied into evidence.
 * Pagination is returned to the caller, which must continue the source's advertised API.
 */
export function normalizeDigestSourcePage(input: {
	source: "jira" | "wiz" | "gitlab";
	scope: string;
	value: unknown;
	window: DigestWindow;
	context?: DigestSourceContext;
}): DigestPage<DigestEvidence> & { diagnostics: readonly string[] } {
	const events: DigestEvidence[] = [],
		missing = new Set<string>(),
		diagnostics: string[] = [];
	let root = record(input.value),
		rows: unknown[] | undefined,
		truncated = false;
	// Reviewed JSON/MCP envelopes only; never eval provider text.
	if (root.data) root = record(root.data);
	for (const key of [
		"issues",
		"findings",
		"postureIssues",
		"attackSurfaceFindings",
		"merge_requests",
		"items",
		"values",
		"histories",
		"nodes",
	]) {
		const candidate = root[key];
		if (Array.isArray(candidate)) {
			rows = candidate;
			break;
		}
		const nested = record(candidate);
		if (Array.isArray(nested.nodes)) {
			root = nested;
			rows = nested.nodes;
			break;
		}
	}
	if (Array.isArray(input.value)) rows = input.value;
	if (
		input.source === "jira" &&
		input.context &&
		root.id &&
		root.created &&
		Array.isArray(root.items)
	)
		rows = [root];
	if (!rows && (root.id || root.key)) rows = [root];
	if (!rows && input.source === "jira" && Array.isArray(root.comments))
		rows = root.comments;
	if (!rows) {
		missing.add("recognized-result-array");
		diagnostics.push("source-schema-unrecognized");
		rows = [];
	}
	if (rows.length > 1000) {
		truncated = true;
		diagnostics.push("source-page-item-cap");
	}
	let inspectedNested = 0;
	function budget(nested = false): boolean {
		const eventCap = events.length >= DIGEST_SOURCE_EVENT_BUDGET;
		if (
			eventCap ||
			(nested && inspectedNested >= DIGEST_SOURCE_NESTED_BUDGET)
		) {
			truncated = true;
			diagnostics.push(
				eventCap ? "normalized-event-cap" : "source-nested-inspection-cap",
			);
			return false;
		}
		if (nested) inspectedNested++;
		return true;
	}
	function emit(event: Omit<DigestEvidence, "source" | "scope">) {
		if (inDigestWindow(event.at, input.window) && budget())
			events.push({ ...event, source: input.source, scope: input.scope });
	}
	rowLoop: for (const raw of rows.slice(0, 1000)) {
		if (!budget()) break;
		const item = record(raw),
			fields = record(item.fields);
		const id = identity(
			input.source === "jira" ? (item.key ?? input.context?.id) : item.id,
		);
		if (!id) {
			missing.add("identity");
			continue;
		}
		const title = (
			string(fields.summary ?? item.title ?? item.name) ??
			input.context?.title ??
			id
		).slice(0, 300);
		let url =
			string(item.web_url ?? item.url ?? item.webUrl) ??
			input.context?.url ??
			"";
		if (!url && input.source === "jira" && typeof item.self === "string") {
			try {
				const self = new URL(item.self);
				if (self.protocol === "https:")
					url = `${self.origin}/browse/${encodeURIComponent(id)}`;
			} catch {
				/* Missing link remains a coverage gap. */
			}
		}
		if (!url) missing.add("source-link");
		if (input.source === "jira") {
			const priority = string(record(fields.priority).name)
				?.trim()
				.toLowerCase();
			const statusCategory = string(
				record(record(fields.status).statusCategory).key,
			);
			const urgency =
				statusCategory !== "done" &&
				(priority === "highest" || priority === "critical")
					? priority
					: undefined;
			const common = {
				id,
				title,
				url,
				urgency,
				status: string(record(fields.status).name)?.slice(0, 100),
			} satisfies Pick<
				DigestEvidence,
				"id" | "title" | "url" | "urgency" | "status"
			>;
			const created = time(
				fields.created ?? (item.key ? item.created : undefined),
			);
			if (created !== undefined)
				emit({
					...common,
					at: created,
					kind: "created",
					eventId: `${id}:created`,
				});
			else if (item.key) missing.add("created");
			const histories =
				input.context && Array.isArray(item.items) && item.created
					? [item]
					: array(record(item.changelog).histories ?? item.histories);
			if (item.fields && fields.priority === undefined) missing.add("priority");
			if (item.fields && !item.changelog)
				missing.add("changelog-not-in-response");
			const historyTotal = record(item.changelog).total;
			if (typeof historyTotal === "number" && historyTotal > histories.length)
				missing.add("changelog-pages-remaining");
			for (const rawHistory of histories) {
				if (!budget(true)) break rowLoop;
				const history = record(rawHistory),
					at = time(history.created),
					historyId = identity(history.id);
				if (at === undefined || !historyId) {
					missing.add("changelog-event-time-or-id");
					continue;
				}
				for (const [index, rawChange] of array(history.items).entries()) {
					if (!budget(true)) break rowLoop;
					const change = record(rawChange);
					const name = string(change.field)?.toLowerCase();
					const kind = name === "duedate" ? "due-date" : name;
					if (
						kind !== "status" &&
						kind !== "assignee" &&
						kind !== "priority" &&
						kind !== "resolution" &&
						kind !== "sprint" &&
						kind !== "due-date"
					)
						continue;
					const from = string(change.fromString)?.slice(0, 40),
						to = string(change.toString)?.slice(0, 40),
						priorityTo = to?.trim().toLowerCase();
					emit({
						...common,
						title: `${title.slice(0, 160)} — ${kind} changed${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`,
						blockingMovement:
							statusCategory !== "done" &&
							kind === "status" &&
							priorityTo === "blocked"
								? true
								: undefined,
						urgency:
							urgency ??
							(statusCategory !== "done" &&
							kind === "priority" &&
							(priorityTo === "highest" || priorityTo === "critical")
								? priorityTo
								: undefined),
						at,
						kind,
						eventId: `${historyId}:${index}`,
					});
				}
			}
			const comments = Array.isArray(item.comments)
				? item.comments
				: array(record(fields.comment).comments);
			const commentTotal = record(fields.comment).total;
			if (typeof commentTotal === "number" && commentTotal > comments.length)
				missing.add("comment-pages-remaining");
			for (const rawComment of comments) {
				if (!budget(true)) break rowLoop;
				const comment = record(rawComment),
					at = time(comment.created),
					commentId = identity(comment.id);
				if (at === undefined || !commentId) {
					missing.add("comment-event-time-or-id");
					continue;
				}
				emit({
					...common,
					title: `${title} — comment added`,
					at,
					kind: "comment",
					eventId: `comment:${commentId}`,
				});
			}
			if (
				!item.key &&
				input.context &&
				item.id &&
				item.created &&
				!Array.isArray(item.items)
			) {
				const at = time(item.created);
				if (at !== undefined)
					emit({
						...common,
						title: `${title} — comment added`,
						at,
						kind: "comment",
						eventId: `comment:${String(item.id)}`,
					});
			}
			// An updated timestamp cannot establish any particular transition.
			const updated = time(fields.updated ?? item.updated);
			if (updated !== undefined && !histories.length && !comments.length)
				emit({
					...common,
					at: updated,
					kind: "updated-unverified",
					eventId: `${id}:updated:${updated}`,
				});
			continue;
		}
		const created = time(
			item.firstSeenAt ??
				item.first_seen_at ??
				item.firstSeen ??
				item.createdAt ??
				item.created_at,
		);
		if (created === undefined) {
			missing.add("created-or-first-seen");
			continue;
		}
		if (input.source === "wiz") {
			const candidate = string(item.severity)?.toLowerCase();
			const severity =
				candidate === "critical" ||
				candidate === "high" ||
				candidate === "medium" ||
				candidate === "low" ||
				candidate === "informational"
					? candidate
					: undefined;
			if (!severity) missing.add("severity");
			emit({
				id,
				title,
				url,
				at: created,
				eventId: `${id}:created`,
				kind: "created",
				severity,
				status: string(item.status)?.slice(0, 100),
				exposure: string(item.exposure)?.slice(0, 100),
			});
			continue;
		}
		const author = record(item.author),
			username = string(author.username)?.toLowerCase();
		// Both authenticated bot metadata AND the specific Renovate identity are required.
		if (
			author.bot !== true ||
			(username !== "renovate" && username !== "renovate[bot]")
		) {
			diagnostics.push("renovate-author-not-verified-excluded");
			if (!username || username.startsWith("renovate"))
				missing.add("authenticated-renovate-bot-identity");
			continue;
		}
		const labels = array(item.labels).filter(
			(label): label is string => typeof label === "string",
		);
		const updateType = (["major", "minor", "patch"] as const).find(
			(type) =>
				labels.includes(`renovate:${type}`) ||
				labels.includes(`renovate/${type}`),
		);
		if (!updateType) missing.add("dependency-update-type");
		const securityEvidence =
			labels.includes("security") &&
			/https:\/\/(?:github\.com\/advisories\/GHSA-[a-z0-9-]+|www\.cve\.org\/CVERecord\?id=CVE-\d{4}-\d+)/i.test(
				string(item.description) ?? "",
			);
		emit({
			id,
			title,
			url,
			at: created,
			eventId: `${id}:created`,
			kind: "created",
			verifiedRenovate: true,
			status: string(item.state)?.slice(0, 100),
			updateType,
			securityEvidence,
		});
	}
	const pageInfo = record(root.pageInfo);
	let next = string(root.nextPageToken ?? root.next ?? pageInfo.endCursor);
	const total = typeof root.total === "number" ? root.total : undefined;
	const start = typeof root.startAt === "number" ? root.startAt : 0;
	const more =
		root.isLast === false ||
		pageInfo.hasNextPage === true ||
		(total !== undefined && start + rows.length < total);
	if (pageInfo.hasNextPage === false) next = undefined;
	if (
		!next &&
		more &&
		rows.length &&
		input.source === "jira" &&
		typeof root.startAt === "number"
	)
		next = String(start + rows.length);
	if (more && !next) {
		truncated = true;
		diagnostics.push("pagination-continuation-unavailable");
	}
	return {
		items: events,
		...(next ? { next } : {}),
		truncated,
		missingFields: [...missing],
		diagnostics: [...new Set(diagnostics)],
	};
}
