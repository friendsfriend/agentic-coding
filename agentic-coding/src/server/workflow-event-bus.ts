// Server-owned workflow event bus (add-orchestrator-event-subscriptions,
// tasks 2.1-2.5). The server turns its existing `workflow.updated` stream into
// catalog events: debounced per workflow → one view read → a pure projection
// diff → the bounded event log, the delivery frame on the broker, and the
// durable, session-owned subscription registry. An event that names only a
// repository (the hub's progress listener carries no workflow id) coalesces
// into one re-list of that repository instead, so a change nothing else
// signalled is still reported.
//
// Nothing here is a second source of truth: the workflow view of the one
// workflow an event names (or the listing of the one repository it names) is
// the only input, and an unreadable view keeps its previous projection instead
// of inventing an event.
import fs from "node:fs";
import path from "node:path";
import type { EventEnvelope } from "../contracts/environment.ts";
import type { WorkflowView } from "../contracts/workflow.ts";
import {
	boundedSummary,
	DEFAULT_SUBSCRIPTION_TTL_MS,
	EVENT_LOG_CAPACITY,
	isWorkflowEventId,
	MAX_EVENT_PAGE,
	MAX_EVENT_SUBSCRIPTIONS,
	MAX_FILTER_CATEGORIES,
	MAX_FILTER_EVENT_IDS,
	MAX_FILTER_REPOSITORIES,
	MAX_FILTER_WORKFLOW_IDS,
	MAX_SUBSCRIPTION_LABEL_CHARS,
	MAX_SUBSCRIPTION_REASON_CHARS,
	MAX_SUBSCRIPTION_TTL_MS,
	WORKFLOW_EVENT_CATEGORIES,
	type WorkflowEventDeliveryFrame,
	type WorkflowEventReadResult,
	type WorkflowEventRecord,
	type WorkflowEventSubscribeRequest,
	type WorkflowEventSubscription,
	type WorkflowEventSubscriptionFilter,
} from "../contracts/workflow-events.ts";
import {
	currentSessionName,
	orchestratorRuntimeDir,
	workflowEventSubscriptionsFile,
} from "../orchestrator-state.ts";
import type { OrchestratorMonitorMode } from "../workflow/profiles.ts";
import type { EventBroker } from "./events.ts";
import {
	clearWorkflowEventSources,
	forgetWorkflowEventSources,
	setWorkflowEventSourcesCacheLimit,
} from "./workflow-event-sources.ts";
import {
	applyEnrichment,
	defaultSubscription,
	deriveWorkflowEvents,
	matchesSubscriptionFilter,
	orderDrafts,
	projectWorkflowEvents,
	recordFromDraft,
	type WorkflowEventDraft,
	type WorkflowEventEnrichment,
	type WorkflowEventProjection,
} from "./workflow-events.ts";

/** The bus never tracks more repositories than this: the projections of a
 * machine's whole workflow history would otherwise grow without bound. One
 * repository's eviction drops every key it owns. */
const MAX_TRACKED_REPOS = 64;
/** How many closed/completed workflow ids the durable store remembers so an
 * `untilWorkflowClosed` condition survives a restart. */
const MAX_CLOSED_WORKFLOWS = 200;
/** How many worktrees of one repository the source caches are released for. */
const MAX_WORKTREES_PER_REPO = 64;
/** How many repositories may hold a pending coalesced refresh: one stream can
 * name more repositories than the bus tracks, and every pending timer is
 * memory this process holds. */
const MAX_PENDING_REPO_REFRESHES = 64;
/** How often buffered delivery charges reach the store: a delivered event must
 * not rewrite the subscription file synchronously. */
const CHARGE_FLUSH_MS = 5_000;
/** How often the bus reconciles when no configuration names an interval
 * (`[agents.orchestrator] reconcile_seconds`, default 30). */
const DEFAULT_RECONCILE_MS = 30_000;

export class MonitorOffError extends Error {
	constructor() {
		super(
			"the workflow monitor is off; set [agents.orchestrator] monitor to `wake` or `notify` to subscribe to workflow events",
		);
	}
}

export class SubscriptionLimitError extends Error {
	constructor() {
		super(
			`subscription limit reached: at most ${MAX_EVENT_SUBSCRIPTIONS} subscriptions may exist`,
		);
	}
}

export class UnknownWorkflowError extends Error {
	constructor(readonly workflowId: string) {
		super(`unknown workflow id: ${workflowId}`);
	}
}

/** The store exists but this build cannot read it: a version it does not know,
 * or a document it cannot parse. Writing would destroy whatever it holds, so
 * every mutation is refused instead. */
export class StoreUnreadableError extends Error {
	constructor(readonly reason: string) {
		super(
			`the workflow event subscription store cannot be read (${reason}); its content is left untouched`,
		);
	}
}

/** The session file exists but cannot be read: a record written now would be
 * stamped with a guessed name and never be live, so the mutation is refused. */
export class UnknownSessionError extends Error {}

export interface WorkflowEventReadQuery {
	readonly after?: number;
	readonly limit?: number;
	readonly filter?: WorkflowEventSubscriptionFilter;
}

export interface WorkflowEventBus {
	/** The recorded events since a cursor, with the page and filter bounds. */
	readEvents(query?: WorkflowEventReadQuery): WorkflowEventReadResult;
	/** Every subscription that is live for the active session, the implicit
	 * default included (it is what delivers when no explicit one exists). */
	listSubscriptions(): readonly WorkflowEventSubscription[];
	subscribe(request: WorkflowEventSubscribeRequest): WorkflowEventSubscription;
	unsubscribe(subscriptionId: string): boolean;
	/** Record the one event not derived from a projection: the orchestrator
	 * launch ceiling refusing a start. */
	recordLimitHit(input: {
		limit: string;
		current: number;
		maximum: number;
	}): void;
	/** Observe one workflow as if its `workflow.updated` had arrived. */
	noteWorkflowUpdated(repository: string, workflowId: string): void;
	/** Observe one repository's listing: the first is its baseline (no
	 * `workflow.started`), a later one reports each id it did not hold before. */
	noteRepositoryListed(repository: string): void;
	stop(): void;
}

