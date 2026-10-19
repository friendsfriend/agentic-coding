// The re-verification scope decision (role-scoped re-verification): for a round
// that follows a fix, which verifier roles run. Pure domain — the plan every
// round's triage produced, the roles that reported findings, the fix delta the
// runtime measured, and the round counter are the whole input, so this module
// never reads a file, git, or the configuration (the threshold travels inside
// the delta the runtime stamped).
//
// The default is conservative: only an unambiguous attribution scopes a round.
// Everything unreadable, truncated, or ambiguous widens it to today's
// classifier-decided round, because a round that re-runs a role it did not need
// to is cheaper than one that hides a finding. Two facts are never narrowed
// away: the roles that reported the findings the fix resolved, and the
// engine-owned full suite (which no scope and no mode can drop).
import {
	VERIFICATION_SCOPE_MAX_FILES,
	VERIFICATION_SCOPE_MAX_PATH_BYTES,
	VERIFICATION_SCOPE_MAX_ROLES,
	type VerificationRoleReason,
	type VerificationScopeDecision,
	type VerificationScopeReason,
	type VerificationScopeRecord,
} from "../../contracts/workflow.ts";

/** The default minimum number of files a fix must have changed in content for a
 * round to open with its owners (`workflow.min_reverification_changed_files`).
 * One file is the granularity ownership has, so the default never narrows a
 * real fix; only a no-op or a whitespace-only fix opens no domain round. */
export const DEFAULT_MIN_REVERIFICATION_CHANGED_FILES = 1;

/** The threshold an operator may configure, inclusive. A value outside this
 * range is refused where the runtime resolves it. */
export const MIN_REVERIFICATION_CHANGED_FILES_RANGE = [0, 20] as const;

/** The engine-owned full-suite verifier: never part of a scope, always launched
 * by the engine whatever a round's domain selection is. */
export const ENGINE_OWNED_VERIFIER_ROLE = "test-verifier";

export interface ReverificationFacts {
	/** The definition's eligible verifier roles, in catalog order and without
	 * the engine-owned full-suite role (`triageRolesFor`). */
	eligibleRoles: readonly string[];
	/** The last completed round, `loopCounts["core.verification:round"]`. */
	round: number;
	/** The persisted record of the previous round, when the snapshot has one. */
	record?: VerificationScopeRecord;
	/** The threshold the runtime stamped into the delta, or the default when the
	 * delta is missing (a widened round, so the number decides nothing). */
	threshold?: number;
}

/** One round's decision, plus the bounded record the snapshot and the telemetry
 * event are built from. `rerun` and `skipped` are the engine's own scope and
 * are empty for a round it leaves to the classifier, whose selection is
 * recorded by the triage-routing step's own classifier record. */
export interface ReverificationDecision {
	mode: VerificationScopeDecision["mode"];
	reason: VerificationScopeReason;
	threshold: number;
	touched: number;
	changed: number;
	baselineCount: number;
	/** The roles that reported the findings the fix resolved, restricted to the
	 * eligible catalog. They run in every mode, whatever they own. */
	reported: string[];
	rerun: Array<{ role: string; reason: VerificationRoleReason }>;
	skipped: Array<{ role: string; reason: VerificationRoleReason }>;
}

/** The round's role set when the engine scoped it; empty otherwise. Never
 * includes the engine-owned full-suite role. */
export function reverificationRoles(
	decision: ReverificationDecision,
): string[] {
	return decision.mode === "scoped"
		? decision.rerun.map((entry) => entry.role)
		: [];
}

/** Whether the decision leaves the round to the classifier, i.e. whether the
 * routing step still has to read the classifier's role answers. */
export function classifierDecided(decision: ReverificationDecision): boolean {
	return decision.mode === "first-round" || decision.mode === "full-set";
}

/** Fill a classifier-decided round's per-role lists from the answers that round
 * will use, so every role's participation is recorded in every mode. A role
 * that reported the findings the fix resolved stays in the run set even when
 * the classifier left it out: the floor is what keeps a fixed finding from
 * going unverified. A fail-open carries no selection, so both lists stay empty
 * and the unconstrained triage agent's own plan remains the only record. */
