// Environment app slots: each configured app runs at most once at a time.
//
// `add-environment-instances` let several copies of one app run in parallel by
// allocating ports, per-instance compose projects and image tags. That made
// every static routing, OAuth redirect and proxy definition wrong. This
// controller replaces the parallel machinery with a single slot per app:
//
//   - an app's slot is held by exactly one owner (`user` or `workflow:<id>`);
//   - occupancy comes from the persisted active row *and* run observation, so a
//     human run nobody registered still holds its app (and an unobservable
//     runtime counts as occupied, never as absent);
//   - a start for an app held by someone else waits in a per-app FIFO queue,
//     long-polled by the request, and a multi-app start is granted only when it
//     heads every one of its queues;
//   - a wait that would close a hold/wait cycle fails immediately with
//     `deadlock` naming the cycle;
//   - the developer can force-release an app; the holder reads
//     `released-by-developer` on its next call.
//
// Runs of one workflow share that workflow's slot (one workflow has one
// checkout), and a definition runs with its own static names, ports and image
// references: only `AC_OWNER` and `AC_APP_DIR` are injected.
//
// `add-environment-instance-lifecycle` adds the release half of that model: an
// app is held until its owner stops it or until it sits idle, so a forgotten
// run can never block the queue forever.
//
//   - activity (`last_activity_at`) is any operation on the app, coalesced to
//     one write per app per 30 s, and a waiting owner keeps refreshing its own
//     held rows while it long-polls;
//   - an owner's apps are released through `stopByOwner`, the operation the
//     workflow's durable `environment.teardown` effect calls on close/delete;
//   - a server-scoped reaper stops agent-held apps that have been idle longer
//     than the configured TTL, and publishes `environment.slot.reaped` for the
//     shell. `user`-held apps, unobserved (`unknown`) apps and apps whose owner
//     is waiting for another app are never reaped.
import path from "node:path";
import { discoverActionTargets } from "../actions/discovery.ts";
import type { ActionTarget } from "../actions/targets.ts";
import type { App } from "../environment/config.ts";
import {
	type EnvironmentInstance,
	type EnvironmentInstanceStatus,
	type EnvironmentOwner,
	environmentInstanceId,
	environmentInstanceStorageId,
	parseEnvironmentOwner,
} from "../environment/instances/model.ts";
import { resolveInstanceVariables } from "../environment/instances/variables.ts";
import type {
	EnvironmentInstanceRecord,
	EnvironmentStateStore,
} from "../environment/state-store.ts";
import {
	composeCommandForRuntime,
	type DockerRuntimeSelection,
} from "./docker.ts";
import {
	INSTANCE_SCRIPT_ENV_DENYLIST,
	ScriptInfrastructure,
	type ScriptStatus,
} from "./script-infrastructure.ts";

/** How long a start request long-polls before answering `waiting`. */
const DEFAULT_WAIT_SEC = 30;
/** Hard bound on one long poll; the tool layer re-polls after this. */
const MAX_WAIT_SEC = 300;
/** Queue position grace: a re-poll within this window keeps the entry. */
const QUEUE_GRACE_MS = 60 * 1000;
/** How often a waiting request refreshes its held slots' activity stamp. */
const ACTIVITY_NOTE_MS = 1000;
/**
 * Activity writes are coalesced per app: an app that is worked on is stamped
 * once per window instead of once per call, so a busy agent cannot turn every
 * operation into a state write. The window is far below any sane TTL, so a live
 * app never looks idle to the reaper.
 */
const ACTIVITY_COALESCE_MS = 30 * 1000;
/** How often the idle reaper looks for a forgotten agent-held app. */
const REAPER_INTERVAL_MS = 60 * 1000;
/** Built-in idle TTL, used when no configuration resolves one. */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
/**
 * How often a waiting request re-runs run observation. Observation may spawn a
 * process (`tmux`) or walk the config tree, so it is never re-run on the 25 ms
 * queue cadence; a holder finishing is still noticed within this interval.
 */
const OBSERVATION_REFRESH_MS = 1000;
/** How long discovered run targets are reused before the tree is re-read. */
const TARGET_CACHE_MS = 1000;
/** How often a long poll re-checks whether it heads every queue. */
const WAIT_POLL_MS = 25;
/** How long a start/stop transition may stay in flight before reconcile acts. */
const LIFECYCLE_RECONCILE_GRACE_MS = 5 * 60 * 1000;
/** Bounded number of apps one start request may name. */
const MAX_REQUESTED_APPS = 16;
const WORKFLOW_CHILD_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TMUX",
	"TMUX_PANE",
	"XDG_RUNTIME_DIR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"DEVENV_CONTAINER_RUNTIME",
	"DOCKER_CONFIG",
	"DOCKER_HOST",
	"DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH",
	"DOCKER_CONTEXT",
	"COMPOSE_FILE",
	"COMPOSE_PROFILES",
	"COMPOSE_PROJECT_NAME",
	"COMPOSE_PATH_SEPARATOR",
	"COMPOSE_CONVERT_WINDOWS_PATHS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
]);

export type EnvironmentInstanceState = Pick<
	EnvironmentStateStore,
	| "getEnvironmentInstances"
	| "getActiveEnvironmentInstances"
	| "getSupersededEnvironmentInstances"
	| "getEnvironmentInstance"
	| "findEnvironmentInstance"
	| "findActiveEnvironmentInstance"
	| "claimEnvironmentInstance"
	| "claimEnvironmentInstanceStop"
	| "compareAndSetEnvironmentInstanceStatus"
	| "transitionEnvironmentInstanceStatus"
	| "deleteEnvironmentInstanceIfStatus"
	| "updateEnvironmentInstanceStatus"
	| "deleteEnvironmentInstance"
>;

type InstanceScriptLifecycle = Pick<
	ScriptInfrastructure,
	"launch" | "status" | "stop" | "executionHandle"
> &
	Partial<Pick<ScriptInfrastructure, "observe">>;

/** What run observation says about an app's run target. */
export type RunObservationState = "running" | "stopped" | "unknown";

/** The subset of `RunObservation` occupancy reads. */
export interface RunObserver {
	runTargetInfo(appIdent: string): { runtime: string } | undefined;
	isShellTmuxRunActive(appIdent: string): Promise<boolean>;
}

/** One dashboard envelope a slot publishes. */
export interface SlotEvent {
	readonly domain: "environment";
	readonly kind:
		| "environment.slot.waiting"
		| "environment.slot.granted"
		| "environment.slot.reaped";
	readonly resource: string;
	readonly payload: Record<string, unknown>;
}

/** One app the idle reaper released. */
export interface ReapedApp {
	readonly app: string;
	readonly owner: EnvironmentOwner;
}

/** The apps one owner's teardown stopped. */
export interface OwnerTeardown {
	readonly owner: EnvironmentOwner;
	readonly apps: string[];
}

/** How the server-scoped idle reaper is started. */
export interface IdleReaperOptions {
	/** Test seam: the TTL resolved for each pass instead of the configured one. */
	readonly ttlMs?: () => number;
	/** How often a pass runs; defaults to one minute. */
	readonly intervalMs?: number;
	/** Ends the loop; the returned stop function does the same. */
	readonly signal?: AbortSignal;
}

export class EnvironmentInstanceError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(
		code: string,
		status: number,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "EnvironmentInstanceError";
		this.code = code;
		this.status = status;
	}
}

export interface EnvironmentInstanceControllerOptions {
	readonly state: EnvironmentInstanceState;
	readonly apps: () => readonly App[];
	readonly configDir: string;
	readonly docker?: DockerRuntimeSelection;
	readonly resolveDocker?: () => Promise<DockerRuntimeSelection | undefined>;
	/** Required for workflow-owned starts; paths never come directly from a request. */
	readonly resolveOwnerCheckout?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined | Promise<string | undefined>;
	/** Run-target observation for the human-holder case. */
	readonly observation?: RunObserver;
	/** Test seam: replaces the built-in run observation. */
	readonly observeRun?: (app: App) => Promise<RunObservationState>;
	/**
	 * How long an agent-held app may sit idle before the reaper stops it, in
	 * milliseconds. Resolved per reap pass, so a configuration edit applies to
	 * the next pass instead of the next server start.
	 */
	readonly idleTtlMs?: () => number;
	/** How often the idle reaper runs; defaults to one minute. */
	readonly reaperIntervalMs?: number;
	/** Test seam: replaces the wall clock. */
	readonly now?: () => Date;
	/** Test seam: replaces the long-poll sleep. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Queue position grace, in milliseconds. */
	readonly queueGraceMs?: number;
	/** How often a long poll re-checks the queues. */
	readonly waitPollMs?: number;
	/** How long one run observation is reused before it is re-run. */
	readonly observationRefreshMs?: number;
	/** Dashboard envelope fan-out for waits and grants. */
	readonly publish?: (event: SlotEvent) => void;
	readonly scriptInfra?: InstanceScriptLifecycle;
	readonly runCommand?: (
		command: string,
		args: readonly string[],
		options: { cwd: string; env: Readonly<Record<string, string>> },
	) => Promise<{ exitCode: number; output: string }>;
	readonly logger?: (message: string) => void;
}

