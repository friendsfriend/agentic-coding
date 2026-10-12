/**
 * App-slot store for the Environments feature (show-environment-instances).
 *
 * The server publishes `environment.slot.waiting/granted/reaped` on the domain
 * stream; this store keeps one keyed row per app, applies those events and the
 * start/stop status the legacy stream reports, and re-reads the authoritative
 * `/api/v1/environment/apps/slots` snapshot whenever the domain stream signals a
 * gap (`resync`). Rows are contention-only: an app that is free, or held by the
 * developer with nobody waiting, stays in the normal app list.
 *
 * The mapping and event application are pure functions so a unit test can pin
 * them without a server or a terminal; `createSlotStore` is the thin reactive
 * wrapper the TUI mounts.
 */
import type {
	AppSlot,
	DevEnvClient,
	DomainEventMessage,
	SlotWaiter,
} from "@devenv/core";
import { createSignal } from "solid-js";

/** One waiting owner, with the instant its wait began and its queue position. */
export type SlotWait = SlotWaiter;

/** One app's contention row. */
export interface SlotRow {
	app: string;
	holder: string | null;
	status: string | null;
	endpoints: Record<string, string>;
	holderSince: string | null;
	idleMs: number | null;
	idleTtlMs: number | null;
	waiting: SlotWait[];
}

export function slotRowFromSnapshot(slot: AppSlot): SlotRow {
	return {
		app: slot.app,
		holder: slot.holder,
		status: slot.status,
		endpoints: slot.endpoints ?? {},
		holderSince: slot.holderSince ?? null,
		idleMs: slot.idleMs ?? null,
		idleTtlMs: slot.idleTtlMs ?? null,
		waiting:
			slot.waiting ??
			slot.waiters.map((owner, index) => ({
				owner,
				since: "",
				position: index + 1,
			})),
	};
}

export function slotRowsFromSnapshot(slots: readonly AppSlot[]): SlotRow[] {
	return slots.map(slotRowFromSnapshot);
}

/** The rows the Slots section lists: agent-held, or holding a queue. */
export function visibleSlotRows(rows: readonly SlotRow[]): SlotRow[] {
	return rows.filter(
		(row) =>
			row.waiting.length > 0 || Boolean(row.holder?.startsWith("workflow:")),
	);
}

/** "you" for the developer, the workflow id otherwise. */
export function slotOwnerLabel(owner: string | null | undefined): string {
	if (!owner) return "nobody";
	if (owner === "user") return "you";
	if (owner.startsWith("workflow:")) return owner.slice("workflow:".length);
	return owner;
}

/** The durable workflow id behind an owner string, or undefined. */
export function slotWorkflowId(
	owner: string | null | undefined,
): string | undefined {
	if (!owner?.startsWith("workflow:")) return undefined;
	const id = owner.slice("workflow:".length);
	return id === "" ? undefined : id;
}

/** Milliseconds `wait` has been queued at `nowMs`, or 0 when it has no start. */
export function slotWaitMs(wait: SlotWait, nowMs: number): number {
	const since = Date.parse(wait.since);
	if (!Number.isFinite(since)) return 0;
	return Math.max(0, nowMs - since);
}

/** Milliseconds left before the idle reaper releases an agent holder, or null. */
export function slotIdleRemainingMs(row: SlotRow): number | null {
	if (row.idleTtlMs === null || row.idleMs === null) return null;
	return Math.max(0, row.idleTtlMs - row.idleMs);
}

/** Human duration ("3m 20s"); one unit pair keeps the row narrow. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** The text fields of one Slots row; pure so a test pins them without a
 * terminal. `endpoints` and `idle` fall back to an em dash when absent. */
export function slotRowFields(
	row: SlotRow,
	nowMs: number,
): {
	holder: string;
	status: string;
	endpoints: string;
	idle: string;
	waiting: string;
} {
	const endpoints = Object.entries(row.endpoints)
		.map(([name, address]) => `${name}=${address}`)
		.join(", ");
	const idleParts: string[] = [];
	if (row.idleMs !== null) idleParts.push(`idle ${formatDuration(row.idleMs)}`);
	const remaining = slotIdleRemainingMs(row);
	if (remaining !== null) idleParts.push(`ttl ${formatDuration(remaining)}`);
	return {
		holder: slotOwnerLabel(row.holder),
		status: row.status ?? "unknown",
		endpoints: endpoints || "—",
		idle: idleParts.join(" · ") || "—",
		waiting:
			row.waiting
				.map(
					(wait) =>
						`${slotOwnerLabel(wait.owner)} (${formatDuration(slotWaitMs(wait, nowMs))})`,
				)
				.join(", ") || "—",
	};
}

function upsert(
	rows: readonly SlotRow[],
	app: string,
	update: (row: SlotRow) => SlotRow,
): SlotRow[] {
	const index = rows.findIndex((row) => row.app === app);
	if (index < 0)
		return [
			...rows,
			update({
				app,
				holder: null,
				status: null,
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [],
			}),
		];
	return rows.map((row, at) => (at === index ? update(row) : row));
}

/** Apply one domain message to the rows. `resync` is the caller's cue to
 * re-read the snapshot, so this pure function leaves the rows untouched for it
 * and reports that a refresh is required. */
