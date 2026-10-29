import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
	decodeScheduling,
	type Job,
	type JobInput,
	jobSchema,
	type Occurrence,
	type OccurrenceState,
	type Schedule,
	type ScheduleAction,
	type ScheduleInput,
	SchedulingError,
	scheduleSchema,
	type TargetReceipt,
} from "../../contracts/scheduling.ts";
import {
	destinationKey,
	effectiveLatePolicy,
	isTerminal,
} from "../../scheduling/domain.ts";
import {
	instant,
	missedRange,
	nextSlot,
	validateTiming,
} from "../../scheduling/recurrence.ts";
import { openSchedulingDatabase } from "./database.ts";

const DDL = `
CREATE TABLE jobs (id TEXT PRIMARY KEY, deleted INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE schedules (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, next_due INTEGER, data TEXT NOT NULL);
CREATE INDEX due_schedules ON schedules(state,next_due,id);
CREATE INDEX job_schedules ON schedules(job_id,state,id);
CREATE TABLE occurrences (id TEXT PRIMARY KEY, slot TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL REFERENCES schedules(id), job_id TEXT NOT NULL REFERENCES jobs(id), destination TEXT, active INTEGER NOT NULL, created_at INTEGER NOT NULL, terminal_at INTEGER, data TEXT NOT NULL);
CREATE INDEX schedule_history ON occurrences(schedule_id,created_at,id);
CREATE UNIQUE INDEX occupied_job ON occurrences(job_id) WHERE active=1;
CREATE UNIQUE INDEX occupied_destination ON occurrences(destination) WHERE active=1 AND destination IS NOT NULL;
CREATE INDEX active_occurrences ON occurrences(active,created_at,id);
CREATE TABLE mutation_receipts (principal TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(principal,request_id));
PRAGMA user_version=1;`;
function parse<T>(row: { data: string } | null): T | undefined {
	return row ? (JSON.parse(row.data) as T) : undefined;
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** One private SQLite connection per service. All admission decisions use immediate transactions. */
export class SchedulingStore {
	private constructor(
		private readonly db: Database,
		readonly filename: string,
		readonly identity: string,
	) {}
	static open(directory: string): SchedulingStore {
		const filename = path.join(directory, "scheduling.sqlite");
		const { db, existing } = openSchedulingDatabase(directory);
		try {
			let identity = "";
			db.transaction(() => {
				const version = db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version;
				if (version === 0 && !existing) {
					const count = db
						.query<{ n: number }, []>(
							"SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
						)
						.get()?.n;
					if (count !== 0)
						throw new SchedulingError(
							"unavailable",
							"Refusing an unversioned nonempty scheduling store.",
						);
					db.exec(DDL);
				} else if (version !== 1)
					throw new SchedulingError(
						"unavailable",
						"Unsupported scheduling store version.",
					);
				// Additive metadata, compatible with existing v1 rows and older readers.
				db.exec(
					"CREATE TABLE IF NOT EXISTS scheduling_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL) STRICT",
				);
				db.query(
					"INSERT OR IGNORE INTO scheduling_identity(singleton,id) VALUES(1,?)",
				).run(randomUUID());
				const stored = db
					.query<{ id: string }, []>(
						"SELECT id FROM scheduling_identity WHERE singleton=1",
					)
					.get();
				if (
					!stored ||
					!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(stored.id)
				)
					throw new SchedulingError(
						"unavailable",
						"Invalid scheduling store identity.",
					);
				identity = stored.id;
				// Additive index: compatible with existing v1 records and older readers.
				db.exec(
					"CREATE INDEX IF NOT EXISTS schedule_outcome ON occurrences(schedule_id,json_extract(data,'$.terminalAt') DESC,id DESC) WHERE active=0; CREATE INDEX IF NOT EXISTS terminal_history ON occurrences(schedule_id,created_at DESC,id DESC) WHERE active=0; CREATE INDEX IF NOT EXISTS terminal_expiry ON occurrences(terminal_at,id) WHERE active=0",
				);
			}).immediate();
			return new SchedulingStore(db, filename, identity);
		} catch (error) {
			db.close();
			throw error;
		}
	}
	close(): void {
		this.db.close();
	}
	private atomic<T>(work: () => T): T {
		return this.db.transaction(work).immediate();
	}
	private putJob(job: Job): void {
		this.db
			.query(
				"INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,data=excluded.data",
			)
			.run(job.id, job.deletedAt === undefined ? 0 : 1, JSON.stringify(job));
	}
	private putSchedule(schedule: Schedule): void {
		this.db
			.query(
				"INSERT INTO schedules VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,state=excluded.state,next_due=excluded.next_due,data=excluded.data",
			)
			.run(
				schedule.id,
				schedule.jobId,
				schedule.state,
				schedule.nextDue,
				JSON.stringify(schedule),
			);
	}
	private putOccurrence(value: Occurrence): void {
		this.db
			.query(
				"INSERT INTO occurrences VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,terminal_at=excluded.terminal_at,data=excluded.data",
			)
			.run(
				value.id,
				value.slot,
				value.scheduleId,
				value.jobId,
				destinationKey(value.job.target),
				isTerminal(value.state) ? 0 : 1,
				value.createdAt,
				value.terminalAt ?? null,
				JSON.stringify(value),
			);
		if (isTerminal(value.state)) {
			// At most 1,000 indexed entries to find this schedule's cutoff;
			// unrelated histories are never ranked or scanned.
			this.db
				.query(
					`DELETE FROM occurrences WHERE schedule_id=? AND active=0 AND (created_at,id) < (SELECT created_at,id FROM occurrences WHERE schedule_id=? AND active=0 ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 999)`,
				)
				.run(value.scheduleId, value.scheduleId);
		}
	}
	job(id: string): Job {
		const value = parse<Job>(
			this.db
				.query<{ data: string }, [string]>("SELECT data FROM jobs WHERE id=?")
				.get(id),
		);
		if (!value) throw new SchedulingError("not-found", "Job not found.");
		return value;
	}
	schedule(id: string): Schedule {
		const value = parse<Schedule>(
			this.db
				.query<{ data: string }, [string]>(
					"SELECT data FROM schedules WHERE id=?",
				)
				.get(id),
		);
		if (!value) throw new SchedulingError("not-found", "Schedule not found.");
		return value;
	}
	occurrence(id: string): Occurrence {
		const value = parse<Occurrence>(
			this.db
				.query<{ data: string }, [string]>(
					"SELECT data FROM occurrences WHERE id=?",
				)
				.get(id),
		);
		if (!value) throw new SchedulingError("not-found", "Occurrence not found.");
		return value;
	}
	private revision(actual: number, expected: number): void {
		if (actual !== expected)
			throw new SchedulingError(
				"conflict",
				"Stale revision; reload before applying this change.",
			);
	}
	/** Read-only acknowledgement recovery, before target validation or remote I/O. */
	replay<T>(
		principal: string,
		requestId: string,
		body: unknown,
	): T | undefined {
		if (
			!principal ||
			principal.length > 256 ||
			!requestId ||
			requestId.length > 256
		)
			throw new SchedulingError(
				"invalid-input",
				"A bounded principal and request key are required.",
			);
		const prior = this.db
			.query<{ digest: string; result: string }, [string, string]>(
				"SELECT digest,result FROM mutation_receipts WHERE principal=? AND request_id=?",
			)
			.get(principal, requestId);
		if (!prior) return undefined;
		if (prior.digest !== digest(body))
			throw new SchedulingError(
				"conflict",
				"Request key was already used with a different body.",
			);
		return JSON.parse(prior.result) as T;
	}
	/** Retry identical principal/request/body; changed bodies are never silently reused. */
	mutate<T>(
		principal: string,
		requestId: string,
		body: unknown,
		work: () => T,
	): T {
		if (
			!principal ||
			principal.length > 256 ||
			!requestId ||
			requestId.length > 256
		)
			throw new SchedulingError(
				"invalid-input",
				"A bounded principal and request key are required.",
			);
		return this.atomic(() => {
			const key = digest(body);
			const prior = this.db
				.query<{ digest: string; result: string }, [string, string]>(
					"SELECT digest,result FROM mutation_receipts WHERE principal=? AND request_id=?",
				)
				.get(principal, requestId);
			if (prior) {
				if (prior.digest !== key)
					throw new SchedulingError(
						"conflict",
						"Request key was already used with a different body.",
					);
				return JSON.parse(prior.result) as T;
			}
			const result = work();
			this.db
				.query("INSERT INTO mutation_receipts VALUES (?,?,?,?)")
				.run(principal, requestId, key, JSON.stringify(result));
			return result;
		});
	}
	createJob(raw: JobInput, now: number): Job {
		const input = decodeScheduling(jobSchema, raw);
		const count =
			this.db
				.query<{ n: number }, []>("SELECT count(*) n FROM jobs WHERE deleted=0")
				.get()?.n ?? 0;
		if (count >= 1000)
			throw new SchedulingError("limit", "Maximum 1000 active jobs.");
		const job: Job = {
			...input,
			id: randomUUID(),
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};
		this.putJob(job);
		return job;
	}
	updateJob(
		id: string,
		revision: number,
		raw: JobInput,
		now: number,
	): { job: Job; affectedSchedules: string[] } {
		const input = decodeScheduling(jobSchema, raw),
			old = this.job(id);
		this.revision(old.revision, revision);
		if (old.deletedAt !== undefined)
			throw new SchedulingError("conflict", "Job is deleted.");
		const job: Job = {
			...old,
			...input,
			revision: revision + 1,
			updatedAt: now,
		};
		this.putJob(job);
		const affectedSchedules = this.db
			.query<{ id: string }, [string]>(
				"SELECT id FROM schedules WHERE job_id=? AND state NOT IN ('cancelled','deleted') ORDER BY id",
			)
			.all(id)
			.map((row) => row.id);
		for (const scheduleId of affectedSchedules)
			this.fencePending(scheduleId, now);
		return { job, affectedSchedules };
	}
	deleteJob(id: string, revision: number, now: number): Job {
		const job = this.job(id);
		this.revision(job.revision, revision);
		if (
			this.db
				.query(
					"SELECT id FROM schedules WHERE job_id=? AND state!='deleted' LIMIT 1",
				)
				.get(id)
		)
			throw new SchedulingError(
				"conflict",
				"Delete referencing schedules before deleting this job.",
			);
		const result = {
			...job,
			deletedAt: now,
			updatedAt: now,
			revision: revision + 1,
		};
		this.putJob(result);
		return result;
	}
	createSchedule(raw: ScheduleInput, now: number): Schedule {
		const input = decodeScheduling(scheduleSchema, raw);
		validateTiming(input.timing);
		const job = this.job(input.jobId);
		if (job.deletedAt !== undefined)
			throw new SchedulingError("conflict", "Job is deleted.");
		effectiveLatePolicy(job, input.latePolicy);
		const count =
			this.db
				.query<{ n: number }, []>(
					"SELECT count(*) n FROM schedules WHERE state!='deleted'",
				)
				.get()?.n ?? 0;
		if (count >= 1000)
			throw new SchedulingError("limit", "Maximum 1000 active schedules.");
		const due =
			input.timing.kind === "once"
				? instant(input.timing.at)
				: nextSlot(input.timing, now);
		const schedule: Schedule = {
			...input,
			id: randomUUID(),
			revision: 1,
			state: "enabled",
			nextDue: due,
			cursor: null,
			overrideDue: null,
			createdAt: now,
			updatedAt: now,
		};
		this.putSchedule(schedule);
		return schedule;
	}
	updateSchedule(
		id: string,
		revision: number,
		raw: ScheduleInput,
		now: number,
	): Schedule {
		const input = decodeScheduling(scheduleSchema, raw),
			old = this.schedule(id);
		this.revision(old.revision, revision);
		validateTiming(input.timing);
		if (old.state === "deleted" || old.state === "cancelled")
			throw new SchedulingError("conflict", "Schedule is no longer editable.");
		const job = this.job(input.jobId);
		if (job.deletedAt !== undefined)
			throw new SchedulingError("conflict", "Job is deleted.");
		effectiveLatePolicy(job, input.latePolicy);
		this.fencePending(id, now);
		const schedule: Schedule = {
			...old,
			...input,
			revision: revision + 1,
			updatedAt: now,
			overrideDue: null,
			nextDue:
				input.timing.kind === "once"
					? instant(input.timing.at)
					: nextSlot(
							input.timing,
							Math.max(now, (old.cursor ?? -Infinity) + 1),
						),
		};
		this.putSchedule(schedule);
		return schedule;
	}
	private fencePending(scheduleId: string, now: number): void {
		for (const row of this.db
			.query<{ data: string }, [string]>(
				"SELECT data FROM occurrences WHERE schedule_id=? AND active=1",
			)
			.all(scheduleId)) {
			const value = JSON.parse(row.data) as Occurrence;
			if (value.admittedAt !== undefined) continue;
			// A reservation with an ambiguous activation must first reconcile, not be treated as absent.
			if (value.state === "reconciling") continue;
			this.putOccurrence({
				...value,
				state: "cancelled-before-admission",
				fence: value.fence + 1,
				updatedAt: now,
				terminalAt: now,
				reason: "Schedule changed before admission.",
			});
		}
	}
	action(
		id: string,
		revision: number,
		action: ScheduleAction,
		now: number,
		requestId: string,
		until?: number,
	): { schedule: Schedule; occurrence?: Occurrence; active: Occurrence[] } {
		const old = this.schedule(id);
		this.revision(old.revision, revision);
		if (old.state === "deleted" || old.state === "cancelled")
			throw new SchedulingError(
				"conflict",
				"Schedule is no longer actionable.",
			);
		// Run-now is a request for another slot, not a configuration change.
		// A skipped manual slot must not invalidate an outstanding admission.
		let value = {
			...old,
			revision: action === "run-now" ? revision : revision + 1,
			updatedAt: now,
		};
		let occurrence: Occurrence | undefined;
		if (action === "run-now") {
			if (old.state !== "enabled")
				throw new SchedulingError(
					"conflict",
					"Resume the schedule before running it now.",
				);
			occurrence = this.materialize(
				{ ...old, revision: value.revision },
				now,
				now,
				`manual:${id}:${requestId}`,
			);
			if (old.timing.kind === "once")
				value = {
					...value,
					nextDue: null,
					cursor: Math.max(now, instant(old.timing.at)),
				};
		} else {
			this.fencePending(id, now);
			if (action === "pause") value.state = "paused";
			if (action === "cancel") {
				value.state = "cancelled";
				value.nextDue = null;
			}
			if (action === "delete") {
				value.state = "deleted";
				value.nextDue = null;
			}
			if (action === "resume") {
				value.state = "enabled";
				if (old.timing.kind !== "once")
					value.nextDue = nextSlot(
						old.timing,
						Math.max(now, (old.cursor ?? -Infinity) + 1),
					);
			}
			if (action === "postpone") {
				if (!Number.isSafeInteger(until) || until === undefined || until <= now)
					throw new SchedulingError(
						"invalid-input",
						"Postponement requires a future instant.",
					);
				value.overrideDue = until;
				value.nextDue = until;
			}
		}
		this.putSchedule(value);
		return {
			schedule: value,
			...(occurrence ? { occurrence } : {}),
			active: this.activeForSchedule(id),
		};
	}
	listJobs(after = "", limit = 100): Job[] {
		this.page(limit);
		return this.db
			.query<{ data: string }, [string, number]>(
				"SELECT data FROM jobs WHERE deleted=0 AND id>? ORDER BY id LIMIT ?",
			)
			.all(after, limit)
			.map((row) => JSON.parse(row.data) as Job);
	}
	listSchedules(after = "", limit = 100): Schedule[] {
		this.page(limit);
		return this.db
			.query<{ data: string }, [string, number]>(
				"SELECT data FROM schedules WHERE state!='deleted' AND id>? ORDER BY id LIMIT ?",
			)
			.all(after, limit)
			.map((row) => JSON.parse(row.data) as Schedule);
	}
	private page(limit: number): void {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new SchedulingError("invalid-input", "Page size must be 1..100.");
	}
	history(scheduleId: string, after = "", limit = 100): Occurrence[] {
		this.page(limit);
		// IDs are random; the stable cursor is the tuple encoded by historyCursor().
		let at = -1,
			id = "";
		if (after) {
			try {
				const tuple = JSON.parse(after) as unknown;
				if (
					!Array.isArray(tuple) ||
					tuple.length !== 2 ||
					typeof tuple[0] !== "number" ||
					typeof tuple[1] !== "string"
				)
					throw new Error();
				[at, id] = tuple as [number, string];
			} catch {
				throw new SchedulingError("invalid-input", "Invalid history cursor.");
			}
		}
		return this.db
			.query<{ data: string }, [string, number, number, string, number]>(
				"SELECT data FROM occurrences WHERE schedule_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?",
			)
			.all(scheduleId, at, at, id, limit)
			.map((row) => JSON.parse(row.data) as Occurrence);
	}
	latestOutcome(scheduleId: string): Occurrence | undefined {
		const row = this.db
			.query<{ data: string }, [string]>(
				"SELECT data FROM occurrences WHERE schedule_id=? AND active=0 ORDER BY json_extract(data,'$.terminalAt') DESC,id DESC LIMIT 1",
			)
			.get(scheduleId);
		return row ? (JSON.parse(row.data) as Occurrence) : undefined;
	}
	/** Bounded active detail; history pagination exposes any remaining pending work. */
	activeForSchedule(id: string): Occurrence[] {
		return this.db
			.query<{ data: string }, [string]>(
				"SELECT data FROM occurrences WHERE active=1 AND schedule_id=? ORDER BY created_at,id LIMIT 100",
			)
			.all(id)
			.map((row) => JSON.parse(row.data) as Occurrence);
	}
	referencingSchedules(jobId: string): string[] {
		return this.db
			.query<{ id: string }, [string]>(
				"SELECT id FROM schedules WHERE job_id=? AND state NOT IN ('cancelled','deleted') ORDER BY id",
			)
			.all(jobId)
			.map((row) => row.id);
	}
	active(limit = 100): Occurrence[] {
		this.page(limit);
		return this.db
			.query<{ data: string }, [number]>(
				"SELECT data FROM occurrences WHERE active=1 ORDER BY created_at,id LIMIT ?",
			)
			.all(limit)
			.map((row) => JSON.parse(row.data) as Occurrence);
	}
	activeBatch(after: string): Occurrence[] {
		return this.db
			.query<{ data: string }, [string]>(
				"SELECT data FROM occurrences WHERE active=1 AND id>? ORDER BY id LIMIT 100",
			)
			.all(after)
			.map((row) => JSON.parse(row.data) as Occurrence);
	}
	private materialize(
		schedule: Schedule,
		due: number,
		now: number,
		slot = `${schedule.id}:${due}`,
		state: OccurrenceState = "pending",
	): Occurrence {
		const prior = parse<Occurrence>(
			this.db
				.query<{ data: string }, [string]>(
					"SELECT data FROM occurrences WHERE slot=?",
				)
				.get(slot),
		);
		if (prior) return prior;
		const job = this.job(schedule.jobId),
			destination = destinationKey(job.target);
		const occupied = this.db
			.query<{ id: string }, [string, string | null]>(
				"SELECT id FROM occurrences WHERE active=1 AND (job_id=? OR destination=?) LIMIT 1",
			)
			.get(job.id, destination);
		const result: Occurrence = {
			id: randomUUID(),
			slot,
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			jobId: job.id,
			jobRevision: job.revision,
			job,
			nominalDue: due,
			createdAt: now,
			updatedAt: now,
			state: occupied && state === "pending" ? "skipped-overlap" : state,
			fence: 0,
			leaseUntil: 0,
			attempts: 0,
			nextAttempt: now,
		};
		if (occupied && state === "pending")
			result.reason = `Outstanding occurrence ${occupied.id}`;
		if (isTerminal(result.state)) result.terminalAt = now;
		this.putOccurrence(result);
		return result;
	}
	/** Each call creates <=100 records. Clock rewinds cannot pass the persisted nominal cursor. */
	reconcileDue(now: number, resumed = false): Occurrence[] {
		return this.atomic(() => {
			const rows = this.db
				.query<{ data: string }, [number]>(
					"SELECT data FROM schedules WHERE state='enabled' AND next_due<=? ORDER BY next_due,id LIMIT 100",
				)
				.all(now);
			const result: Occurrence[] = [];
			for (const row of rows) {
				const schedule = JSON.parse(row.data) as Schedule,
					due = schedule.nextDue;
				if (due === null) continue;
				const isOnce = schedule.timing.kind === "once";
				if (!isOnce && due < now - (resumed ? 0 : 5000)) {
					const range = missedRange(schedule.timing, due, now);
					const occurrence = this.materialize(
						schedule,
						due,
						now,
						undefined,
						"missed",
					);
					occurrence.missedCount = range.count;
					occurrence.missedLast = range.last;
					this.putOccurrence(occurrence);
					result.push(occurrence);
					this.putSchedule({
						...schedule,
						nextDue: range.next,
						cursor: range.last,
						overrideDue: null,
					});
					continue;
				}
				const expired =
					isOnce &&
					schedule.latePolicy.kind === "expire-after" &&
					now - due > schedule.latePolicy.graceMs;
				result.push(
					this.materialize(
						schedule,
						due,
						now,
						undefined,
						expired ? "expired" : "pending",
					),
				);
				const cadenceAfter = Math.max(due, schedule.cursor ?? due);
				this.putSchedule({
					...schedule,
					nextDue: isOnce ? null : nextSlot(schedule.timing, cadenceAfter + 1),
					cursor: cadenceAfter,
					overrideDue: null,
				});
			}
			return result;
		});
	}
	claim(id: string, now: number, leaseMs = 30_000): Occurrence | undefined {
		return this.atomic(() => {
			const value = this.occurrence(id);
			if (
				isTerminal(value.state) ||
				(value.state === "waiting-review" &&
					value.admittedAt === undefined &&
					value.job.target.kind === "standalone" &&
					value.job.target.policy === "default" &&
					value.approvedAt === undefined) ||
				value.leaseUntil > now ||
				value.nextAttempt > now
			)
				return undefined;
			const next = {
				...value,
				fence: value.fence + 1,
				leaseUntil: now + leaseMs,
				updatedAt: now,
			};
			this.putOccurrence(next);
			return next;
		});
	}
	transition(
		id: string,
		fence: number,
		state: OccurrenceState,
		now: number,
		patch: {
			receipt?: TargetReceipt;
			reason?: string;
			nextAttempt?: number;
			attempts?: number;
		} = {},
	): Occurrence {
		return this.atomic(() => {
			const old = this.occurrence(id);
			this.revision(old.fence, fence);
			if (isTerminal(old.state))
				throw new SchedulingError("conflict", "Occurrence is terminal.");
			const value: Occurrence = {
				...old,
				...patch,
				state,
				updatedAt: now,
				...(isTerminal(state) ? { terminalAt: now, leaseUntil: 0 } : {}),
			};
			this.putOccurrence(value);
			return value;
		});
	}
	resolveJob(id: string, fence: number, job: Job): Occurrence {
		return this.atomic(() => {
			const old = this.occurrence(id);
			this.revision(old.fence, fence);
			if (
				old.admittedAt !== undefined ||
				old.receipt !== undefined ||
				(old.state !== "pending" && old.state !== "destination-unavailable")
			)
				throw new SchedulingError(
					"conflict",
					"Occurrence settings are already reserved.",
				);
			this.revision(this.job(old.jobId).revision, job.revision);
			const value = { ...old, job, jobRevision: job.revision };
			this.putOccurrence(value);
			return value;
		});
	}
	/** Durable activation authorization is the mutation/admission linearization point. */
	approve(
		id: string,
		fence: number,
		principal: string,
		now: number,
	): Occurrence {
		return this.atomic(() => {
			const old = this.occurrence(id);
			this.revision(old.fence, fence);
			if (
				old.state !== "waiting-review" ||
				old.admittedAt !== undefined ||
				old.job.target.kind !== "standalone" ||
				old.job.target.policy !== "default"
			)
				throw new SchedulingError(
					"conflict",
					"Occurrence is not awaiting writable standalone approval.",
				);
			const value: Occurrence = {
				...old,
				state: "reserved",
				approvedAt: now,
				approvedBy: principal,
				updatedAt: now,
				leaseUntil: 0,
				nextAttempt: now,
			};
			this.putOccurrence(value);
			return value;
		});
	}
	authorize(id: string, fence: number, now: number): Occurrence {
		return this.atomic(() => {
			const old = this.occurrence(id);
			this.revision(old.fence, fence);
			if (old.admittedAt !== undefined) return old;
			const schedule = this.schedule(old.scheduleId);
			if (
				old.job.target.kind === "standalone" &&
				old.job.target.policy === "default" &&
				old.approvedAt === undefined
			)
				throw new SchedulingError(
					"conflict",
					"Writable standalone activation requires operator approval for this occurrence.",
				);
			if (
				schedule.state !== "enabled" ||
				schedule.revision !== old.scheduleRevision ||
				this.job(old.jobId).revision !== old.jobRevision ||
				old.state !== "reserved" ||
				!old.receipt ||
				old.leaseUntil <= now
			)
				throw new SchedulingError(
					"conflict",
					"Occurrence no longer authorized for activation.",
				);
			const value: Occurrence = {
				...old,
				admittedAt: now,
				state: "admitted",
				updatedAt: now,
			};
			this.putOccurrence(value);
			return value;
		});
	}
	prune(now: number): number {
		return this.atomic(
			() =>
				this.db
					.query(
						`DELETE FROM occurrences WHERE id IN (SELECT id FROM occurrences WHERE active=0 AND terminal_at<? ORDER BY terminal_at,id LIMIT 100)`,
					)
					.run(now - 90 * 86400_000).changes,
		);
	}
}
export function historyCursor(value: Occurrence): string {
	return JSON.stringify([value.createdAt, value.id]);
}