export interface WorkflowEventBusOptions {
	readonly events: EventBroker;
	readonly view: (repository: string, workflowId: string) => WorkflowView;
	readonly listViews: (repository: string) => readonly WorkflowView[];
	/** The master switch. Read on every use so an edit applies without a restart
	 * (the composition root memoizes the configuration read behind it). */
	readonly monitorMode: () => OrchestratorMonitorMode;
	readonly stallMinutes?: () => number;
	readonly now?: () => number;
	readonly runtimeDir?: string;
	readonly debounceMs?: number;
	readonly stallTickMs?: number;
	/** How often a tracked repository with a live workflow is re-listed without
	 * any event: the safety net for a writer this process never hears from (a
	 * handoff in another process, the CLI, a second TUI). Read per pass like
	 * `stallMinutes`, so an edit applies without a restart; the configured
	 * `[agents.orchestrator] reconcile_seconds` (default 30 s), and `0` disables
	 * the pass. */
	readonly reconcileMs?: () => number;
	/** The bounded extra reads a few events need. A missing source yields
	 * nothing, so the derivation emits no event instead of failing. */
	readonly enrich?: (input: {
		repository: string;
		workflowId: string;
		view: WorkflowView;
		previous: WorkflowEventProjection;
		next: WorkflowEventProjection;
	}) => WorkflowEventEnrichment | undefined;
	readonly logCapacity?: number;
	/** How often buffered delivery charges reach the store; tests shorten it. */
	readonly chargeFlushMs?: number;
	/** How many artifact reads the source caches keep (telemetry/tasks.md), so a
	 * host that observes more workflows than this can raise it. */
	readonly sourceCacheEntries?: number;
	/** Diagnostics sink; a derivation failure is reported and dropped. */
	readonly onError?: (error: unknown) => void;
}

interface StoreFile {
	readonly version: number;
	readonly subscriptions: readonly WorkflowEventSubscription[];
	/** Workflow ids observed `closed`/`completed`, so an `untilWorkflowClosed`
	 * condition still resolves after a restart. */
	readonly closed?: readonly string[];
}

/** What a fresh read of the store found. `missing` is safe to create;
 * `unreadable` and `unknown-version` must never be overwritten. */
type StoreRead =
	| {
			readonly status: "ok";
			readonly subscriptions: WorkflowEventSubscription[];
			readonly closed: readonly string[];
	  }
	| {
			readonly status: "missing";
			readonly subscriptions: WorkflowEventSubscription[];
			readonly closed: readonly string[];
	  }
	| { readonly status: "unreadable"; readonly detail: string }
	| { readonly status: "unknown-version"; readonly detail: string };

/** A store larger than this is not read at all: the file is small by
 * construction (at most 20 subscriptions), so a huge one is not this build's. */
const MAX_SUBSCRIPTION_STORE_BYTES = 1 << 20;
/** Bound on the version value echoed in a refusal, so an arbitrary JSON value
 * cannot travel into a diagnostic or a 409 body. */
const MAX_VERSION_ECHO_CHARS = 32;

const STORE_VERSION = 1;