export function applySlotMessage(
	rows: readonly SlotRow[],
	message: DomainEventMessage,
): { rows: SlotRow[]; refresh: boolean } {
	if (message.type === "resync") return { rows: [...rows], refresh: true };
	const { event } = message;
	if (event.domain !== "environment")
		return { rows: [...rows], refresh: false };
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	const app = typeof payload.app === "string" ? payload.app : event.resource;
	if (!app) return { rows: [...rows], refresh: false };

	if (event.kind === "environment.slot.waiting") {
		const waiter =
			typeof payload.waiter === "string" ? payload.waiter : undefined;
		if (!waiter) return { rows: [...rows], refresh: false };
		const holder = typeof payload.holder === "string" ? payload.holder : null;
		const position =
			typeof payload.position === "number" ? payload.position : undefined;
		return {
			rows: upsert(rows, app, (row) => {
				const waiting = row.waiting.filter((wait) => wait.owner !== waiter);
				waiting.push({
					owner: waiter,
					since: event.at,
					position: position ?? waiting.length + 1,
				});
				waiting.sort((left, right) => left.position - right.position);
				return {
					...row,
					holder: holder ?? row.holder,
					waiting: waiting.map((wait, index) => ({
						...wait,
						position: index + 1,
					})),
				};
			}),
			refresh: false,
		};
	}

	if (event.kind === "environment.slot.granted") {
		const owner = typeof payload.owner === "string" ? payload.owner : undefined;
		if (!owner) return { rows: [...rows], refresh: false };
		return {
			rows: upsert(rows, app, (row) => ({
				...row,
				holder: owner,
				holderSince: event.at,
				idleMs: 0,
				idleTtlMs: owner.startsWith("workflow:")
					? (row.idleTtlMs ?? null)
					: null,
				waiting: row.waiting
					.filter((wait) => wait.owner !== owner)
					.map((wait, index) => ({ ...wait, position: index + 1 })),
			})),
			refresh: false,
		};
	}

	if (event.kind === "environment.slot.reaped") {
		const owner = typeof payload.owner === "string" ? payload.owner : undefined;
		return {
			rows: upsert(rows, app, (row) =>
				row.holder && (!owner || row.holder === owner)
					? {
							...row,
							holder: null,
							holderSince: null,
							idleMs: null,
							idleTtlMs: null,
						}
					: row,
			),
			refresh: false,
		};
	}

	return { rows: [...rows], refresh: false };
}

export interface SlotStoreOptions {
	client: DevEnvClient;
	/** Overridable clock for wait/idle arithmetic. */
	now?: () => number;
}

export function createSlotStore(options: SlotStoreOptions) {
	const now = options.now ?? (() => Date.now());
	const [rows, setRows] = createSignal<SlotRow[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	let controller: AbortController | undefined;
	let started = false;

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const snapshot = await options.client.getAppSlots();
			setRows(slotRowsFromSnapshot(snapshot));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	const handleMessage = (message: DomainEventMessage): void => {
		const result = applySlotMessage(rows(), message);
		if (result.refresh) {
			void refresh();
			return;
		}
		setRows(result.rows);
	};

	/** A start/stop the legacy status stream reports: keep the row status in
	 * step with the app so a stopped holder is not shown as running. */
	const noteAppStatus = (app: string, status?: string): void => {
		if (!status) return;
		setRows((previous) =>
			previous.map((row) => (row.app === app ? { ...row, status } : row)),
		);
	};

	const start = (): void => {
		if (started) return;
		started = true;
		controller = new AbortController();
		void refresh();
		void (async () => {
			try {
				for await (const message of options.client.subscribeDomainEvents(
					controller?.signal,
				))
					handleMessage(message);
			} catch (cause) {
				if (controller?.signal.aborted) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		// Start/stop the legacy status stream reports: keep a row's status honest and
		// re-read the snapshot on a holder-relevant transition, so an app the
		// developer started or stopped is not left stale until the next slot event.
		void (async () => {
			try {
				for await (const event of options.client.subscribeToEvents(
					controller?.signal,
				)) {
					if (
						event.type !== "status.updated" &&
						event.type !== "operation.status.changed"
					)
						continue;
					const properties = event.properties as {
						ident?: unknown;
						appIdent?: unknown;
						status?: unknown;
					};
					const app =
						typeof properties.appIdent === "string"
							? properties.appIdent
							: typeof properties.ident === "string"
								? properties.ident
								: undefined;
					if (!app) continue;
					const status =
						typeof properties.status === "string"
							? properties.status
							: undefined;
					noteAppStatus(app, status);
					if (status === "running" || status === "stopped") void refresh();
				}
			} catch (cause) {
				if (controller?.signal.aborted) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
	};

	const stop = (): void => {
		started = false;
		controller?.abort();
		controller = undefined;
	};

	const visible = () => visibleSlotRows(rows());
	const rowFor = (app: string) => rows().find((row) => row.app === app);

	return {
		rows,
		loading,
		error,
		visible,
		rowFor,
		refresh,
		noteAppStatus,
		start,
		stop,
		now,
	};
}

export type SlotStore = ReturnType<typeof createSlotStore>;
