// Pure delivery planner for the workflow event stream
// (add-orchestrator-event-subscriptions, task 4.1). No timers, no I/O, no
// gateway: given the matched events, the timings and `now`, it decides what the
// shell delivers. That is what makes coalescing, the per-minute bound,
// merge-forward, digest cadence, de-duplication and the caps testable with an
// explicit clock.
import {
	describeWorkflowEvent,
	MAX_EVENT_BACKLOG,
	MAX_NOTE_LINES,
	MAX_NOTES_PER_HOUR,
	type WorkflowEventDeliveryMatch,
	type WorkflowEventRecord,
} from "../../contracts/workflow-events.ts";

/** The cadences and caps a planner runs with. */
export interface DeliveryTimings {
	/** Events inside this window become one note (wake mode). */
	readonly coalesceMs: number;
	/** At most one note per session in this interval; overflow merges forward. */
	readonly minNoteIntervalMs: number;
	/** How long a digest subscription accumulates before delivering. */
	readonly digestMs: number;
	/** A note lists at most this many event lines. */
	readonly maxNoteLines: number;
	/** The pending backlog holds at most this many events. */
	readonly maxBacklog: number;
	/** At most this many notes in a trailing hour per session. */
	readonly maxNotesPerHour: number;
}

/** The production cadence. The three caps are the contract's own bounds, so one
 * declaration fixes what the server promises and what delivery enforces. */
export const DELIVERY_TIMINGS: DeliveryTimings = {
	coalesceMs: 10_000,
	minNoteIntervalMs: 60_000,
	digestMs: 5 * 60_000,
	maxNoteLines: MAX_NOTE_LINES,
	maxBacklog: MAX_EVENT_BACKLOG,
	maxNotesPerHour: MAX_NOTES_PER_HOUR,
};

interface PendingEntry {
	readonly event: WorkflowEventRecord;
	readonly labels: readonly string[];
	readonly dueAt: number;
}

/** One subscription's contribution, with the cadence overrides it declared. */
export interface DeliverySubscription {
	readonly id: string;
	readonly label: string;
	readonly mode: WorkflowEventDeliveryMatch["mode"];
	readonly coalesceMs?: number;
	readonly minIntervalMs?: number;
	readonly digestMinutes?: number;
}

/** The event sequence a note line reports, so a line is deterministic. */
function sortEntries(entries: readonly PendingEntry[]): PendingEntry[] {
	return [...entries].sort((a, b) => a.event.sequence - b.event.sequence);
}

/** One note line: the workflow and the step it reached, then what changed. An
 * event that names no workflow (the orchestrator launch ceiling) is one line
 * without a target. */
export function formatEventLine(event: WorkflowEventRecord): string {
	const description = describeWorkflowEvent(event);
	return event.workflowId
		? `- ${event.workflowId} → ${event.stepId} (${description})`
		: `- ${description}`;
}

/** One note: the fixed prefix with the contributing subscription labels, then
 * one line per event, then the elision count. */
export function formatNote(
	entries: readonly PendingEntry[],
	timings: DeliveryTimings,
	dropped = 0,
): string {
	const labels = [...new Set(entries.flatMap((entry) => entry.labels))].filter(
		Boolean,
	);
	const ordered = sortEntries(entries);
	const shown = ordered.slice(0, timings.maxNoteLines);
	const hidden = ordered.length - shown.length + dropped;
	const header =
		labels.length > 0
			? `[workflow-monitor] subs=${labels.join(",")}`
			: "[workflow-monitor]";
	const lines = [header, ...shown.map((entry) => formatEventLine(entry.event))];
	if (hidden > 0) lines.push(`… +${hidden} more`);
	return lines.join("\n");
}

/** The delivery planner: records matched events and answers what to deliver. */
export class DeliveryPlanner {
	private entries: PendingEntry[] = [];
	private noteTimes: number[] = [];
	private dropped = 0;
	/** No note was delivered yet, so the session's own interval never blocks the
	 * first one. */
	private lastDelivered = Number.NEGATIVE_INFINITY;
	/** When each subscription label last contributed to a note, so a
	 * subscription's own `minIntervalMs` is honoured without a second clock. */
	private readonly lastPerLabel = new Map<string, number>();

	constructor(readonly timings: DeliveryTimings = DELIVERY_TIMINGS) {}

	/** Record one event with the subscriptions that matched it. An event whose
	 * only matches are `silent` is recorded in the server log and never
	 * delivered, so it does not enter the planner at all. */
	record(
		event: WorkflowEventRecord,
		subscriptions: readonly DeliverySubscription[],
		now: number,
	): void {
		const delivering = subscriptions.filter(
			(subscription) => subscription.mode !== "silent",
		);
		if (delivering.length === 0) return;
		const dueAt = Math.min(
			...delivering.map((subscription) => this.dueAtFor(subscription, now)),
		);
		const labels = delivering.map((subscription) => subscription.label);
		// One event delivered through more than one subscription is one line: it
		// merges into the pending entry and keeps the earliest due time.
		const existing = this.entries.find(
			(entry) => entry.event.sequence === event.sequence,
		);
		if (existing) {
			const index = this.entries.indexOf(existing);
			this.entries[index] = {
				event,
				labels: [...new Set([...existing.labels, ...labels])],
				dueAt: Math.min(existing.dueAt, dueAt),
			};
			return;
		}
		this.entries.push({ event, labels, dueAt });
		while (this.entries.length > this.timings.maxBacklog) {
			this.entries.shift();
			this.dropped += 1;
		}
	}