export function createWorkflowEventBus(
	options: WorkflowEventBusOptions,
): WorkflowEventBus {
	const now = options.now ?? (() => Date.now());
	const runtimeDir = options.runtimeDir ?? orchestratorRuntimeDir();
	const debounceMs = options.debounceMs ?? 250;
	const reconcileMsOf = () => options.reconcileMs?.() ?? DEFAULT_RECONCILE_MS;
	const logCapacity = options.logCapacity ?? EVENT_LOG_CAPACITY;
	const report = options.onError ?? (() => {});
	const modeOf = () => options.monitorMode();
	if (options.sourceCacheEntries !== undefined)
		setWorkflowEventSourcesCacheLimit(options.sourceCacheEntries);
	const stallMinutesOf = () => options.stallMinutes?.() ?? 30;

	/** The bounded, cursor-addressed log. The sequence never restarts, so an
	 * evicted event leaves a detectable hole rather than a silent gap. */
	const log: WorkflowEventRecord[] = [];
	let sequence = 0;

	const projections = new Map<string, WorkflowEventProjection>();
	/** When each workflow's projection last *changed* (not last read), so
	 * `run.stalled` measures stalled progress rather than a stalled reader. */
	const lastChangedAt = new Map<string, number>();
	const stalledAt = new Map<string, number>();
	const knownWorkflows = new Map<string, Set<string>>();
	/** Which repository holds which workflow id: the index a subscription filter
	 * is resolved against, so naming an id costs no repository listing. */
	const workflowIndex = new Map<string, string>();
	const baselinedRepos = new Set<string>();
	/** The worktrees each repository's observations came from, so the telemetry
	 * cache can be released per repository even when a worktree lives outside it. */
	const worktreesByRepo = new Map<string, Set<string>>();
	const trackedRepos = new Set<string>();
	const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** One pending coalesced repository refresh per repository named by a
	 * runId-less `workflow.updated` (the hub's progress listener). */
	const repoTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Workflow ids observed as `closed` or `completed`, so an until-condition is
	 * pruned without a store read. Seeded from the durable store and persisted. */
	const closedWorkflows = new Set<string>();

	const keyOf = (repository: string, workflowId: string): string =>
		`${repository}\u0000${workflowId}`;

	/** Drop every key one repository owns, so the LRU bounds the maps it
	 * actually grows (including the module-level telemetry cache). */
	function forgetRepo(repository: string): void {
		const prefix = `${repository}\u0000`;
		for (const key of [...projections.keys()])
			if (key.startsWith(prefix)) projections.delete(key);
		for (const key of [...lastChangedAt.keys()])
			if (key.startsWith(prefix)) lastChangedAt.delete(key);
		for (const key of [...stalledAt.keys()])
			if (key.startsWith(prefix)) stalledAt.delete(key);
		for (const [workflowId, repo] of [...workflowIndex.entries()])
			if (repo === repository) workflowIndex.delete(workflowId);
		for (const worktree of worktreesByRepo.get(repository) ?? [])
			forgetWorkflowEventSources(worktree);
		worktreesByRepo.delete(repository);
		knownWorkflows.delete(repository);
		baselinedRepos.delete(repository);
	}

	/** Remember one workflow's worktree, so its cached telemetry read is released
	 * with the workflow (or with the repository that owns it). Bounded per
	 * repository, oldest first. */
	function rememberWorktree(repository: string, worktree: string): void {
		if (!worktree) return;
		let worktrees = worktreesByRepo.get(repository);
		if (!worktrees) {
			worktrees = new Set();
			worktreesByRepo.set(repository, worktrees);
		}
		worktrees.delete(worktree);
		worktrees.add(worktree);
		while (worktrees.size > MAX_WORKTREES_PER_REPO) {
			const oldest = worktrees.values().next().value;
			if (oldest === undefined) break;
			worktrees.delete(oldest);
			forgetWorkflowEventSources(oldest);
		}
	}

	/** Release one departed workflow's cached sources. */
	function forgetWorktree(
		repository: string,
		worktree: string | undefined,
	): void {
		if (!worktree) return;
		worktreesByRepo.get(repository)?.delete(worktree);
		forgetWorkflowEventSources(worktree);
	}

	function trackRepo(repository: string): void {
		if (repository === "") return;
		trackedRepos.add(repository);
		while (trackedRepos.size > MAX_TRACKED_REPOS) {
			const oldest = trackedRepos.values().next().value;
			if (oldest === undefined) break;
			trackedRepos.delete(oldest);
			forgetRepo(oldest);
		}
	}

	/** Remember one closed workflow, bounded, so the condition stays resolvable
	 * after a restart. */
	function rememberClosed(workflowId: string): boolean {
		if (closedWorkflows.has(workflowId)) return false;
		closedWorkflows.add(workflowId);
		while (closedWorkflows.size > MAX_CLOSED_WORKFLOWS) {
			const oldest = closedWorkflows.values().next().value;
			if (oldest === undefined) break;
			closedWorkflows.delete(oldest);
		}
		return true;
	}

	// -----------------------------------------------------------------------
	// Subscription store
	// -----------------------------------------------------------------------

	const storeFile = workflowEventSubscriptionsFile(runtimeDir);
	let storeCache:
		| { mtimeMs: number; subscriptions: WorkflowEventSubscription[] }
		| undefined;
	/** The last refusal reported, so a persistent unreadable store is reported
	 * once per state rather than on every event. */
	let reportedRefusal: string | undefined;

	/** The active session, or undefined when the session file exists but cannot
	 * be read (a partial write): the bus then neither assumes a name nor prunes
	 * another session's records. */
	function activeSession(): string | undefined {
		return currentSessionName(runtimeDir);
	}

	function isSubscriptionShape(
		value: unknown,
	): value is WorkflowEventSubscription {
		if (!value || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		return (
			typeof record.id === "string" &&
			typeof record.label === "string" &&
			typeof record.session === "string" &&
			typeof record.expiresAt === "string" &&
			(record.mode === "wake" ||
				record.mode === "digest" ||
				record.mode === "silent") &&
			!!record.filter &&
			typeof record.filter === "object"
		);
	}

	/** The store as it is on disk right now (the cache is bypassed). */
	function readStoreFresh(): StoreRead {
		let stats: fs.Stats;
		try {
			stats = fs.statSync(storeFile);
		} catch {
			// Nothing there: a fresh store is this build's to create.
			storeCache = undefined;
			return { status: "missing", subscriptions: [], closed: [] };
		}
		if (!stats.isFile())
			return { status: "missing", subscriptions: [], closed: [] };
		if (stats.size > MAX_SUBSCRIPTION_STORE_BYTES) {
			storeCache = { mtimeMs: stats.mtimeMs, subscriptions: [] };
			return {
				status: "unreadable",
				detail: "the file is larger than this build reads",
			};
		}
		let raw: string;
		try {
			raw = fs.readFileSync(storeFile, "utf8");
		} catch (error) {
			// The file exists but cannot be read: never treated as "create one".
			storeCache = { mtimeMs: stats.mtimeMs, subscriptions: [] };
			return {
				status: "unreadable",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		let parsed: Partial<StoreFile>;
		try {
			parsed = JSON.parse(raw) as Partial<StoreFile>;
		} catch {
			storeCache = { mtimeMs: stats.mtimeMs, subscriptions: [] };
			return { status: "unreadable", detail: "the file is not valid JSON" };
		}
		// A store written by a later build must not be read as if it were this
		// version, and must not be overwritten either.
		if (parsed.version !== STORE_VERSION) {
			storeCache = { mtimeMs: stats.mtimeMs, subscriptions: [] };
			return {
				status: "unknown-version",
				detail: `version ${String(parsed.version).slice(0, MAX_VERSION_ECHO_CHARS)} (this build writes ${STORE_VERSION})`,
			};
		}
		const closed = Array.isArray(parsed.closed)
			? parsed.closed.filter((id): id is string => typeof id === "string")
			: [];
		for (const workflowId of closed) rememberClosed(workflowId);
		const subscriptions = Array.isArray(parsed.subscriptions)
			? parsed.subscriptions.filter(isSubscriptionShape)
			: [];
		storeCache = { mtimeMs: stats.mtimeMs, subscriptions };
		return { status: "ok", subscriptions, closed };
	}

	function readStore(): WorkflowEventSubscription[] {
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(storeFile).mtimeMs;
		} catch {
			storeCache = undefined;
			return [];
		}
		if (storeCache && storeCache.mtimeMs === mtimeMs)
			return storeCache.subscriptions;
		const fresh = readStoreFresh();
		return fresh.status === "ok" || fresh.status === "missing"
			? fresh.subscriptions
			: [];
	}

	function writeStore(
		subscriptions: readonly WorkflowEventSubscription[],
		closed: readonly string[],
	): void {
		fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
		const body: StoreFile = {
			version: STORE_VERSION,
			subscriptions,
			// The union of what is on disk and what this process remembers: a
			// second writer's closes are not clobbered, and the newest ids win.
			closed: [...new Set(closed)].slice(-MAX_CLOSED_WORKFLOWS),
		};
		const temporary = `${storeFile}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(body, null, 2), { mode: 0o600 });
		fs.renameSync(temporary, storeFile);
		storeCache = {
			mtimeMs: fs.statSync(storeFile).mtimeMs,
			subscriptions: [...subscriptions],
		};
	}

	/** Apply one mutation to this session's records as they are *now* and write
	 * the result, keeping every other session's records intact (dropping only the
	 * ones past their own expiry) and merging the closed list. A store this build
	 * cannot read is never written: a background writer skips and reports, an
	 * explicit one throws. */
	function updateStore(
		mutate: (
			subscriptions: readonly WorkflowEventSubscription[],
		) => WorkflowEventSubscription[],
		options: { background?: boolean } = {},
	): boolean {
		const current = readStoreFresh();
		if (
			current.status === "unreadable" ||
			current.status === "unknown-version"
		) {
			const key = `${current.status}:${current.detail}`;
			if (reportedRefusal !== key) {
				reportedRefusal = key;
				report(new StoreUnreadableError(current.detail));
			}
			if (!options.background) throw new StoreUnreadableError(current.detail);
			return false;
		}
		reportedRefusal = undefined;
		const session = activeSession();
		// A mutation only ever touches this session's records. An unknown session
		// mutates nothing and writes every record back, so a partial session file
		// can never delete another session's subscriptions.
		const mine =
			session === undefined
				? []
				: current.subscriptions.filter(
						(subscription) => subscription.session === session,
					);
		const foreign = current.subscriptions.filter(
			(subscription) =>
				(session === undefined || subscription.session !== session) &&
				Date.parse(subscription.expiresAt) > now(),
		);
		const next = pruneLive(mutate(mine));
		writeStore([...foreign, ...next], [...current.closed, ...closedWorkflows]);
		return true;
	}

	/** Drop every record whose expiry or event budget says it is over, without
	 * deciding whose session it belongs to: the caller owns that question. */
	function pruneLive(
		subscriptions: readonly WorkflowEventSubscription[],
	): WorkflowEventSubscription[] {
		const at = now();
		return subscriptions.filter((subscription) => {
			const expiresAt = Date.parse(subscription.expiresAt);
			if (Number.isFinite(expiresAt) && expiresAt <= at) return false;
			if (
				subscription.remainingEvents !== undefined &&
				subscription.remainingEvents <= 0
			)
				return false;
			if (
				subscription.untilWorkflowClosed !== undefined &&
				closedWorkflows.has(subscription.untilWorkflowClosed)
			)
				return false;
			return true;
		});
	}

	// -----------------------------------------------------------------------
	// Delivery charges
	// -----------------------------------------------------------------------

	/** Budgets and `lastDeliveredAt` are charged in memory and flushed lazily, so
	 * one delivered event does not rewrite the subscription file synchronously. */
	const pendingCharges = new Map<
		string,
		{
			readonly at: string;
			readonly decrement: number;
			readonly deliver: boolean;
		}
	>();
	/** True when a workflow closed since the last durable write, so the closed
	 * list reaches the store even for a delivery that charges nothing. */
	let closedDirty = false;

	function applyCharges(
		charges: ReadonlyMap<
			string,
			{
				readonly at: string;
				readonly decrement: number;
				readonly deliver: boolean;
			}
		>,
		subscriptions: readonly WorkflowEventSubscription[],
	): WorkflowEventSubscription[] {
		if (charges.size === 0) return [...subscriptions];
		return subscriptions.map((subscription) => {
			const charge = charges.get(subscription.id);
			if (!charge) return subscription;
			return {
				...subscription,
				...(charge.deliver ? { lastDeliveredAt: charge.at } : {}),
				...(subscription.remainingEvents !== undefined && charge.decrement > 0
					? { remainingEvents: subscription.remainingEvents - charge.decrement }
					: {}),
			};
		});
	}

	function flushCharges(): void {
		if (pendingCharges.size === 0 && !closedDirty) return;
		// The snapshot is what gets applied: the live map is cleared first so a
		// concurrent delivery cannot be double-charged by this write, and a failed
		// write restores exactly what it took.
		const snapshot = new Map(pendingCharges);
		const wasClosedDirty = closedDirty;
		pendingCharges.clear();
		closedDirty = false;
		let written = false;
		try {
			written = updateStore((current) => applyCharges(snapshot, current), {
				background: true,
			});
		} catch (error) {
			report(error);
		}
		if (!written) {
			for (const [id, charge] of snapshot) pendingCharges.set(id, charge);
			closedDirty = wasClosedDirty;
		}
	}

	const chargeTimer = setInterval(() => {
		try {
			flushCharges();
		} catch (error) {
			// Belt and braces: the timer body must never throw into the process.
			report(error);
		}
	}, options.chargeFlushMs ?? CHARGE_FLUSH_MS);
	chargeTimer.unref?.();

	/** The stored records of the active session, with the charges this process
	 * has not written yet applied, so the listing never lags behind delivery.
	 * While the active session cannot be read, no stored record is live: the
	 * records are kept on disk but belong to no session this process can name. */
	function storedSubscriptions(): WorkflowEventSubscription[] {
		const session = activeSession();
		if (session === undefined) return [];
		return pruneLive(
			applyCharges(pendingCharges, readStore()).filter(
				(subscription) => subscription.session === session,
			),
		);
	}

	/** The subscriptions that are actually live: the stored ones, or the
	 * implicit `default` when none is stored. One definition, used by delivery,
	 * by the listing and by the cap, so listing and matching can never disagree
	 * (a fresh session delivers today's events, and `list_subscriptions` says
	 * so). */
	function effectiveSubscriptions(): WorkflowEventSubscription[] {
		const stored = storedSubscriptions();
		if (stored.length > 0) return stored;
		return [
			defaultSubscription({
				session: activeSession() ?? "orchestrator",
				now: now(),
				expiresAt: new Date(now() + DEFAULT_SUBSCRIPTION_TTL_MS).toISOString(),
			}),
		];
	}

	// -----------------------------------------------------------------------
	// Recording
	// -----------------------------------------------------------------------

	function appendRecord(
		draft: WorkflowEventDraft,
		input: {
			repository: string;
			workflowId: string;
			startedBy: WorkflowEventRecord["startedBy"];
			stepId: string;
			stepLabel: string;
		},
	): WorkflowEventRecord {
		sequence += 1;
		const record = recordFromDraft(draft, {
			sequence,
			repository: input.repository,
			workflowId: input.workflowId,
			startedBy: input.startedBy,
			stepId: input.stepId,
			stepLabel: input.stepLabel,
			at: new Date(now()).toISOString(),
		});
		log.push(record);
		while (log.length > logCapacity) log.shift();
		return record;
	}

	/** Record drafts one by one, isolating each: neither a failed append nor a
	 * failed delivery may swallow the rest of the observation (the caller only
	 * advances its projection after this returns). */
	function recordDrafts(
		drafts: readonly WorkflowEventDraft[],
		input: {
			repository: string;
			workflowId: string;
			startedBy: WorkflowEventRecord["startedBy"];
			stepId: string;
			stepLabel: string;
		},
	): number {
		let recorded = 0;
		for (const draft of orderDrafts(drafts)) {
			try {
				const record = appendRecord(draft, input);
				recorded += 1;
				deliver(record);
			} catch (error) {
				report(error);
			}
		}
		return recorded;
	}

	/** Charge every matched subscription the event was recorded for. A *record*
	 * budget counts the matches whatever the mode; `lastDeliveredAt` is stamped
	 * only for the modes whose frame can become a note. */
	function charge(
		matched: readonly WorkflowEventSubscription[],
		nowIso: string,
		published: boolean,
	): void {
		for (const subscription of matched) {
			if (subscription.implicit) continue;
			const delivers =
				subscription.mode === "wake" || subscription.mode === "digest";
			if (subscription.remainingEvents === undefined && !delivers) continue;
			const existing = pendingCharges.get(subscription.id);
			pendingCharges.set(subscription.id, {
				at: nowIso,
				decrement: (existing?.decrement ?? 0) + 1,
				// The stamp follows a frame that was actually published, so a muted
				// `notify` mode never reports a delivery it suppressed.
				deliver: (existing?.deliver ?? false) || (published && delivers),
			});
		}
	}

	/** Match the live subscriptions against one recorded event and, when a
	 * consumer has to see it, publish one delivery frame. The record budget is
	 * charged either way: the event was recorded and matched. */
	function deliver(event: WorkflowEventRecord): void {
		const mode = modeOf();
		if (mode === "off") return;
		// Match the subscriptions as they are *before* this event closes any of
		// them: the completion or close of the workflow an `untilWorkflowClosed`
		// subscription waits for is the last event it must still receive. The
		// pruning itself is unchanged - the next delivery no longer names it - and
		// the filter is never widened to make that happen.
		const subscriptions = effectiveSubscriptions();
		const matched = subscriptions.filter((subscription) =>
			matchesSubscriptionFilter(subscription.filter, event),
		);
		let closedChanged = false;
		if (event.id === "workflow.closed" || event.id === "workflow.completed") {
			closedChanged = rememberClosed(event.workflowId);
			if (closedChanged) closedDirty = true;
		}
		const deliverable = matched.some(
			(subscription) =>
				subscription.mode === "wake" || subscription.mode === "digest",
		);
		// A human-needed event is published whatever the subscriptions (the
		// developer notification is independent of them); every other event only
		// when `wake` mode has something to deliver.
		const publish = event.humanNeeded || (mode === "wake" && deliverable);
		// The event is recorded now: charge the subscriptions it matched, whether
		// or not a frame follows (a `silent` subscription exists to record, and its
		// count-based cleanup must be reachable). Only a published frame stamps.
		charge(matched, new Date(now()).toISOString(), publish);
		if (!publish) {
			// Nothing is published: the charges wait for the periodic flush, and
			// only a closed-list change is written now.
			if (closedChanged) flushCharges();
			return;
		}
		const frame: WorkflowEventDeliveryFrame = {
			event,
			subscriptions: matched.map((subscription) => ({
				id: subscription.id,
				label: subscription.label,
				mode: subscription.mode,
				...(subscription.coalesceMs !== undefined
					? { coalesceMs: subscription.coalesceMs }
					: {}),
				...(subscription.minIntervalMs !== undefined
					? { minIntervalMs: subscription.minIntervalMs }
					: {}),
				...(subscription.digestMinutes !== undefined
					? { digestMinutes: subscription.digestMinutes }
					: {}),
			})),
		};
		options.events.publish({
			domain: "workflow-event",
			kind: "event",
			...(event.repository ? { resource: event.repository } : {}),
			...(event.workflowId ? { runId: event.workflowId } : {}),
			payload: frame,
		});
		if (closedChanged) flushCharges();
	}

	// -----------------------------------------------------------------------
	// Derivation
	// -----------------------------------------------------------------------

	function observeView(repository: string, view: WorkflowView): void {
		if (!view?.workflowId) return;
		const key = keyOf(repository, view.workflowId);
		const previous = projections.get(key);
		const projected = projectWorkflowEvents(view);
		let enrichment: WorkflowEventEnrichment | undefined;
		if (previous && options.enrich) {
			try {
				enrichment = options.enrich({
					repository,
					workflowId: view.workflowId,
					view,
					previous,
					next: projected,
				});
			} catch (error) {
				// A missing or unreadable enrichment source emits nothing rather
				// than failing the observation.
				report(error);
			}
		}
		const next = applyEnrichment(projected, enrichment);
		let drafts: WorkflowEventDraft[] = [];
		if (previous) {
			try {
				drafts = deriveWorkflowEvents(previous, next, {
					repository,
					workflowId: view.workflowId,
					at: new Date(now()).toISOString(),
					...(enrichment ? { enrichment } : {}),
				});
			} catch (error) {
				report(error);
			}
		}
		const recorded = recordDrafts(drafts, {
			repository,
			workflowId: view.workflowId,
			startedBy: next.startedBy,
			stepId: next.stepId,
			stepLabel: next.stepLabel,
		});
		// The projection advances only after its drafts are drained. "Changed" is
		// the diff's own answer (a draft was produced), so no fingerprint of the
		// whole projection is needed.
		projections.set(key, next);
		workflowIndex.set(view.workflowId, repository);
		rememberWorktree(repository, view.worktree);
		trackRepo(repository);
		if (!previous || recorded > 0 || enrichmentChanged(previous, enrichment)) {
			lastChangedAt.set(key, now());
			stalledAt.delete(key);
		} else if (!lastChangedAt.has(key)) {
			lastChangedAt.set(key, now());
		}
	}

	/** Read one workflow and fold it into its projection. `false` means nothing
	 * was observed (the monitor is `off`, or the view is unreadable), so a caller
	 * that needs fresh state knows it did not get any. */
	function readWorkflow(repository: string, workflowId: string): boolean {
		if (modeOf() === "off") return false;
		let view: WorkflowView;
		try {
			view = options.view(repository, workflowId);
		} catch {
			// An unreadable workflow keeps its previous projection: an event is
			// never invented from a miss.
			return false;
		}
		observeView(repository, view);
		return true;
	}

	/** True while one of this repository's tracked workflows is still capable of
	 * changing (`active` or `attention-required` in the projection): only those
	 * can produce a new event, so a repository whose work is done costs the
	 * reconciliation tick no store read. */
	function hasLiveWorkflow(repository: string): boolean {
		const prefix = `${repository}\u0000`;
		for (const [key, projection] of projections) {
			if (!key.startsWith(prefix)) continue;
			if (
				projection.status === "active" ||
				projection.status === "attention-required"
			)
				return true;
		}
		return false;
	}

	/** The repository listing: the first one is that repository's baseline and
	 * emits nothing; a later one emits exactly one `workflow.started` for each id
	 * it did not hold before. Every listed workflow the bus already holds a
	 * projection for is observed exactly as a `workflow.updated` would observe it,
	 * which is what reports a transition (a completion, a raised attention, a
	 * waiting review) that no workflow-id-carrying event ever named. */
	function noteListing(repository: string): void {
		if (modeOf() === "off") return;
		let views: readonly WorkflowView[];
		try {
			views = options.listViews(repository);
		} catch {
			return;
		}
		const baselined = baselinedRepos.has(repository);
		const previous = knownWorkflows.get(repository) ?? new Set<string>();
		const seen = new Set<string>();
		for (const view of views) {
			if (!view?.workflowId) continue;
			seen.add(view.workflowId);
			// A start is the one event a listing adds: the workflow is new to a
			// repository the bus already baselined.
			if (baselined && !previous.has(view.workflowId))
				recordStart(repository, view);
			// A listing is a baseline for an id the bus has never observed (the
			// observation records the projection and reports nothing), and a diff
			// for one it has.
			observeView(repository, view);
		}
		// An id no longer in the listing is gone from the repository: its
		// projection is dropped, whoever observed it before.
		for (const key of [...projections.keys()]) {
			const separator = key.indexOf("\u0000");
			if (key.slice(0, separator) !== repository) continue;
			const workflowId = key.slice(separator + 1);
			if (seen.has(workflowId)) continue;
			forgetWorktree(repository, projections.get(key)?.worktree);
			projections.delete(key);
			lastChangedAt.delete(key);
			stalledAt.delete(key);
			workflowIndex.delete(workflowId);
		}
		knownWorkflows.set(repository, seen);
		baselinedRepos.add(repository);
		trackRepo(repository);
	}

	function recordStart(repository: string, view: WorkflowView): void {
		const taskSummary = boundedSummary(view.task);
		recordDrafts(
			[{ id: "workflow.started", payload: taskSummary ? { taskSummary } : {} }],
			{
				repository,
				workflowId: view.workflowId,
				startedBy: view.startedBy ?? "developer",
				stepId: view.currentStep?.id ?? "",
				stepLabel: view.currentStep?.label ?? "",
			},
		);
	}

	function schedule(repository: string, workflowId: string): void {
		const key = keyOf(repository, workflowId);
		const existing = readTimers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		readTimers.set(
			key,
			setTimeout(() => {
				readTimers.delete(key);
				readWorkflow(repository, workflowId);
			}, debounceMs),
		);
	}

	/** A `workflow.updated` naming only a repository (the refresh hub's progress
	 * listener) is coalesced into one re-list of that repository per debounce
	 * window: a drain publishes one per committed effect, and listing per event
	 * would read every workflow of the repository on each of them. */
	function scheduleRepoRefresh(repository: string): void {
		if (modeOf() === "off") return;
		const existing = repoTimers.get(repository);
		if (existing !== undefined) clearTimeout(existing);
		repoTimers.delete(repository);
		repoTimers.set(
			repository,
			setTimeout(() => {
				repoTimers.delete(repository);
				noteListing(repository);
			}, debounceMs),
		);
		// The oldest pending refresh is dropped rather than letting one stream grow
		// the map without bound; the repository it named is refreshed the next time
		// something names it.
		while (repoTimers.size > MAX_PENDING_REPO_REFRESHES) {
			const oldest = repoTimers.keys().next().value;
			if (oldest === undefined || oldest === repository) break;
			const timer = repoTimers.get(oldest);
			if (timer !== undefined) clearTimeout(timer);
			repoTimers.delete(oldest);
		}
	}

	// -----------------------------------------------------------------------
	// Stream subscription, stall tick
	// -----------------------------------------------------------------------

	const streamSubscription = options.events.open(
		{},
		(event: EventEnvelope) => {
			if (event.domain !== "workflow") return;
			if (event.kind !== "workflow.updated" && event.kind !== "workflow.start")
				return;
			if (!event.resource) return;
			// No workflow id: the event is about the repository as a whole (a
			// committed effect of a drain), so the repository is re-listed once the
			// burst settles. The repo-level refresh is what reports a change no
			// workflow-id-carrying event ever named.
			if (!event.runId) {
				scheduleRepoRefresh(event.resource);
				return;
			}
			schedule(event.resource, event.runId);
		},
		() => {
			// A gap means events were missed: re-list every repository the bus has
			// seen so the baseline is authoritative again.
			for (const repository of trackedRepos) noteListing(repository);
		},
	);

	const stallTimer = setInterval(() => {
		if (modeOf() === "off") return;
		const at = now();
		const thresholdMs = stallMinutesOf() * 60_000;
		for (const key of [...projections.keys()]) {
			const projection = projections.get(key);
			if (projection?.status !== "active") continue;
			if (stalledAt.has(key)) continue;
			const changedAt = lastChangedAt.get(key) ?? at;
			if (at - changedAt < thresholdMs) continue;
			const separator = key.indexOf("\u0000");
			const repository = key.slice(0, separator);
			const workflowId = key.slice(separator + 1);
			// A stall is claimed only on a fresh read. A workflow that completed,
			// closed or blocked since the last observation must update its projection
			// instead - that transition is the news - and an unreadable workflow
			// confirms nothing at all, so neither may produce `run.stalled`.
			if (!readWorkflow(repository, workflowId)) continue;
			const fresh = projections.get(key);
			if (fresh?.status !== "active") continue;
			// Read again after the observation: a workflow whose state changed moves
			// its own progress clock, and a change is not a stall.
			const freshChangedAt = lastChangedAt.get(key) ?? at;
			if (at - freshChangedAt < thresholdMs) continue;
			stalledAt.set(key, at);
			recordDrafts(
				[
					{
						id: "run.stalled",
						payload: {
							stepId: fresh.stepId,
							stepLabel: fresh.stepLabel,
							minutes: Math.max(1, Math.floor((at - freshChangedAt) / 60_000)),
						},
					},
				],
				{
					repository,
					workflowId,
					// The workflow's own owner, not the bus's: a `mine`-scoped
					// subscription must never be woken by a developer's stalled work.
					startedBy: fresh.startedBy,
					stepId: fresh.stepId,
					stepLabel: fresh.stepLabel,
				},
			);
		}
	}, options.stallTickMs ?? 60_000);
	// A background tick must never keep the process alive on its own.
	stallTimer.unref?.();

	/** The reconciliation pass: the repositories the bus tracks that still hold
	 * an `active` or `attention-required` workflow in its projection are
	 * re-listed, so a change no event in this process signalled is still
	 * reported. A repository with nothing live costs no store read at all, and
	 * the master switch `off` stops the whole pass. */
	function reconcileRepositories(): void {
		if (modeOf() === "off") return;
		for (const repository of [...trackedRepos]) {
			if (!hasLiveWorkflow(repository)) continue;
			noteListing(repository);
		}
	}

	/** Re-arm the reconciliation timer with the interval read now, so a
	 * configuration edit applies at the next pass without a restart. */
	let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
	function armReconcile(): void {
		const interval = reconcileMsOf();
		if (!(interval > 0)) return;
		reconcileTimer = setTimeout(() => {
			try {
				reconcileRepositories();
			} catch (error) {
				// A background timer must never throw into the process.
				report(error);
			}
			armReconcile();
		}, interval);
		// A background tick must never keep the process alive on its own.
		reconcileTimer.unref?.();
	}
	armReconcile();

	// -----------------------------------------------------------------------
	// Filter validation
	// -----------------------------------------------------------------------

	/** Refuse anything beyond a bound, and name the limit. Never resolves a
	 * workflow id: a read filter needs no resolution (an unknown id simply
	 * matches nothing), and resolving one would list repositories per id. */
	function validateFilterShape(filter: WorkflowEventSubscriptionFilter): void {
		if (
			filter.scope !== undefined &&
			filter.scope !== "mine" &&
			filter.scope !== "all"
		)
			throw new Error("filter.scope must be `mine` or `all`");
		const workflowIds = filter.workflowIds ?? [];
		if (workflowIds.length > MAX_FILTER_WORKFLOW_IDS)
			throw new Error(
				`filter.workflowIds is limited to ${MAX_FILTER_WORKFLOW_IDS} ids`,
			);
		const repositories = filter.repositories ?? [];
		if (repositories.length > MAX_FILTER_REPOSITORIES)
			throw new Error(
				`filter.repositories is limited to ${MAX_FILTER_REPOSITORIES} paths`,
			);
		const eventIds = filter.eventIds ?? [];
		if (eventIds.length > MAX_FILTER_EVENT_IDS)
			throw new Error(
				`filter.eventIds is limited to ${MAX_FILTER_EVENT_IDS} ids`,
			);
		for (const id of eventIds)
			if (!isWorkflowEventId(id)) throw new Error(`unknown event id: ${id}`);
		const categories = filter.categories ?? [];
		if (categories.length > MAX_FILTER_CATEGORIES)
			throw new Error(
				`filter.categories is limited to ${MAX_FILTER_CATEGORIES} categories`,
			);
		for (const category of categories)
			if (!(WORKFLOW_EVENT_CATEGORIES as readonly string[]).includes(category))
				throw new Error(`unknown event category: ${category}`);
		if (
			filter.minSeverity &&
			!["info", "warning", "critical"].includes(filter.minSeverity)
		)
			throw new Error("filter.minSeverity must be info, warning or critical");
	}

	/** Validate a subscription filter: the shape bounds plus the workflow ids,
	 * which are resolved against the bus's own index (and one listing only when
	 * the id is unknown to it). */
	function normalizeFilter(
		filter: WorkflowEventSubscriptionFilter,
	): WorkflowEventSubscriptionFilter {
		validateFilterShape(filter);
		const repositories = filter.repositories ?? [];
		for (const workflowId of filter.workflowIds ?? [])
			resolveWorkflowId(workflowId, repositories);
		return { ...filter, scope: filter.scope ?? "mine" };
	}

	/** A subscription may only name workflows the observation surface already
	 * returns: an id no listing holds is refused. When the server has observed no
	 * repository at all there is nothing to check against, so the id is accepted
	 * (the filter caps still bound what it can name). */
	function resolveWorkflowId(
		workflowId: string,
		repositories: readonly string[],
	): void {
		const indexed = workflowIndex.get(workflowId);
		if (indexed !== undefined) {
			if (repositories.length === 0 || repositories.includes(indexed)) return;
		}
		const candidates =
			repositories.length > 0
				? repositories
				: [...knownWorkflows.keys(), ...trackedRepos];
		if (candidates.length === 0) return;
		for (const repository of candidates) {
			const known = knownWorkflows.get(repository);
			if (known?.has(workflowId)) return;
			if (known) continue;
			try {
				if (
					options
						.listViews(repository)
						.some((view) => view.workflowId === workflowId)
				)
					return;
			} catch {
				/* an unreadable repository names no workflow */
			}
		}
		throw new UnknownWorkflowError(workflowId);
	}

	function expiryFor(requested: string | undefined): string {
		const at = now();
		if (requested === undefined)
			return new Date(at + DEFAULT_SUBSCRIPTION_TTL_MS).toISOString();
		const parsed = Date.parse(requested);
		if (!Number.isFinite(parsed) || parsed <= at)
			throw new Error("expiresAt must be an ISO instant in the future");
		if (parsed - at > MAX_SUBSCRIPTION_TTL_MS)
			throw new Error("expiresAt must be within 30 days");
		return new Date(parsed).toISOString();
	}

	function positive(
		value: number | undefined,
		name: string,
	): number | undefined {
		if (value === undefined) return undefined;
		if (!Number.isFinite(value) || value <= 0)
			throw new Error(`${name} must be a positive number`);
		return value;
	}

	return {
		readEvents(query: WorkflowEventReadQuery = {}): WorkflowEventReadResult {
			const limit = Math.max(
				1,
				Math.min(query.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE),
			);
			// A read filter is only bounded, never resolved: an id that names no
			// observed workflow simply matches no event.
			if (query.filter) validateFilterShape(query.filter);
			const filter = query.filter
				? { ...query.filter, scope: query.filter.scope ?? "mine" }
				: undefined;
			const oldest = log[0]?.sequence ?? sequence + 1;
			const after = query.after;
			if (after !== undefined) {
				if (!Number.isInteger(after) || after < 0)
					throw new Error("cursor must be a non-negative integer");
				if (after < oldest - 1)
					return {
						events: [],
						nextCursor: after,
						oldestSequence: oldest,
						cursorExpired: true,
					};
			}
			const matching = log.filter(
				(event) =>
					(after === undefined || event.sequence > after) &&
					(!filter || matchesSubscriptionFilter(filter, event)),
			);
			const page = matching.slice(0, limit);
			return {
				events: page,
				nextCursor: page.at(-1)?.sequence ?? after ?? Math.max(0, oldest - 1),
				oldestSequence: oldest,
			};
		},

		listSubscriptions(): readonly WorkflowEventSubscription[] {
			return effectiveSubscriptions();
		},

		subscribe(
			request: WorkflowEventSubscribeRequest,
		): WorkflowEventSubscription {
			if (modeOf() === "off") throw new MonitorOffError();
			const label = request.label.trim();
			if (label === "")
				throw new Error("a subscription needs a non-empty label");
			if (label.length > MAX_SUBSCRIPTION_LABEL_CHARS)
				throw new Error(
					`a label is limited to ${MAX_SUBSCRIPTION_LABEL_CHARS} characters`,
				);
			const reason = (request.reason ?? "").trim();
			if (reason.length > MAX_SUBSCRIPTION_REASON_CHARS)
				throw new Error(
					`a reason is limited to ${MAX_SUBSCRIPTION_REASON_CHARS} characters`,
				);
			const session = activeSession();
			if (session === undefined)
				throw new UnknownSessionError(
					"the active orchestrator session cannot be read (a partial or malformed session file); retry once it is readable",
				);
			const filter = normalizeFilter(request.filter);
			const createdAt = new Date(now()).toISOString();
			const subscription: WorkflowEventSubscription = {
				id: subscriptionId(label, createdAt),
				label,
				reason,
				session,
				createdAt,
				expiresAt: expiryFor(request.expiresAt),
				mode: request.mode ?? "wake",
				filter,
				...(positive(request.coalesceMs, "coalesceMs") !== undefined
					? { coalesceMs: request.coalesceMs }
					: {}),
				...(positive(request.minIntervalMs, "minIntervalMs") !== undefined
					? { minIntervalMs: request.minIntervalMs }
					: {}),
				...(positive(request.digestMinutes, "digestMinutes") !== undefined
					? { digestMinutes: request.digestMinutes }
					: {}),
				...(request.untilWorkflowClosed
					? { untilWorkflowClosed: request.untilWorkflowClosed }
					: {}),
				...(request.remainingEvents !== undefined
					? {
							remainingEvents: Math.max(1, Math.floor(request.remainingEvents)),
						}
					: {}),
			};
			// The implicit default is not a stored record: the first explicit
			// subscription replaces it.
			const stored = storedSubscriptions();
			if (stored.length >= MAX_EVENT_SUBSCRIPTIONS)
				throw new SubscriptionLimitError();
			// Pending charges are written first, so the new record never resurrects
			// a budget the store has not seen yet.
			flushCharges();
			updateStore((current) => [...current, subscription]);
			return subscription;
		},

		unsubscribe(subscriptionId: string): boolean {
			// An unreadable store is refused rather than answered "already gone":
			// the record is still on disk and would come back.
			const current = readStoreFresh();
			if (
				current.status === "unreadable" ||
				current.status === "unknown-version"
			)
				throw new StoreUnreadableError(current.detail);
			const stored = pruneLive(
				applyCharges(pendingCharges, current.subscriptions),
			);
			if (!stored.some((subscription) => subscription.id === subscriptionId))
				return false;
			flushCharges();
			updateStore((current) =>
				current.filter((subscription) => subscription.id !== subscriptionId),
			);
			pendingCharges.delete(subscriptionId);
			return true;
		},

		recordLimitHit(input: {
			limit: string;
			current: number;
			maximum: number;
		}): void {
			if (modeOf() === "off") return;
			recordDrafts(
				[
					{
						id: "limit.hit",
						payload: {
							limit: input.limit,
							current: input.current,
							maximum: input.maximum,
						},
					},
				],
				{
					repository: "",
					workflowId: "",
					startedBy: "orchestrator",
					stepId: "",
					stepLabel: "",
				},
			);
		},

		noteWorkflowUpdated(repository: string, workflowId: string): void {
			schedule(repository, workflowId);
		},

		noteRepositoryListed(repository: string): void {
			noteListing(repository);
		},

		stop(): void {
			streamSubscription.unsubscribe();
			clearInterval(stallTimer);
			if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
			reconcileTimer = undefined;
			clearInterval(chargeTimer);
			for (const timer of readTimers.values()) clearTimeout(timer);
			readTimers.clear();
			for (const timer of repoTimers.values()) clearTimeout(timer);
			repoTimers.clear();
			flushCharges();
			clearWorkflowEventSources();
		},
	};
}

/** Whether an enrichment learned something the previous projection did not
 * carry, so a read that changed nothing does not count as progress. */
function enrichmentChanged(
	previous: WorkflowEventProjection,
	enrichment: WorkflowEventEnrichment | undefined,
): boolean {
	if (!enrichment) return false;
	if ((enrichment.compaction?.length ?? 0) > previous.compactionCount)
		return true;
	const openspec = enrichment.openspec;
	if (!openspec) return false;
	return (
		previous.openspec === null ||
		previous.openspec.done !== openspec.done ||
		previous.openspec.total !== openspec.total
	);
}

/** A readable, unique subscription id: the label slug, the creation instant and
 * a short random suffix, so two subscriptions created with one label inside one
 * second cannot collide (a retry is a new identity, never a second record under
 * one id). */
function subscriptionId(label: string, createdAt: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24);
	const stamp = createdAt.replace(/[^0-9]/g, "").slice(2, 14);
	return `sub-${slug || "events"}-${stamp}-${crypto.randomUUID().slice(0, 4)}`;
}