export function withClassifierRoles(
	decision: ReverificationDecision,
	eligibleRoles: readonly string[],
	selected: readonly string[] | undefined,
): ReverificationDecision {
	if (!classifierDecided(decision) || selected === undefined) return decision;
	const chosen = new Set([...selected, ...decision.reported]);
	return {
		...decision,
		rerun: eligibleRoles
			.filter((role) => chosen.has(role))
			.map((role) => ({
				role,
				reason: (decision.reported.includes(role)
					? "findings-reported"
					: "classifier-selected") as VerificationRoleReason,
			})),
		skipped: eligibleRoles
			.filter((role) => !chosen.has(role))
			.map((role) => ({ role, reason: "classifier-skipped" as const })),
	};
}

/** The bounded record the routing step persists for the next round to read. */
export function decisionRecord(
	decision: ReverificationDecision,
	writtenRound: number,
): VerificationScopeDecision {
	return {
		round: writtenRound,
		mode: decision.mode,
		reason: decision.reason,
		threshold: decision.threshold,
		touched: decision.touched,
		changed: decision.changed,
		baselineCount: decision.baselineCount,
		rerun: [...decision.rerun],
		skipped: [...decision.skipped],
	};
}

/** The plan ownership a round records, bounded to the record's caps. A plan the
 * record cannot hold is recorded as *no* ownership: a truncated plan cannot
 * attribute every touched file, so the round it would have scoped widens
 * (`no-plan-ownership`) instead of silently dropping a file's owner. Returning
 * an empty plan rather than omitting the field matters — the record is merged
 * field by field, so an omitted field would keep the previous round's ownership
 * under this round's stamp. */
export function planRecord(
	assignments: readonly { role: string; files: readonly string[] }[],
): { plan: Array<{ role: string; files: string[] }>; complete: boolean } {
	if (assignments.length > VERIFICATION_SCOPE_MAX_ROLES)
		return { plan: [], complete: false };
	let budget = VERIFICATION_SCOPE_MAX_FILES;
	const plan: Array<{ role: string; files: string[] }> = [];
	for (const assignment of assignments) {
		if (assignment.files.length > budget) return { plan: [], complete: false };
		// A path the record cannot hold is not a path a round may scope from.
		for (const file of assignment.files)
			if (Buffer.byteLength(file, "utf8") > VERIFICATION_SCOPE_MAX_PATH_BYTES)
				return { plan: [], complete: false };
		budget -= assignment.files.length;
		plan.push({ role: assignment.role, files: [...assignment.files] });
	}
	return { plan, complete: true };
}

/** The scope decision for the round that is opening.
 *
 * The record's stamps are what makes the measurement trustworthy: the plan, the
 * reported roles, and the delta belong to the round that just finished
 * (`round`), and the baseline it carries is the tree the round that is opening
 * will verify (`round + 1`). A record whose stamps do not line up was written by
 * another round or never re-measured, so it cannot scope this one.
 *
 * The rules are an ordered table, and every branch that cannot attribute the
 * fix with confidence returns a widened round:
 *
 * 1. no completed round yet (`round < 1`) → `first-round`, classifier-decided;
 * 2. no record, or a record from another round, or a record whose plan names no
 *    file → `full-set` (`no-previous-round` / `no-plan-ownership`);
 * 3. a reported role the definition no longer offers → `full-set`
 *    (`reported-role-outside-catalog`);
 * 4. a baseline or delta that is missing, stamped for another round, or
 *    incomplete → `full-set` (`baseline-unusable` / `delta-unusable`);
 * 5. no file changed in content, or fewer than the threshold → `scoped`
 *    (`findings-reported`) when the fix resolved findings, so the roles that
 *    reported them still see it, and otherwise `suite-only`
 *    (`below-minimum-diff`): the engine-owned full suite only;
 * 6. a substantively changed file the plan attributed to no role or to several
 *    roles → `full-set` (`unowned-touched-file` / `shared-touched-file`);
 * 7. otherwise `scoped` (`owner-touched`): the owning roles plus the roles that
 *    reported the findings.
 */