export interface AcquireSlotsRequest {
	readonly owner: string;
	readonly apps: readonly string[];
	readonly target?: string;
	readonly profile?: string;
	/** Narrow the runtime to start (`docker`, `shell`, `systemshell`). */
	readonly runtime?: string;
	readonly waitSec?: number;
	/** Aborts the wait: the entry leaves the queue and the request answers
	 * `cancelled`, so an abandoned long poll cannot still commit a start. */
	readonly signal?: AbortSignal;
}

export interface SlotGrant {
	readonly outcome: "started" | "already-running";
	readonly owner: EnvironmentOwner;
	/** The instances the owner now holds, one per requested app. */
	readonly instances: EnvironmentInstance[];
}

export interface SlotRelease {
	readonly outcome: "released-by-developer";
	readonly owner: EnvironmentOwner;
	/** The apps the developer released (their runs were stopped). */
	readonly apps: string[];
}

export interface SlotWait {
	readonly outcome: "waiting";
	readonly owner: EnvironmentOwner;
	readonly apps: string[];
	/** 1-based queue position per requested app. */
	readonly positions: Record<string, number>;
	readonly holders: Record<string, EnvironmentOwner>;
}

/** The caller went away: the entry left the queue and nothing was started. */
export interface SlotCancelled {
	readonly outcome: "cancelled";
	readonly owner: EnvironmentOwner;
	readonly apps: string[];
}

export type AcquireSlotsResult =
	| SlotGrant
	| SlotRelease
	| SlotWait
	| SlotCancelled;

/** One app's slot as `GET /api/v1/environment/apps/slots` reports it. */
export interface AppSlot {
	readonly app: string;
	readonly holder: EnvironmentOwner | null;
	readonly status: EnvironmentInstanceStatus | "observed" | null;
	readonly waiters: EnvironmentOwner[];
}

interface QueuedRequest {
	readonly target?: string;
	readonly profile?: string;
	readonly runtime?: string;
}

interface SlotWaiter {
	readonly id: string;
	readonly owner: EnvironmentOwner;
	readonly apps: string[];
	readonly sequence: number;
	readonly request: QueuedRequest;
	enqueuedAt: number;
	lastSeenAt: number;
	lastNotedAt: number;
	activePolls: number;
	/** The `environment.slot.waiting` event is published once per entry. */
	notified: boolean;
	/**
	 * The poll loop currently driving this entry. Two requests for the same
	 * owner and apps share one entry, so exactly one loop may run: a second
	 * request joins this promise instead of racing it.
	 */
	inFlight?: Promise<AcquireSlotsResult>;
}

/** The one slot controller for every configured app. */
export class EnvironmentInstanceController {
	private readonly state: EnvironmentInstanceState;
	private readonly apps: () => readonly App[];
	private readonly configDir: string;
	private docker?: DockerRuntimeSelection;
	private readonly resolveDocker?: EnvironmentInstanceControllerOptions["resolveDocker"];
	private dockerPromise?: Promise<DockerRuntimeSelection | undefined>;
	private readonly resolveOwnerCheckout?: EnvironmentInstanceControllerOptions["resolveOwnerCheckout"];
	private readonly observation?: RunObserver;
	private readonly observeRun?: (app: App) => Promise<RunObservationState>;
	private readonly scriptInfra: InstanceScriptLifecycle;
	private readonly runCommand: NonNullable<
		EnvironmentInstanceControllerOptions["runCommand"]
	>;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly queueGraceMs: number;
	private readonly waitPollMs: number;
	private readonly observationRefreshMs: number;
	private readonly idleTtlMs: () => number;
	private readonly reaperIntervalMs: number;
	/** The last activity write per app, so touches coalesce per app. */
	private readonly activityTouches = new Map<string, number>();
	private readonly publish?: (event: SlotEvent) => void;
	private readonly logger?: (message: string) => void;
	private readonly queues = new Map<string, SlotWaiter[]>();
	/** The last observation per app, reused for `observationRefreshMs`. */
	private readonly observations = new Map<
		string,
		{ at: number; state: RunObservationState }
	>();
	/** Discovered run targets per app/checkout/overlay, reused briefly. */
	private readonly targets = new Map<
		string,
		{ at: number; targets: ActionTarget[] }
	>();
	/**
	 * Bumped by `invalidateApp`: an observation or discovery that started before
	 * the invalidation must not write its stale value back afterwards.
	 */
	private readonly cacheGeneration = new Map<string, number>();
	private sequence = 0;
	readonly ready: Promise<void>;