	/** The coalescing window one subscription delivers with: its own cadence
	 * override, or the planner's. */
	private windowOf(subscription: DeliverySubscription): number {
		if (subscription.mode === "digest")
			return (
				(subscription.digestMinutes ?? this.timings.digestMs / 60_000) * 60_000
			);
		return subscription.coalesceMs ?? this.timings.coalesceMs;
	}

	/** The floor a subscription's `minIntervalMs` puts under its next
	 * contribution, or -Infinity while it has never contributed. */
	private floorFor(subscription: DeliverySubscription): number {
		const labelFloor = this.lastPerLabel.get(subscription.label);
		return subscription.minIntervalMs === undefined || labelFloor === undefined
			? Number.NEGATIVE_INFINITY
			: labelFloor + subscription.minIntervalMs;
	}

	/** When this subscription's event is delivered.
	 *
	 * The window belongs to the subscription and its note carries every event the
	 * window received, so an event that arrives while one of its own windows is
	 * still open joins that window. Without this, two events of one subscription a
	 * millisecond apart open two windows that close a millisecond apart: the first
	 * note is delivered at the first close with only the events of its own
	 * millisecond, and everything else the window received has to wait for the next
	 * note — a whole `minNoteIntervalMs` — because the backlog merged forward. A
	 * burst recorded over a few milliseconds then arrives as one truncated note
	 * plus a remainder, which is exactly the storm the coalescing window exists to
	 * prevent. A window that already closed, or one that closes later than this
	 * subscription's own window (`entry.dueAt > close`), is not joined: a digest
	 * window never pulls a wake subscriber forward, and a wake window never holds a
	 * digest subscriber back. */
	private dueAtFor(subscription: DeliverySubscription, now: number): number {
		const close = now + this.windowOf(subscription);
		let joined: number | undefined;
		for (const entry of this.entries) {
			if (!entry.labels.includes(subscription.label)) continue;
			if (entry.dueAt <= now || entry.dueAt > close) continue;
			if (joined === undefined || entry.dueAt < joined) joined = entry.dueAt;
		}
		// The subscription's own `minIntervalMs` floors how soon it may contribute
		// again, and outranks joining an open window.
		return Math.max(joined ?? close, this.floorFor(subscription));
	}

	/** The earliest instant a note could be delivered, or undefined when nothing
	 * is pending. The monitor arms its timer with this. */
	nextDueAt(now = 0): number | undefined {
		if (this.entries.length === 0) return undefined;
		const earliest = Math.min(...this.entries.map((entry) => entry.dueAt));
		return Math.max(earliest, this.sessionEarliest(now));
	}

	/** The session's own bound: at least one note interval after the last note,
	 * and no earlier than the hour window that frees up a note slot. */
	private sessionEarliest(now: number): number {
		const intervalBound = Number.isFinite(this.lastDelivered)
			? this.lastDelivered + this.timings.minNoteIntervalMs
			: Number.NEGATIVE_INFINITY;
		if (this.noteTimes.length < this.timings.maxNotesPerHour)
			return intervalBound;
		const oldest =
			this.noteTimes[this.noteTimes.length - this.timings.maxNotesPerHour];
		return Math.max(intervalBound, (oldest ?? now) + 60 * 60 * 1000);
	}

	/** The note to deliver now, or undefined when nothing is due or the session
	 * bound has not elapsed (the events stay queued and merge forward). */
	flush(now: number): string | undefined {
		if (this.entries.length === 0) return undefined;
		const due = this.entries.filter((entry) => entry.dueAt <= now);
		if (due.length === 0) return undefined;
		if (now < this.sessionEarliest(now)) return undefined;
		this.entries = this.entries.filter((entry) => entry.dueAt > now);
		const note = formatNote(due, this.timings, this.dropped);
		this.dropped = 0;
		this.lastDelivered = now;
		for (const entry of due)
			for (const label of entry.labels) this.lastPerLabel.set(label, now);
		this.noteTimes = [...this.noteTimes, now].filter(
			(at) => at > now - 60 * 60 * 1000,
		);
		return note;
	}

	/** Drop everything: a resync means the backlog is untrustworthy, and a stop
	 * means no note is delivered any more. */
	reset(): void {
		this.entries = [];
		this.dropped = 0;
	}

	get pendingCount(): number {
		return this.entries.length;
	}

	get lastDeliveredAt(): number {
		return this.lastDelivered;
	}
}