export function decideReverification(
	facts: ReverificationFacts,
): ReverificationDecision {
	const threshold =
		facts.threshold ??
		facts.record?.delta?.threshold ??
		DEFAULT_MIN_REVERIFICATION_CHANGED_FILES;
	const record = facts.record;
	// The roles that reported a finding in the round the fix follows: the fix was
	// made to resolve them, so each must see it whatever file it touched.
	const reported =
		record &&
		record.round === facts.round &&
		record.reported?.round === facts.round
			? [...record.reported.roles]
			: [];
	const widened = (
		reason: VerificationScopeReason,
		extra: Partial<ReverificationDecision> = {},
	): ReverificationDecision => ({
		mode: "full-set",
		reason,
		threshold,
		touched: 0,
		changed: 0,
		baselineCount: record?.baseline?.files.length ?? 0,
		reported,
		rerun: [],
		skipped: [],
		...extra,
	});
	if (!Number.isInteger(facts.round) || facts.round < 1)
		return {
			mode: "first-round",
			reason: "no-previous-round",
			threshold,
			touched: 0,
			changed: 0,
			baselineCount: 0,
			reported: [],
			rerun: [],
			skipped: [],
		};
	if (!record || record.round !== facts.round)
		return widened("no-previous-round");
	// A reported role the definition cannot launch (a plan from a differently
	// pinned definition, a trait that dropped the role) cannot be re-run, so the
	// round widens rather than dropping the role that found the problem.
	if (reported.some((role) => !facts.eligibleRoles.includes(role)))
		return widened("reported-role-outside-catalog");
	const plan = record.plan ?? [];
	if (!plan.some((entry) => entry.files.length > 0))
		return widened("no-plan-ownership");
	const baseline = record.baseline;
	if (
		!baseline ||
		baseline.round !== facts.round + 1 ||
		baseline.complete !== true
	)
		return widened("baseline-unusable", {
			baselineCount: baseline?.files.length ?? 0,
		});
	const delta = record.delta;
	if (!delta || delta.round !== facts.round || delta.complete !== true)
		return widened("delta-unusable");
	const owned = new Map<string, Set<string>>();
	for (const assignment of plan)
		for (const file of assignment.files)
			owned.set(file, (owned.get(file) ?? new Set()).add(assignment.role));
	const changed = delta.files.length;
	const substantive = delta.files.filter((file) => file.substantive);
	const baselineCount = baseline.files.length;
	const scoped = (
		reason: VerificationScopeReason,
		owners: ReadonlySet<string>,
		skipReason: VerificationRoleReason,
	): ReverificationDecision => {
		const selected = new Set([...owners, ...reported]);
		return {
			mode: "scoped",
			reason,
			threshold,
			touched: substantive.length,
			changed,
			baselineCount,
			reported,
			rerun: facts.eligibleRoles
				.filter((role) => selected.has(role))
				.map((role) => ({
					role,
					reason: (owners.has(role)
						? "owner-touched"
						: "findings-reported") as VerificationRoleReason,
				})),
			skipped: facts.eligibleRoles
				.filter((role) => !selected.has(role))
				.map((role) => ({ role, reason: skipReason })),
		};
	};
	// Below the minimum a fix opens no domain round — unless it was made to
	// resolve findings, in which case the roles that reported them still run. The
	// floor outranks the saving: a fix that resolved nothing the round can see is
	// exactly the case where a second look matters.
	if (substantive.length === 0 || substantive.length < threshold)
		return reported.length
			? scoped("findings-reported", new Set(), "below-minimum-diff")
			: {
					mode: "suite-only",
					reason: "below-minimum-diff",
					threshold,
					touched: substantive.length,
					changed,
					baselineCount,
					reported: [],
					rerun: [],
					skipped: facts.eligibleRoles.map((role) => ({
						role,
						reason: "below-minimum-diff" as const,
					})),
				};
	const owners = new Set<string>();
	for (const file of substantive) {
		const roles = owned.get(file.path);
		// No role claimed the file, so the plan cannot say who should look at it.
		if (!roles?.size) return widened("unowned-touched-file");
		// Several roles claimed it: widening is the only unambiguous answer.
		if (roles.size > 1) return widened("shared-touched-file");
		for (const role of roles) owners.add(role);
	}
	// An owner outside the eligible catalog (a definition whose traits dropped a
	// role, a plan from a differently-pinned definition) cannot be launched, so
	// the round widens rather than silently running fewer roles.
	const selected = new Set([...owners, ...reported]);
	const launchable = [...selected].filter((role) =>
		facts.eligibleRoles.includes(role),
	);
	if (launchable.length !== selected.size)
		return widened("unowned-touched-file");
	return scoped(
		owners.size ? "owner-touched" : "findings-reported",
		owners,
		"not-owner",
	);
}