	constructor(options: EnvironmentInstanceControllerOptions) {
		this.state = options.state;
		this.apps = options.apps;
		this.configDir = options.configDir;
		this.docker = options.docker;
		this.resolveDocker = options.resolveDocker;
		if (options.docker) this.dockerPromise = Promise.resolve(options.docker);
		this.resolveOwnerCheckout = options.resolveOwnerCheckout;
		this.observation = options.observation;
		this.observeRun = options.observeRun;
		this.scriptInfra =
			options.scriptInfra ??
			new ScriptInfrastructure({
				runCommand: async (command, args) => {
					const result = await executeCommand(
						command,
						args,
						process.cwd(),
						environmentWith({}, "workflow:instance-runtime"),
					);
					return {
						output: result.output,
						...(result.exitCode === 0
							? {}
							: { error: new Error(`exit status ${result.exitCode}`) }),
					};
				},
			});
		this.runCommand =
			options.runCommand ??
			((command, args, options) =>
				executeCommand(command, args, options.cwd, options.env));
		this.now = options.now ?? (() => new Date());
		this.sleep =
			options.sleep ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.queueGraceMs = options.queueGraceMs ?? QUEUE_GRACE_MS;
		this.waitPollMs = options.waitPollMs ?? WAIT_POLL_MS;
		this.observationRefreshMs =
			options.observationRefreshMs ?? OBSERVATION_REFRESH_MS;
		this.idleTtlMs = options.idleTtlMs ?? (() => DEFAULT_IDLE_TTL_MS);
		this.reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS;
		this.publish = options.publish;
		this.logger = options.logger;
		this.ready = this.reconcile().catch((error: unknown) => {
			this.logger?.(
				`[slots] startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	// --- reads ---------------------------------------------------------------

	/**
	 * The app's slot from rows only when it is asked for a read, or from
	 * observation (cached) as well when it is asked to be fresh. The
	 * developer-run guard needs fresh truth; `slots()` is a read and reuses the
	 * cached observation, so one dashboard read cannot spawn a process per app.
	 */
	async occupancy(
		app: string,
	): Promise<
		{ holder: EnvironmentOwner; status: AppSlot["status"] } | undefined
	> {
		return this.occupancyOf(app, true);
	}

	/** `occupancy` for read-only callers: observation is reused for its TTL. */
	async occupancyCached(
		app: string,
	): Promise<
		{ holder: EnvironmentOwner; status: AppSlot["status"] } | undefined
	> {
		return this.occupancyOf(app, false);
	}

	private async occupancyOf(
		app: string,
		fresh: boolean,
	): Promise<
		{ holder: EnvironmentOwner; status: AppSlot["status"] } | undefined
	> {
		await this.ready;
		const record = this.state.findActiveEnvironmentInstance(app);
		if (record)
			return {
				holder: parseEnvironmentOwner(record.owner),
				status: record.status as EnvironmentInstanceStatus,
			};
		const configured = this.apps().find((candidate) => candidate.ident === app);
		if (!configured) return undefined;
		const observed = fresh
			? await this.observeAppRun(configured)
			: await this.observeAppRunCached(configured);
		if (observed === "stopped") return undefined;
		// A human run holds the app; an unobservable runtime might hold it too.
		return {
			holder: "user",
			status: observed === "running" ? "running" : "unknown",
		};
	}

	/** Every configured app's slot, for the environment views and the TUI. */
	async slots(): Promise<AppSlot[]> {
		await this.ready;
		await this.refreshScriptRows();
		const waiters = new Map<string, EnvironmentOwner[]>();
		for (const [app, queue] of this.queues)
			waiters.set(
				app,
				queue.map((waiter) => waiter.owner),
			);
		const rows = await Promise.all(
			this.apps()
				.filter((app) => app.appType !== "library" && app.appType !== "LIB")
				.map(async (app) => {
					const occupant = await this.occupancyCached(app.ident);
					return {
						app: app.ident,
						holder: occupant?.holder ?? null,
						status: occupant?.status ?? null,
						waiters: waiters.get(app.ident) ?? [],
					};
				}),
		);
		return rows;
	}

	// --- acquire -------------------------------------------------------------

	/**
	 * Acquire every named app for one owner. When all are free and the request
	 * heads every queue the apps are started and `started` (or
	 * `already-running`) is answered; otherwise the request long-polls for
	 * `waitSec` and answers `waiting` with the position and holder per app.
	 */
	async acquire(input: AcquireSlotsRequest): Promise<AcquireSlotsResult> {
		await this.ready;
		let owner: EnvironmentOwner;
		try {
			owner = parseEnvironmentOwner(input.owner);
		} catch (error) {
			throw new EnvironmentInstanceError("invalid-owner", 400, message(error), {
				cause: error,
			});
		}
		const apps = this.requestedApps(input.apps);
		const waitSec = boundWaitSec(input.waitSec);
		// A request that was already abandoned must not enqueue: a long poll nobody
		// is listening to could otherwise still commit a start.
		if (input.signal?.aborted)
			return { outcome: "cancelled", owner, apps: [...apps] };
		const startedAt = this.now().getTime();
		// A request is a fresh look at the world: the observation cached during a
		// previous wait must not decide this one.
		for (const app of apps) this.invalidateApp(app);

		const released = apps.filter(
			(app) =>
				this.state.findEnvironmentInstance(owner, app)?.status ===
				"released-by-developer",
		);
		if (released.length > 0) {
			for (const app of released) {
				const record = this.state.findEnvironmentInstance(owner, app);
				if (record)
					this.state.transitionEnvironmentInstanceStatus(
						record.id,
						"released-by-developer",
						"stopped",
						this.now().toISOString(),
					);
			}
			return { outcome: "released-by-developer", owner, apps: released };
		}

		this.expireWaiters(startedAt);
		// The request itself is activity: an app this owner already runs must not
		// look idle while the owner is still working with it.
		this.noteActivity(owner, startedAt);
		let waiter = this.findWaiter(owner, apps);
		if (!waiter) {
			// Publish the wait edge first, then check it: the in-memory queues are
			// read synchronously, so the request that enqueues last sees every
			// earlier edge and is the one that detects a cycle. Checking before
			// enqueueing would let two crossing requests both miss the cycle.
			waiter = this.enqueue(owner, apps, {
				...(input.target ? { target: input.target } : {}),
				...(input.profile ? { profile: input.profile } : {}),
				...(input.runtime ? { runtime: input.runtime } : {}),
			});
			const cycle = await this.deadlockPath(owner, apps);
			if (cycle) {
				this.dequeue(waiter);
				throw new EnvironmentInstanceError(
					"deadlock",
					409,
					`deadlock: ${cycle}`,
				);
			}
		}
		// One owner and one app set have one entry and exactly one poll loop: a
		// second concurrent request joins the loop in flight instead of racing it.
		const inFlight = waiter.inFlight;
		if (inFlight) return inFlight;
		const poll = this.poll(waiter, waitSec, input.signal);
		waiter.inFlight = poll;
		try {
			return await poll;
		} finally {
			if (waiter.inFlight === poll) waiter.inFlight = undefined;
		}
	}

	/** The long-poll loop for one queue entry. `signal` ends the wait when the
	 * caller disconnects: the entry is withdrawn, so the queue position is not
	 * held by a request nobody is waiting for. */
	private async poll(
		waiter: SlotWaiter,
		waitSec: number,
		signal?: AbortSignal,
	): Promise<AcquireSlotsResult> {
		const startedAt = this.now().getTime();
		waiter.lastSeenAt = startedAt;
		waiter.activePolls += 1;
		const deadline = startedAt + waitSec * 1000;
		try {
			for (;;) {
				if (signal?.aborted) {
					this.dequeue(waiter);
					return {
						outcome: "cancelled",
						owner: waiter.owner,
						apps: [...waiter.apps],
					};
				}
				const granted = await this.tryGrant(waiter);
				if (granted) return granted;
				if (!waiter.notified) {
					waiter.notified = true;
					await this.notifyEntry(waiter);
				}
				const now = this.now().getTime();
				// Waiting is activity: a slot the owner still needs must not look idle
				// to the lifecycle. At most one write per second per owner.
				if (now - waiter.lastNotedAt >= ACTIVITY_NOTE_MS) {
					waiter.lastNotedAt = now;
					this.noteActivity(waiter.owner, now);
				}
				if (now >= deadline) return await this.waiting(waiter);
				waiter.lastSeenAt = now;
				this.expireWaiters(now);
				await this.sleep(
					Math.max(1, Math.min(this.waitPollMs, deadline - now)),
				);
			}
		} finally {
			waiter.activePolls -= 1;
			waiter.lastSeenAt = this.now().getTime();
		}
	}

	/** The answer once the long poll elapses without a grant. */
	private async waiting(waiter: SlotWaiter): Promise<SlotWait> {
		const positions: Record<string, number> = {};
		const holders: Record<string, EnvironmentOwner> = {};
		for (const app of waiter.apps) {
			const queue = this.queues.get(app) ?? [];
			const index = queue.indexOf(waiter);
			positions[app] = index < 0 ? 1 : index + 1;
			// Only a real occupant is named: an app that is merely ahead of this
			// request in queue order is not held by the developer.
			const occupant = await this.occupantOf(app);
			if (occupant) holders[app] = occupant;
		}
		return {
			outcome: "waiting",
			owner: waiter.owner,
			apps: [...waiter.apps],
			positions,
			holders,
		};
	}

	/**
	 * Grant the entry when every app is free (or already held by this owner) and
	 * the entry heads every one of its queues. Returns `undefined` while the
	 * request must keep waiting, `SlotRelease` when the developer released one of
	 * the requested apps under this very owner, and a grant when it proceeds.
	 */
	private async tryGrant(
		waiter: SlotWaiter,
	): Promise<SlotGrant | SlotRelease | undefined> {
		// An app this owner already runs needs no queue position: the holder's own
		// re-request answers `already-running` even while another owner waits. A
		// release under this owner is consumed first, whatever the queue says.
		for (const app of waiter.apps) {
			const own = this.state.findEnvironmentInstance(waiter.owner, app);
			if (own?.status === "released-by-developer") {
				// The developer took this app away from under an in-flight wait. The
				// release must not be undone by restarting it: consume the notice and
				// answer the holder instead.
				this.state.transitionEnvironmentInstanceStatus(
					own.id,
					"released-by-developer",
					"stopped",
					this.now().toISOString(),
				);
				this.dequeue(waiter);
				return {
					outcome: "released-by-developer",
					owner: waiter.owner,
					apps: [app],
				};
			}
			if (own?.status === "running") continue;
			const queue = this.queues.get(app);
			if (!queue || queue[0] !== waiter) return undefined;
		}
		const held: EnvironmentInstanceRecord[] = [];
		const toStart: string[] = [];
		let started = false;
		for (const app of waiter.apps) {
			const own = this.state.findEnvironmentInstance(waiter.owner, app);
			if (own?.status === "running") {
				held.push(own);
				continue;
			}
			if (own?.status === "unknown")
				throw new EnvironmentInstanceError(
					"instance-unknown",
					409,
					`${waiter.owner}'s ${app} instance state is unknown; force release it before starting again`,
				);
			if (own?.status === "starting" || own?.status === "stopping")
				throw new EnvironmentInstanceError(
					"instance-busy",
					409,
					`${waiter.owner}'s ${app} instance is ${own.status}`,
				);
			const other = this.state.findActiveEnvironmentInstance(app);
			if (other) return undefined;
			if (await this.observedUnavailable(app)) return undefined;
			toStart.push(app);
		}
		for (const app of toStart) {
			held.push(await this.start(waiter.owner, app, waiter.request));
			started = true;
		}
		this.dequeue(waiter);
		for (const app of waiter.apps) {
			this.invalidateApp(app);
			this.granted(waiter.owner, app);
		}
		const instances = held.map((record) => this.toPublic(record));
		return {
			outcome: started ? "started" : "already-running",
			owner: waiter.owner,
			instances,
		};
	}

	// --- release and stop ----------------------------------------------------

	/**
	 * Developer force release: stop the holder's run through the normal stop
	 * path, leave the holder the `released-by-developer` notice, and let the
	 * queue grant the next waiter on its next poll.
	 */
	async release(app: string): Promise<EnvironmentInstance> {
		await this.ready;
		return this.stopSlot(app, "released-by-developer");
	}

	/** Stop the app's current run without the release notice. */
	async stopApp(app: string): Promise<EnvironmentInstance> {
		await this.ready;
		return this.stopSlot(app, "stopped");
	}

	/**
	 * Stop the app only while `owner` holds it.
	 *
	 * `stopApp` acts on whichever active row currently holds the app, so a caller
	 * that checked the holder separately would authorize on a stale read. Here the
	 * check and the claim happen in one synchronous step (no `await` between them,
	 * and the claim is a compare-and-set on the row id), so an app that changed
	 * owner cannot be stopped by the owner that no longer holds it.
	 */
	async stopOwned(
		owner: EnvironmentOwner,
		app: string,
	): Promise<EnvironmentInstance> {
		await this.ready;
		const record = this.state.findActiveEnvironmentInstance(app);
		if (!record)
			throw new EnvironmentInstanceError(
				"no-holder",
				409,
				`no environment instance holds ${JSON.stringify(app)}`,
			);
		if (parseEnvironmentOwner(record.owner) !== owner)
			throw new EnvironmentInstanceError(
				"held-by",
				409,
				`${JSON.stringify(app)} is held by ${record.owner}; only its owner may stop it`,
			);
		return this.stopSlot(app, "stopped");
	}

	private async stopSlot(
		app: string,
		terminal: "stopped" | "released-by-developer",
	): Promise<EnvironmentInstance> {
		const record = this.state.findActiveEnvironmentInstance(app);
		if (!record) {
			// No active holder. The only thing a stop/release can still act on is a
			// parallel-era row the v9 collapse retired, which is exactly what the
			// upgrade note tells the developer to clear.
			const retired = await this.clearRetired(app);
			if (retired) return this.toPublic(retired);
			throw new EnvironmentInstanceError(
				"no-holder",
				409,
				`no environment instance holds ${JSON.stringify(app)}`,
			);
		}
		if (record.status === "starting" || record.status === "stopping")
			throw new EnvironmentInstanceError(
				"instance-busy",
				409,
				`cannot stop an instance while it is ${record.status}`,
			);
		if (
			!this.state.claimEnvironmentInstanceStop(
				record.id,
				this.now().toISOString(),
			)
		) {
			const current = this.state.getEnvironmentInstance(record.id);
			if (current?.status === terminal) return this.toPublic(current);
			throw new EnvironmentInstanceError(
				"instance-busy",
				409,
				`cannot claim stop while the instance is ${current?.status ?? "missing"}`,
			);
		}
		try {
			await this.stopRun(record);
		} catch (error) {
			this.state.compareAndSetEnvironmentInstanceStatus(
				record.id,
				"stopping",
				"unknown",
				this.now().toISOString(),
			);
			if (error instanceof EnvironmentInstanceError) throw error;
			throw new EnvironmentInstanceError("stop-failed", 500, message(error), {
				cause: error,
			});
		}
		// Clear the retired parallel-era rows while this app is still held
		// (`stopping`), so no granted start can race the clean-up, and never let
		// that best-effort work fail a stop that already committed.
		await this.retireSuperseded(app);
		const stoppedAt = this.now().toISOString();
		if (
			!this.state.transitionEnvironmentInstanceStatus(
				record.id,
				"stopping",
				terminal,
				stoppedAt,
			)
		)
			throw new EnvironmentInstanceError(
				"lifecycle-conflict",
				409,
				"instance state changed while stopping",
			);
		const stopped = this.state.getEnvironmentInstance(record.id);
		if (!stopped)
			throw new EnvironmentInstanceError(
				"state-error",
				500,
				"instance disappeared after stop",
			);
		this.invalidateApp(app);
		return this.toPublic(stopped);
	}

	/**
	 * Clear an app that has no active holder but does have retired rows, and
	 * answer with whatever is left: `stopped` once observation confirmed the run
	 * is gone, otherwise the honest `superseded` row.
	 */
	private async clearRetired(
		app: string,
	): Promise<EnvironmentInstanceRecord | undefined> {
		const retired = this.state
			.getSupersededEnvironmentInstances()
			.filter((record) => record.app === app);
		if (retired.length === 0) return undefined;
		await this.retireSuperseded(app);
		return (
			this.state
				.getSupersededEnvironmentInstances()
				.find((record) => record.app === app) ??
			this.state.getEnvironmentInstance(
				(retired[0] as EnvironmentInstanceRecord).id,
			)
		);
	}

	/**
	 * Best-effort clean-up of the rows the v9 collapse retired without observing
	 * them: their `<app>-<instance>` compose project (the parallel era's name) is
	 * stopped here, and each row is only marked `stopped` once no container of it
	 * remains. A row whose runtime cannot be observed, or whose container is still
	 * there, keeps its honest `superseded` status. Nothing in here may fail the
	 * caller: a stop that already committed is never turned into an error.
	 */
	private async retireSuperseded(app: string): Promise<void> {
		const rows = this.state
			.getSupersededEnvironmentInstances()
			.filter((record) => record.app === app);
		if (rows.length === 0) return;
		for (const record of rows) {
			// Re-read every row before touching its run: a row that is no longer
			// retired may already belong to a fresh grant.
			if (this.state.getEnvironmentInstance(record.id)?.status !== "superseded")
				continue;
			try {
				await this.retireRow(record);
			} catch (error) {
				this.logger?.(
					`[slots] clearing the retired run of ${record.app} (${record.id}) failed: ${message(error)}`,
				);
			}
		}
	}

	/** Stops one retired row's run and confirms it gone before marking it stopped. */
	private async retireRow(record: EnvironmentInstanceRecord): Promise<void> {
		if (record.runtime !== "docker") {
			// A parallel-era script process never survived a restart, and a v9
			// handle is keyed by the row id.
			const key = scriptHandleKey(record.id);
			if (this.scriptInfra.executionHandle(key))
				await this.scriptInfra.stop(key);
			this.state.transitionEnvironmentInstanceStatus(
				record.id,
				"superseded",
				"stopped",
				this.now().toISOString(),
			);
			return;
		}
		const docker = await this.dockerRuntime();
		if (!docker) return;
		const project = legacyComposeProjectName(record);
		const sourcePath = this.retiredSourcePath(record);
		if (sourcePath)
			await this.runCommand(
				composeCommandForRuntime(docker.runtime.name),
				["-p", project, "-f", sourcePath, "down"],
				{ cwd: record.checkoutPath, env: environmentWith({}, "user") },
			);
		await this.removeLegacyContainers(docker, project);
		docker.client.invalidateCache();
		const remaining = await docker.client.allContainers();
		if (remaining.some((container) => isLegacyContainer(container, project)))
			return;
		this.state.transitionEnvironmentInstanceStatus(
			record.id,
			"superseded",
			"stopped",
			this.now().toISOString(),
		);
	}

	/**
	 * The compose file a retired row ran. Its stored target id belongs to the
	 * parallel era, so an exact id match is not required: the app's own docker run
	 * target is what the retired project was created from.
	 */
	private retiredSourcePath(
		record: EnvironmentInstanceRecord,
	): string | undefined {
		const app = this.apps().find((candidate) => candidate.ident === record.app);
		if (!app) return undefined;
		const targets = this.runTargetsFor(
			app,
			record.checkoutPath,
			record.configOverlay,
		);
		return (
			targets.find((candidate) => candidate.id === record.targetId) ??
			targets.find((candidate) => candidate.runtime === "docker")
		)?.sourcePath;
	}

	/** Removes the containers of one retired parallel-era compose project. */
	private async removeLegacyContainers(
		docker: DockerRuntimeSelection,
		project: string,
	): Promise<void> {
		docker.client.invalidateCache();
		const containers = await docker.client.allContainers();
		const owned = containers.filter((container) =>
			isLegacyContainer(container, project),
		);
		const results = await Promise.allSettled(
			owned.map((container) => docker.client.removeContainer(container.Id)),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected")
			this.logger?.(
				`[slots] removing a superseded container of ${project} failed: ${message(failure.reason)}`,
			);
	}

	/** Stops whatever the holder's row is running: compose project or script. */
	private async stopRun(record: EnvironmentInstanceRecord): Promise<void> {
		if (record.runtime !== "docker") {
			const key = scriptHandleKey(record.id);
			// A handle is process-local: after a restart (or when the row came from a
			// parallel-era database) there is nothing left to stop, so a missing
			// handle means `already stopped` instead of a slot nobody can release.
			if (this.scriptInfra.executionHandle(key))
				await this.scriptInfra.stop(key);
			return;
		}
		const docker = await this.dockerRuntime();
		if (!docker)
			throw new EnvironmentInstanceError(
				"runtime-unavailable",
				503,
				"Docker runtime is unavailable",
			);
		const app = this.apps().find((candidate) => candidate.ident === record.app);
		const target = app ? this.findTarget(record, app) : undefined;
		if (target) {
			const result = await this.runCommand(
				composeCommandForRuntime(docker.runtime.name),
				["-f", target.sourcePath, "down"],
				{
					cwd: record.checkoutPath,
					env: environmentWith(
						this.variables(
							parseEnvironmentOwner(record.owner),
							record.checkoutPath,
						),
						parseEnvironmentOwner(record.owner),
					),
				},
			);
			if (result.exitCode !== 0)
				throw new EnvironmentInstanceError(
					"stop-failed",
					500,
					result.output || `compose exited ${result.exitCode}`,
				);
		}
		await this.removeObservedContainers(docker, record, app);
	}

	/**
	 * Removes containers of the app's run targets that `compose down` left
	 * behind. Containers are matched by the compose config file they were
	 * created from, because an app runs with its definition's own project name.
	 */
	private async removeObservedContainers(
		docker: DockerRuntimeSelection,
		record: EnvironmentInstanceRecord,
		app: App | undefined,
	): Promise<void> {
		docker.client.invalidateCache();
		const sourcePaths = app
			? this.runTargetsFor(app, record.checkoutPath, record.configOverlay).map(
					(target) => target.sourcePath,
				)
			: [];
		if (sourcePaths.length === 0) return;
		const containers = await docker.client.allContainers();
		const owned = containers.filter((container) =>
			containerFromConfigFiles(container, sourcePaths),
		);
		const results = await Promise.allSettled(
			owned.map((container) => docker.client.removeContainer(container.Id)),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		docker.client.invalidateCache();
		const remaining = await docker.client.allContainers();
		if (
			remaining.some((container) =>
				containerFromConfigFiles(container, sourcePaths),
			)
		)
			throw new Error("Docker containers of the app survived removal");
	}

	// --- start ---------------------------------------------------------------

	/** Starts one app for one owner; the caller has already reserved the slot. */
	private async start(
		owner: EnvironmentOwner,
		appIdent: string,
		request: QueuedRequest,
	): Promise<EnvironmentInstanceRecord> {
		const app = this.apps().find((candidate) => candidate.ident === appIdent);
		if (!app || app.appType === "library" || app.appType === "LIB")
			throw new EnvironmentInstanceError(
				"app-not-found",
				404,
				`app ${JSON.stringify(appIdent)} not found`,
			);
		const docker = await this.dockerRuntime();
		const checkoutPath =
			owner === "user"
				? app.localDirectoryPath
				: await this.resolveOwnerCheckout?.(owner, app);
		if (!checkoutPath)
			throw new EnvironmentInstanceError(
				"owner-checkout-unavailable",
				503,
				`no managed checkout is available for ${owner}`,
			);
		const targets = this.runTargetsFor(app, checkoutPath);
		const selected = selectTarget(targets, request, docker !== undefined);
		if (selected.runtime === "kubernetes")
			throw new EnvironmentInstanceError(
				"explicit-runtime-required",
				400,
				"Kubernetes is not supported by environment instances in this change",
			);
		const previous = this.state.findEnvironmentInstance(owner, appIdent);
		const instanceId =
			owner === "user"
				? "default"
				: (previous?.id ?? environmentInstanceId(owner, appIdent));
		const timestamp = this.now().toISOString();
		const record: EnvironmentInstanceRecord = {
			id: environmentInstanceStorageId(owner, appIdent),
			owner,
			app: appIdent,
			targetId: selected.id,
			runtime: selected.runtime,
			checkoutPath,
			imageTag:
				owner === "user" ? "latest" : (previous?.imageTag ?? instanceId),
			status: "starting",
			createdAt: previous?.createdAt ?? timestamp,
			lastActivityAt: timestamp,
		};
		const claimedId = this.state.claimEnvironmentInstance(record);
		if (!claimedId)
			throw new EnvironmentInstanceError(
				"slot-lost",
				409,
				`${appIdent} was taken by another owner while the start was prepared`,
			);
		const variables = this.variables(owner, checkoutPath);
		// The early exit of a script that dies before the `starting -> running`
		// CAS: the completion would otherwise be dropped and leave a dead row
		// holding the app forever.
		let earlyExit: number | undefined;
		try {
			if (selected.runtime === "docker") {
				const runtime = await this.dockerRuntime();
				if (!runtime)
					throw new EnvironmentInstanceError(
						"runtime-unavailable",
						503,
						"no Docker-compatible runtime is available",
					);
				// The definition's own project name, container names and host ports
				// are what every routing, proxy and OAuth definition already assumes.
				const result = await this.runCommand(
					composeCommandForRuntime(runtime.runtime.name),
					["-f", selected.sourcePath, "up", "-d"],
					{ cwd: checkoutPath, env: environmentWith(variables, owner) },
				);
				runtime.client.invalidateCache();
				if (result.exitCode !== 0)
					throw new EnvironmentInstanceError(
						"start-failed",
						500,
						result.output || `compose exited ${result.exitCode}`,
					);
			} else {
				const key = scriptHandleKey(record.id);
				const launch = await this.scriptInfra.launch({
					ident: key,
					runner: "shell",
					command: selected.command ?? "sh",
					args: selected.args ?? [selected.sourcePath],
					dir: selected.workingDir ?? checkoutPath,
					env: environmentWith(variables, owner),
					...(owner === "user" ? {} : { forceLogged: true }),
					spawn: () => {
						const proc = Bun.spawn(
							[
								selected.command ?? "sh",
								...(selected.args ?? [selected.sourcePath]),
							],
							{
								cwd: selected.workingDir ?? checkoutPath,
								env: environmentWith(variables, owner),
								stdout: "ignore",
								stderr: "ignore",
							},
						);
						void proc.exited.then((exitCode) => {
							if (this.scriptInfra instanceof ScriptInfrastructure)
								this.scriptInfra.noteExit(key, exitCode, "", proc.pid);
							const handle = this.scriptInfra.executionHandle(key);
							if (handle?.pid !== proc.pid) return;
							const current = this.state.getEnvironmentInstance(record.id);
							if (current?.status === "starting") {
								// Recorded for `start` to apply once the row is `running`.
								earlyExit = exitCode;
								return;
							}
							if (current?.status !== "running") return;
							const terminal = exitCode === 0 ? "stopped" : "failed";
							this.state.transitionEnvironmentInstanceStatus(
								record.id,
								"running",
								terminal,
								this.now().toISOString(),
							);
						});
						return { pid: proc.pid };
					},
				});
				if (launch.status !== "running")
					throw new EnvironmentInstanceError(
						"start-failed",
						500,
						`script exited during startup with status ${launch.status}`,
					);
			}
			if (
				!this.state.compareAndSetEnvironmentInstanceStatus(
					claimedId,
					"starting",
					"running",
					this.now().toISOString(),
				)
			)
				throw new EnvironmentInstanceError(
					"lifecycle-conflict",
					409,
					"instance state changed while the target was starting",
				);
			if (earlyExit !== undefined) {
				// The process was already gone when the row became `running`: settle
				// it instead of reporting a live instance that holds the app.
				this.state.transitionEnvironmentInstanceStatus(
					claimedId,
					"running",
					earlyExit === 0 ? "stopped" : "failed",
					this.now().toISOString(),
				);
				throw new EnvironmentInstanceError(
					"start-failed",
					500,
					`script exited during startup with status ${earlyExit}`,
				);
			}
			const running = this.state.getEnvironmentInstance(claimedId);
			if (!running)
				throw new EnvironmentInstanceError(
					"state-error",
					500,
					"instance disappeared after start",
				);
			return running;
		} catch (error) {
			this.state.transitionEnvironmentInstanceStatus(
				claimedId,
				"starting",
				"failed",
				this.now().toISOString(),
			);
			throw error;
		}
	}

	private findTarget(
		record: EnvironmentInstanceRecord,
		app: App,
	): ActionTarget | undefined {
		return this.runTargetsFor(
			app,
			record.checkoutPath,
			record.configOverlay,
		).find((candidate) => candidate.id === record.targetId);
	}

	// --- reconcile -----------------------------------------------------------

	/** Startup observation never mistakes an unavailable runtime for absence. */
	async reconcile(): Promise<void> {
		const persisted = this.state.getEnvironmentInstances();
		if (persisted.some((instance) => instance.runtime === "docker"))
			await this.dockerRuntime();
		// The parallel-era rows the migration retired must be confirmed by
		// observation before they are recorded stopped: the database alone cannot
		// know whether their container is still there.
		for (const record of this.state.getSupersededEnvironmentInstances()) {
			if (await this.observeRetiredRow(record)) {
				this.state.transitionEnvironmentInstanceStatus(
					record.id,
					"superseded",
					"stopped",
					this.now().toISOString(),
				);
				continue;
			}
			this.logger?.(
				`[slots] ${record.app} still has a run of the parallel era (${record.id} owned by ${record.owner}); it is not holding the slot and a developer release or stop clears it`,
			);
		}
		for (const record of persisted) {
			if (record.status === "stopped" || record.status === "failed") continue;
			if (record.status === "released-by-developer") continue;
			if (record.status === "starting" || record.status === "stopping") {
				const lastActivity = Date.parse(record.lastActivityAt);
				const age = this.now().getTime() - lastActivity;
				if (
					!Number.isFinite(lastActivity) ||
					age < LIFECYCLE_RECONCILE_GRACE_MS
				)
					continue;
			}
			if (
				record.status !== "running" &&
				record.status !== "starting" &&
				record.status !== "stopping" &&
				record.status !== "unknown"
			)
				continue;
			if (record.runtime === "docker") {
				if (!this.docker) {
					this.state.compareAndSetEnvironmentInstanceStatus(
						record.id,
						record.status,
						"unknown",
						this.now().toISOString(),
					);
					continue;
				}
				try {
					const app = this.apps().find(
						(candidate) => candidate.ident === record.app,
					);
					const sourcePaths = app
						? this.runTargetsFor(
								app,
								record.checkoutPath,
								record.configOverlay,
							).map((target) => target.sourcePath)
						: [];
					const containers = await this.docker.client.allContainers();
					const owned = containers.filter((container) =>
						containerFromConfigFiles(container, sourcePaths),
					);
					const status = owned.some(
						(container) => container.State === "running",
					)
						? "running"
						: "stopped";
					this.state.transitionEnvironmentInstanceStatus(
						record.id,
						record.status,
						status,
						this.now().toISOString(),
					);
				} catch {
					this.state.compareAndSetEnvironmentInstanceStatus(
						record.id,
						record.status,
						"unknown",
						this.now().toISOString(),
					);
				}
				continue;
			}
			const key = scriptHandleKey(record.id);
			if (!this.scriptInfra.executionHandle(key)) {
				this.state.compareAndSetEnvironmentInstanceStatus(
					record.id,
					record.status,
					"unknown",
					this.now().toISOString(),
				);
				continue;
			}
			try {
				const observed: ScriptStatus = this.scriptInfra.observe
					? await this.scriptInfra.observe(key)
					: await this.scriptInfra.status(key);
				const status =
					observed.status === "running"
						? "running"
						: observed.status === "stopped" || observed.status === "failed"
							? observed.status
							: "unknown";
				this.state.transitionEnvironmentInstanceStatus(
					record.id,
					record.status,
					status,
					this.now().toISOString(),
				);
			} catch {
				this.state.compareAndSetEnvironmentInstanceStatus(
					record.id,
					record.status,
					"unknown",
					this.now().toISOString(),
				);
			}
		}
	}

	/**
	 * Whether observation confirms a retired parallel-era row ran nothing. A row
	 * whose runtime cannot be observed is never confirmed (so it keeps its
	 * honest `superseded` status).
	 */
	private async observeRetiredRow(
		record: EnvironmentInstanceRecord,
	): Promise<boolean> {
		if (record.runtime !== "docker") {
			// A parallel-era script process does not survive a restart, and a v9
			// handle is keyed by the row id.
			return !this.scriptInfra.executionHandle(scriptHandleKey(record.id));
		}
		const docker = await this.dockerRuntime();
		if (!docker) return false;
		try {
			const containers = await docker.client.allContainers();
			return !containers.some((container) =>
				isLegacyContainer(container, legacyComposeProjectName(record)),
			);
		} catch (error) {
			this.logger?.(
				`[slots] observing the retired run of ${record.app} failed: ${message(error)}`,
			);
			return false;
		}
	}

	/** Re-reads live script rows so a process that exited stops holding its app. */
	private async refreshScriptRows(): Promise<void> {
		for (const record of this.state.getActiveEnvironmentInstances()) {
			if (record.runtime === "docker") continue;
			if (record.status !== "running" && record.status !== "unknown") continue;
			const key = scriptHandleKey(record.id);
			try {
				const observed = this.scriptInfra.observe
					? await this.scriptInfra.observe(key)
					: await this.scriptInfra.status(key);
				const status =
					observed.status === "running"
						? "running"
						: observed.status === "failed"
							? "failed"
							: observed.status === "stopped"
								? "stopped"
								: "unknown";
				if (status !== record.status)
					this.state.transitionEnvironmentInstanceStatus(
						record.id,
						record.status,
						status,
						this.now().toISOString(),
					);
			} catch {
				this.state.compareAndSetEnvironmentInstanceStatus(
					record.id,
					record.status,
					"unknown",
					this.now().toISOString(),
				);
			}
		}
	}

	// --- queue ---------------------------------------------------------------

	private requestedApps(requested: readonly string[]): string[] {
		if (requested.length === 0)
			throw new EnvironmentInstanceError(
				"apps-required",
				400,
				"at least one app must be requested",
			);
		if (requested.length > MAX_REQUESTED_APPS)
			throw new EnvironmentInstanceError(
				"too-many-apps",
				400,
				`at most ${MAX_REQUESTED_APPS} apps may be requested at once`,
			);
		const known = new Set(
			this.apps()
				.filter((app) => app.appType !== "library" && app.appType !== "LIB")
				.map((app) => app.ident),
		);
		const apps: string[] = [];
		for (const app of requested) {
			if (!known.has(app))
				throw new EnvironmentInstanceError(
					"app-not-found",
					404,
					`app ${JSON.stringify(app)} not found`,
				);
			if (!apps.includes(app)) apps.push(app);
		}
		return apps;
	}

	private findWaiter(
		owner: EnvironmentOwner,
		apps: readonly string[],
	): SlotWaiter | undefined {
		const queue = this.queues.get(apps[0] as string) ?? [];
		return queue.find(
			(waiter) => waiter.owner === owner && sameApps(waiter.apps, apps),
		);
	}

	private enqueue(
		owner: EnvironmentOwner,
		apps: readonly string[],
		request: QueuedRequest,
	): SlotWaiter {
		const at = this.now().getTime();
		this.sequence += 1;
		const waiter: SlotWaiter = {
			id: `${owner}#${[...apps].sort().join("+")}`,
			owner,
			apps: [...apps],
			sequence: this.sequence,
			request,
			enqueuedAt: at,
			lastSeenAt: at,
			lastNotedAt: at,
			activePolls: 0,
			notified: false,
		};
		for (const app of waiter.apps) {
			const queue = this.queues.get(app) ?? [];
			queue.push(waiter);
			queue.sort((left, right) => left.sequence - right.sequence);
			this.queues.set(app, queue);
		}
		return waiter;
	}

	/**
	 * One `environment.slot.waiting` event per app of a newly waiting entry. An
	 * app that is only ahead of this request in queue order has no holder, so it
	 * is not announced as one.
	 */
	private async notifyEntry(waiter: SlotWaiter): Promise<void> {
		for (const app of waiter.apps) {
			const queue = this.queues.get(app) ?? [];
			const holder = await this.occupantOf(app);
			if (!holder) continue;
			this.notifyWaiting(app, {
				app,
				waiter: waiter.owner,
				holder,
				position: queue.indexOf(waiter) + 1,
			});
		}
	}

	private dequeue(waiter: SlotWaiter): void {
		for (const app of waiter.apps) {
			const queue = this.queues.get(app);
			if (!queue) continue;
			const index = queue.indexOf(waiter);
			if (index >= 0) queue.splice(index, 1);
			if (queue.length === 0) this.queues.delete(app);
		}
	}

	/** Drops entries no request refreshed within the grace window. */
	private expireWaiters(at: number): void {
		for (const [app, queue] of [...this.queues]) {
			const kept = queue.filter(
				(waiter) =>
					waiter.activePolls > 0 || at - waiter.lastSeenAt <= this.queueGraceMs,
			);
			if (kept.length === 0) this.queues.delete(app);
			else this.queues.set(app, kept);
		}
	}

	private entries(): SlotWaiter[] {
		const seen = new Set<SlotWaiter>();
		for (const queue of this.queues.values())
			for (const waiter of queue) seen.add(waiter);
		return [...seen];
	}

	// --- deadlock ------------------------------------------------------------

	/**
	 * The wait chain that would close a hold/wait cycle, or `undefined` when the
	 * request can wait. `user` never waits, so a human holder never closes one.
	 */
	private async deadlockPath(
		requester: EnvironmentOwner,
		apps: readonly string[],
	): Promise<string | undefined> {
		const edges: Array<{
			owner: EnvironmentOwner;
			app: string;
			holder: EnvironmentOwner;
		}> = [];
		const visited = new Set<string>();
		const walk = async (
			owner: EnvironmentOwner,
			requested: readonly string[],
			depth: number,
		): Promise<boolean> => {
			if (depth > 16) return false;
			for (const app of requested) {
				const key = `${owner}\0${app}`;
				if (visited.has(key)) continue;
				visited.add(key);
				const holder = await this.holderOf(app);
				if (!holder || holder === owner) continue;
				edges.push({ owner, app, holder });
				if (holder === requester) return true;
				if (holder === "user") continue;
				const waitingFor = this.waitsOf(holder);
				if (waitingFor.length === 0) continue;
				if (await walk(holder, waitingFor, depth + 1)) return true;
			}
			return false;
		};
		const cycle = await walk(requester, apps, 0);
		if (!cycle) return undefined;
		const byOwner = new Map<
			EnvironmentOwner,
			{ apps: string[]; holder: EnvironmentOwner }
		>();
		for (const edge of edges) {
			const entry = byOwner.get(edge.owner) ?? {
				apps: [],
				holder: edge.holder,
			};
			if (!entry.apps.includes(edge.app)) entry.apps.push(edge.app);
			entry.holder = edge.holder;
			byOwner.set(edge.owner, entry);
		}
		// The requester's own edge closes the cycle; walk the chain from it.
		const chain: string[] = [];
		let current: EnvironmentOwner | undefined = requester;
		const guard = new Set<EnvironmentOwner>();
		while (current && !guard.has(current)) {
			guard.add(current);
			const entry = byOwner.get(current);
			if (!entry) break;
			chain.push(
				`${current} waits for ${entry.apps.join(", ")} (held by ${entry.holder})`,
			);
			current = entry.holder;
		}
		return chain.join("; ");
	}

	/** The owner holding an app right now, from rows first and observation second. */
	private async holderOf(app: string): Promise<EnvironmentOwner | undefined> {
		const record = this.state.findActiveEnvironmentInstance(app);
		if (record) return parseEnvironmentOwner(record.owner);
		const configured = this.apps().find((candidate) => candidate.ident === app);
		if (!configured) return undefined;
		const observed = await this.observeAppRunCached(configured);
		return observed === "stopped" ? undefined : "user";
	}

	/** The app's real occupant, or `undefined` when nobody holds it. */
	private async occupantOf(app: string): Promise<EnvironmentOwner | undefined> {
		return this.holderOf(app);
	}

	/** Forgets what was observed and discovered for one app. */
	private invalidateApp(app: string): void {
		this.cacheGeneration.set(app, (this.cacheGeneration.get(app) ?? 0) + 1);
		this.observations.delete(app);
		for (const key of [...this.targets.keys()])
			if (key.startsWith(`${app}\0`)) this.targets.delete(key);
	}

	/**
	 * Refreshes the activity stamp of every active row the owner holds. This is
	 * the queue's liveness stamp — a waiting owner is working, so what it still
	 * holds must not look idle — and it is throttled by the caller
	 * (`ACTIVITY_NOTE_MS`), not by the per-app coalescing window below.
	 */
	private noteActivity(owner: EnvironmentOwner, at: number): void {
		const stamp = new Date(at).toISOString();
		for (const record of this.state.getActiveEnvironmentInstances()) {
			if (record.owner !== owner) continue;
			if (record.lastActivityAt === stamp) continue;
			this.state.updateEnvironmentInstanceStatus(
				record.id,
				record.status,
				stamp,
			);
		}
	}

	/**
	 * Records activity on an app's slot. Every agent operation on an app goes
	 * through here — the slot calls today, the environment, browser and debug
	 * tools as they arrive — so the idle lifecycle measures real use. Writes are
	 * coalesced to one per app per `ACTIVITY_COALESCE_MS`: a burst of operations
	 * on a busy app is one state write, not one per call.
	 */
	touchActivity(app: string, at = this.now().getTime()): void {
		const last = this.activityTouches.get(app);
		if (last !== undefined && at - last < ACTIVITY_COALESCE_MS) return;
		const record = this.state.findActiveEnvironmentInstance(app);
		if (!record) return;
		this.activityTouches.set(app, at);
		const stamp = new Date(at).toISOString();
		if (record.lastActivityAt === stamp) return;
		this.state.updateEnvironmentInstanceStatus(record.id, record.status, stamp);
	}

	/**
	 * Records activity on an app, but only while `owner` holds it.
	 *
	 * The environment tools read and act on apps through the agent surface, and a
	 * read of an app another workflow holds is not that workflow's use of it: one
	 * agent polling `env_logs` must not keep another owner's run alive past its
	 * idle TTL. The check is one synchronous row read, and the write keeps the
	 * per-app coalescing above.
	 */
	touchOwnedActivity(
		owner: string,
		app: string,
		at = this.now().getTime(),
	): void {
		const record = this.state.findActiveEnvironmentInstance(app);
		if (!record) return;
		if (parseEnvironmentOwner(record.owner) !== parseEnvironmentOwner(owner))
			return;
		this.touchActivity(app, at);
	}

	// --- owner lifecycle -----------------------------------------------------

	/**
	 * Stop every app one owner holds, through the normal stop path, and answer
	 * the apps this call stopped. Idempotent: an owner that holds nothing answers
	 * an empty list, and a retry after a partial stop finishes the rest, which is
	 * what makes it safe as a durable outbox operation.
	 *
	 * `user` is refused: a developer's own run is never torn down by a workflow
	 * lifecycle, and the refusal is a request error rather than a silent no-op.
	 */
	async stopByOwner(ownerValue: string): Promise<OwnerTeardown> {
		await this.ready;
		let owner: EnvironmentOwner;
		try {
			owner = parseEnvironmentOwner(ownerValue);
		} catch (error) {
			throw new EnvironmentInstanceError("invalid-owner", 400, message(error), {
				cause: error,
			});
		}
		if (owner === "user")
			throw new EnvironmentInstanceError(
				"invalid-owner",
				400,
				"the developer's own apps are never released by a workflow lifecycle",
			);
		const apps: string[] = [];
		const failures: string[] = [];
		// The active rows are read once: stopping one only moves it out of the
		// active set, and a row that vanished underneath us is already free.
		for (const record of this.state.getActiveEnvironmentInstances()) {
			if (record.owner !== owner) continue;
			// Re-read before stopping: a row that died or was re-granted in the
			// meantime is no longer this owner's run to stop.
			if (!this.heldBy(record.app, owner)) continue;
			try {
				await this.stopSlot(record.app, "stopped");
				apps.push(record.app);
			} catch (error) {
				if (
					error instanceof EnvironmentInstanceError &&
					error.code === "no-holder"
				)
					continue;
				failures.push(`${record.app}: ${message(error)}`);
			}
		}
		if (failures.length > 0)
			throw new EnvironmentInstanceError(
				"teardown-failed",
				500,
				`${owner} still holds apps that could not be stopped: ${failures.join("; ")}`,
			);
		return { owner, apps };
	}

	/**
	 * Release every agent-held app that has sat idle longer than the TTL, through
	 * the normal stop path: the row is left `stopped`, so the next waiter is
	 * granted on its own next poll. Never reaped: a `user`-held app (the
	 * developer's own run), an app whose status is not `running` (`unknown` is
	 * unobserved, `starting`/`stopping` are mid-transition), and an app held by an
	 * owner that is currently waiting for another app.
	 */
	async reapIdleApps(ttlMs = this.idleTtlMs()): Promise<ReapedApp[]> {
		await this.ready;
		const at = this.now().getTime();
		const reaped: ReapedApp[] = [];
		for (const record of this.state.getActiveEnvironmentInstances()) {
			if (record.owner === "user" || record.status !== "running") continue;
			const owner = parseEnvironmentOwner(record.owner);
			if (this.waitsOf(owner).length > 0) continue;
			const lastActivity = Date.parse(record.lastActivityAt);
			if (!Number.isFinite(lastActivity) || at - lastActivity < ttlMs) continue;
			// Re-read before stopping: a row that died or was re-granted in the
			// meantime is no longer the idle run this pass decided to release.
			if (!this.heldBy(record.app, owner)) continue;
			try {
				await this.stopSlot(record.app, "stopped");
			} catch (error) {
				this.logger?.(
					`[slots] reaping idle ${record.app} (held by ${owner}) failed: ${message(error)}`,
				);
				continue;
			}
			reaped.push({ app: record.app, owner });
			this.emit("environment.slot.reaped", record.app, {
				app: record.app,
				owner,
			});
		}
		return reaped;
	}

	/**
	 * Start the server-scoped idle reaper: one pass every `intervalMs` (a minute)
	 * on this controller's injected clock. The server owns the returned stop
	 * function and calls it on shutdown; a pass that throws (an unreadable
	 * configuration, an unavailable runtime) is logged and retried on the next
	 * tick instead of ending the loop.
	 */
	startIdleReaper(options: IdleReaperOptions = {}): () => void {
		const controller = new AbortController();
		const signal = options.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal;
		const interval = options.intervalMs ?? this.reaperIntervalMs;
		const ttl = options.ttlMs ?? this.idleTtlMs;
		void (async () => {
			while (!signal.aborted) {
				try {
					await this.reapIdleApps(ttl());
				} catch (error) {
					this.logger?.(`[slots] idle reap failed: ${message(error)}`);
				}
				await this.sleepUntil(interval, signal);
			}
		})();
		return () => controller.abort();
	}

	/** Sleep for `ms`, or until `signal` aborts: a stopped server stops waiting. */
	private async sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		let onAbort: (() => void) | undefined;
		try {
			await Promise.race([
				this.sleep(ms),
				new Promise<void>((resolve) => {
					onAbort = () => resolve();
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Whether the app's active row is still this owner's run. */
	private heldBy(app: string, owner: EnvironmentOwner): boolean {
		return this.state.findActiveEnvironmentInstance(app)?.owner === owner;
	}

	/** The apps an owner is queued for. */
	private waitsOf(owner: EnvironmentOwner): string[] {
		const apps: string[] = [];
		for (const waiter of this.entries())
			if (waiter.owner === owner)
				for (const app of waiter.apps) if (!apps.includes(app)) apps.push(app);
		return apps;
	}

	// --- observation ---------------------------------------------------------

	/** Whether another owner's run of the app is visible. */
	private async observedUnavailable(app: string): Promise<boolean> {
		const configured = this.apps().find((candidate) => candidate.ident === app);
		if (!configured) return false;
		return (await this.observeAppRunCached(configured)) !== "stopped";
	}

	/**
	 * Run observation, reused for `observationRefreshMs`. Observation may spawn a
	 * process or walk the config tree, so it is never re-run on the 25 ms queue
	 * cadence; `acquire` invalidates it at the start of every request.
	 */
	private async observeAppRunCached(app: App): Promise<RunObservationState> {
		const cached = this.observations.get(app.ident);
		const at = this.now().getTime();
		if (cached && at - cached.at < this.observationRefreshMs)
			return cached.state;
		const generation = this.cacheGeneration.get(app.ident) ?? 0;
		const state = await this.observeAppRun(app);
		// An observation that started before the request boundary discarded the
		// cache must not put its stale value back.
		if ((this.cacheGeneration.get(app.ident) ?? 0) === generation)
			this.observations.set(app.ident, { at, state });
		return state;
	}

	private async observeAppRun(app: App): Promise<RunObservationState> {
		if (this.observeRun) return this.observeRun(app);
		if (!this.observation)
			// Nothing observes this host's shell runs, so there is nothing to see.
			return "stopped";
		let unobservable = false;
		try {
			if (await this.observation.isShellTmuxRunActive(app.ident))
				return "running";
		} catch (error) {
			this.logger?.(
				`[slots] shell run observation for ${app.ident} failed: ${message(error)}`,
			);
			unobservable = true;
		}
		const info = this.observation.runTargetInfo(app.ident);
		if (!info) return unobservable ? "unknown" : "stopped";
		if (info.runtime !== "docker" && info.runtime !== "podman")
			return unobservable ? "unknown" : "stopped";
		const docker = await this.dockerRuntime();
		if (!docker) return "unknown";
		try {
			const targetPaths = this.runTargetsFor(app, app.localDirectoryPath).map(
				(target) => target.sourcePath,
			);
			if (targetPaths.length === 0) return unobservable ? "unknown" : "stopped";
			const containers = await docker.client.allContainers();
			if (
				containers.some(
					(container) =>
						container.State === "running" &&
						containerFromConfigFiles(container, targetPaths),
				)
			)
				return "running";
		} catch (error) {
			this.logger?.(
				`[slots] container observation for ${app.ident} failed: ${message(error)}`,
			);
			unobservable = true;
		}
		return unobservable ? "unknown" : "stopped";
	}

	// --- notifications -------------------------------------------------------

	private notifyWaiting(app: string, payload: Record<string, unknown>): void {
		this.emit("environment.slot.waiting", app, payload);
	}

	private granted(owner: EnvironmentOwner, app: string): void {
		this.emit("environment.slot.granted", app, { app, owner });
	}

	private emit(
		kind: SlotEvent["kind"],
		app: string,
		payload: Record<string, unknown>,
	): void {
		try {
			this.publish?.({ domain: "environment", kind, resource: app, payload });
		} catch (error) {
			this.logger?.(`[slots] publishing ${kind} failed: ${message(error)}`);
		}
	}

	// --- helpers -------------------------------------------------------------

	private runTargetsFor(
		app: App,
		checkoutPath: string,
		configOverlay?: string,
	): ActionTarget[] {
		// Discovery walks the config and checkout trees synchronously, so the
		// result of one app/checkout/overlay is reused for a moment instead of
		// being re-derived on every observation.
		const key = `${app.ident}\0${checkoutPath}\0${configOverlay ?? ""}`;
		const cached = this.targets.get(key);
		const at = this.now().getTime();
		if (cached && at - cached.at < TARGET_CACHE_MS) return cached.targets;
		const generation = this.cacheGeneration.get(app.ident) ?? 0;
		const targets = this.discoverRunTargets(app, checkoutPath, configOverlay);
		if ((this.cacheGeneration.get(app.ident) ?? 0) === generation)
			this.targets.set(key, { at, targets });
		return targets;
	}

	private discoverRunTargets(
		app: App,
		checkoutPath: string,
		configOverlay?: string,
	): ActionTarget[] {
		const targets = discoverActionTargets({
			appIdent: app.ident,
			localDir: checkoutPath,
			action: "run",
			configDir: this.configDir,
		});
		if (!configOverlay) return targets;
		const overlay = discoverActionTargets({
			appIdent: app.ident,
			localDir: checkoutPath,
			action: "run",
			configDir: configOverlay,
		});
		const byId = new Map<string, ActionTarget>();
		for (const target of targets) byId.set(target.id, target);
		for (const target of overlay) byId.set(target.id, target);
		return [...byId.values()];
	}

	private variables(
		owner: EnvironmentOwner,
		checkoutPath: string,
	): Record<string, string> {
		return resolveInstanceVariables({ owner, appDir: checkoutPath });
	}

	private async dockerRuntime(): Promise<DockerRuntimeSelection | undefined> {
		if (this.docker) return this.docker;
		if (!this.resolveDocker) return undefined;
		this.dockerPromise ??= (async () => {
			try {
				this.docker = await this.resolveDocker?.();
			} catch (error) {
				this.logger?.(
					`[slots] Docker runtime selection failed: ${message(error)}`,
				);
			}
			return this.docker;
		})();
		return this.dockerPromise;
	}

	private toPublic(record: EnvironmentInstanceRecord): EnvironmentInstance {
		const app = this.apps().find((candidate) => candidate.ident === record.app);
		const target = app ? this.findTarget(record, app) : undefined;
		return {
			id: record.owner === "user" ? "default" : record.id,
			owner: parseEnvironmentOwner(record.owner),
			app: record.app,
			targetId: record.targetId,
			runtime: record.runtime,
			checkoutPath: record.checkoutPath,
			...(record.configOverlay ? { configOverlay: record.configOverlay } : {}),
			imageTag: record.imageTag,
			status: record.status as EnvironmentInstanceStatus,
			createdAt: record.createdAt,
			lastActivityAt: record.lastActivityAt,
			endpoints: target ? endpointsOf(target) : {},
		};
	}
}

/** The definition's static endpoint exports, as the clients address them. */
function endpointsOf(target: ActionTarget): Record<string, string> {
	const endpoints: Record<string, string> = {};
	for (const endpoint of target.exports ?? []) {
		const host =
			endpoint.host === undefined || endpoint.host === ""
				? "127.0.0.1"
				: endpoint.host;
		endpoints[endpoint.name] =
			`${endpoint.protocol}://${host}:${endpoint.port}`;
	}
	return endpoints;
}

/**
 * The compose project name the parallel era used for this row: `-p
 * <app>-<instance>` with the v8 public instance id. A v9 start never passes
 * `-p`, so this is only how a retired row's container is found and stopped.
 */
function legacyComposeProjectName(record: EnvironmentInstanceRecord): string {
	const instanceId = record.owner === "user" ? "default" : record.id;
	return `${record.app}-${instanceId}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-");
}

/** Whether a container belongs to a retired parallel-era compose project. */
/**
 * Whether a container belongs to a retired parallel-era compose project.
 *
 * Only the project label is trusted: every run of an app discovers the *same*
 * compose file, so a config-file match would also match the app's current live
 * run and the cleanup could tear that down. An orphan the project label does not
 * identify is left alone for the developer.
 */
function isLegacyContainer(
	container: { Labels?: Record<string, string> },
	project: string,
): boolean {
	return container.Labels?.["com.docker.compose.project"] === project;
}

/** Whether a container was created from one of the given compose files. The
 * compose config-file label is what identifies a run across checkouts: every
 * run of an app discovers the same compose file, whichever worktree started it.
 * Exported for the agent environment log reader, which resolves an app's
 * containers the same way a stop does. */
export function containerFromConfigFiles(
	container: { Labels?: Record<string, string> },
	sourcePaths: readonly string[],
): boolean {
	const raw = container.Labels?.["com.docker.compose.project.config_files"];
	if (!raw) return false;
	const files = raw
		.split(",")
		.map((file) => path.resolve(file.trim()))
		.filter((file) => file !== "");
	const resolved = sourcePaths.map((source) => path.resolve(source));
	return files.some((file) => resolved.includes(file));
}

/** Whether two requests name the same apps. Order is not identity: one
 * workflow's `[a,b]` and `[b,a]` are the same request, and treating them as two
 * entries would put the same owner in the queue twice (a spurious
 * `instance-busy` while the abandoned entry sits at the head for the grace
 * window). */
function sameApps(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((app, index) => app === sortedRight[index]);
}

function boundWaitSec(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0)
		return DEFAULT_WAIT_SEC;
	return Math.min(value, MAX_WAIT_SEC);
}

function selectTarget(
	targets: readonly ActionTarget[],
	request: QueuedRequest,
	dockerAvailable: boolean,
): ActionTarget {
	const named = request.target
		? targets.find(
				(candidate) =>
					candidate.id === request.target || candidate.label === request.target,
			)
		: undefined;
	if (request.target && !named)
		throw new EnvironmentInstanceError(
			"target-not-found",
			404,
			`run target ${JSON.stringify(request.target)} not found`,
		);
	if (named) return named;
	let candidates = [...targets].filter(
		(target) =>
			target.runtime === "docker" ||
			target.runtime === "shell" ||
			target.runtime === "systemshell",
	);
	if (request.runtime)
		candidates = candidates.filter(
			(target) => target.runtime === request.runtime,
		);
	if (!dockerAvailable)
		candidates = candidates.filter((target) => target.runtime !== "docker");
	if (request.profile)
		candidates = candidates.filter(
			(target) =>
				target.profile === request.profile ||
				(!target.profile && request.profile === "default"),
		);
	for (const runtime of ["docker", "shell", "systemshell"]) {
		const matching = candidates.filter((target) => target.runtime === runtime);
		if (matching.length === 0) continue;
		const defaultTarget = matching.find(
			(target) => (target.profile ?? "default") === "default",
		);
		if (defaultTarget) return defaultTarget;
		if (matching.length === 1) return matching[0] as ActionTarget;
		throw new EnvironmentInstanceError(
			"profile-required",
			400,
			`multiple ${runtime} run profiles are available; specify a target or profile`,
		);
	}
	if (targets.length === 0)
		throw new EnvironmentInstanceError(
			"target-not-found",
			404,
			"no run target is configured for this app",
		);
	throw new EnvironmentInstanceError(
		"runtime-unavailable",
		503,
		"no eligible Docker or script run target is available",
	);
}

function scriptHandleKey(storageId: string): string {
	return `environment-instance:${storageId}`;
}

function environmentWith(
	overrides: Readonly<Record<string, string>>,
	owner: EnvironmentOwner = "workflow:instance-runtime",
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (
			INSTANCE_SCRIPT_ENV_DENYLIST.includes(
				key as (typeof INSTANCE_SCRIPT_ENV_DENYLIST)[number],
			)
		)
			continue;
		if (owner !== "user" && !WORKFLOW_CHILD_ENV_ALLOWLIST.has(key)) continue;
		env[key] = value;
	}
	return Object.assign(env, overrides);
}

async function executeCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn([command, ...args], {
		cwd,
		env: { ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const exitCode = await child.exited;
	return { exitCode, output: `${stdout}${stderr}`.trim() };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
