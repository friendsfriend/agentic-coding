// The re-verification scope decision (role-scoped re-verification): which
// verifier roles a round runs after a fix, and which of them are recorded as
// skipped and why. The decision is pure, so the whole table is pinned here —
// including every widening branch, because a widened round is only cheap if it
// is what actually happens when the attribution is unsure.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	VerificationScopeReason,
	VerificationScopeRecord,
} from "../src/contracts/workflow.ts";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import { DEFAULT_CONFIG } from "../src/workflow/effects.ts";
import {
	captureVerificationBaseline,
	measureVerificationDelta,
	minReverificationChangedFiles,
	observeVerificationTree,
	unionVerificationDelta,
} from "../src/workflow/runtime/reverification.ts";
import {
	DEFAULT_MIN_REVERIFICATION_CHANGED_FILES,
	decideReverification,
	decisionRecord,
	planRecord,
	reverificationRoles,
	withClassifierRoles,
} from "../src/workflow/steps/reverification.ts";

const ELIGIBLE = [
	"quality-verifier",
	"security-verifier",
	"test-quality-verifier",
];

/** A record for the round that just finished (`round: 1`), with the plan that
 * round asked for, the delta the fix measured against its tree, and the tree the
 * fix opens (`baseline.round: 2`). */
function record(
	overrides: Partial<VerificationScopeRecord> = {},
): VerificationScopeRecord {
	return {
		round: 1,
		plan: [
			{ role: "quality-verifier", files: ["src/a.ts"] },
			{ role: "security-verifier", files: ["src/b.ts"] },
		],
		baseline: {
			round: 2,
			complete: true,
			files: [
				{
					path: "src/a.ts",
					raw: "aaaaaaaaaaaaaaaa",
					normalized: "aaaaaaaaaaaaaaaa",
				},
				{
					path: "src/b.ts",
					raw: "bbbbbbbbbbbbbbbb",
					normalized: "bbbbbbbbbbbbbbbb",
				},
			],
		},
		delta: {
			round: 1,
			complete: true,
			threshold: 1,
			files: [{ path: "src/a.ts", substantive: true }],
		},
		...overrides,
	};
}

test("a first round is classifier-decided and records no scope", () => {
	const decision = decideReverification({ eligibleRoles: ELIGIBLE, round: 0 });
	expect(decision.mode).toBe("first-round");
	expect(decision.reason).toBe("no-previous-round");
	expect(decision.rerun).toEqual([]);
	expect(reverificationRoles(decision)).toEqual([]);
	expect(
		withClassifierRoles(decision, ELIGIBLE, ["quality-verifier"]).rerun,
	).toEqual([{ role: "quality-verifier", reason: "classifier-selected" }]);
	expect(
		withClassifierRoles(decision, ELIGIBLE, ["quality-verifier"]).skipped,
	).toEqual([
		{ role: "security-verifier", reason: "classifier-skipped" },
		{ role: "test-quality-verifier", reason: "classifier-skipped" },
	]);
});

test("the roles owning the fixed files are exactly the ones that rerun", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record(),
	});
	expect(decision.mode).toBe("scoped");
	expect(decision.reason).toBe("owner-touched");
	expect(decision.threshold).toBe(1);
	expect(decision.touched).toBe(1);
	expect(decision.changed).toBe(1);
	expect(decision.baselineCount).toBe(2);
	expect(reverificationRoles(decision)).toEqual(["quality-verifier"]);
	// Every eligible role is accounted for: the ones that run, and the ones that
	// do not with the reason they do not.
	expect(decision.rerun.map((entry) => entry.role)).toEqual([
		"quality-verifier",
	]);
	expect(decision.skipped).toEqual([
		{ role: "security-verifier", reason: "not-owner" },
		{ role: "test-quality-verifier", reason: "not-owner" },
	]);
});

test("a role that owns one of several fixed files reruns", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			delta: {
				round: 1,
				complete: true,
				threshold: 1,
				files: [
					{ path: "src/a.ts", substantive: true },
					{ path: "src/b.ts", substantive: true },
				],
			},
		}),
	});
	expect(decision.mode).toBe("scoped");
	expect(reverificationRoles(decision)).toEqual([
		"quality-verifier",
		"security-verifier",
	]);
});

test("a whitespace-only fix below the minimum opens the full suite only", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			delta: {
				round: 1,
				complete: true,
				threshold: 1,
				files: [{ path: "src/a.ts", substantive: false }],
			},
		}),
	});
	expect(decision.mode).toBe("suite-only");
	expect(decision.reason).toBe("below-minimum-diff");
	// The touched set is reported even though nothing substantive changed, so a
	// reader can tell a whitespace-only fix from a fix that changed nothing.
	expect(decision.touched).toBe(0);
	expect(decision.changed).toBe(1);
	expect(reverificationRoles(decision)).toEqual([]);
	expect(decision.skipped.map((entry) => entry.reason)).toEqual([
		"below-minimum-diff",
		"below-minimum-diff",
		"below-minimum-diff",
	]);
});

test("a fix that changed nothing at all opens the full suite only", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			delta: { round: 1, complete: true, threshold: 1, files: [] },
		}),
	});
	expect(decision.mode).toBe("suite-only");
	expect(decision.touched).toBe(0);
});

test("the threshold raises the bar for opening a domain round", () => {
	const two = record({
		delta: {
			round: 1,
			complete: true,
			threshold: 3,
			files: [
				{ path: "src/a.ts", substantive: true },
				{ path: "src/b.ts", substantive: true },
			],
		},
	});
	// The record's own threshold decides, because it is the one the runtime
	// stamped into the delta this round measured.
	expect(
		decideReverification({ eligibleRoles: ELIGIBLE, round: 1, record: two })
			.mode,
	).toBe("suite-only");
	// An explicit threshold (the configured one at decision time) wins over the
	// stamped one, so raising the configuration narrows an already-measured fix.
	expect(
		decideReverification({
			eligibleRoles: ELIGIBLE,
			round: 1,
			record: two,
			threshold: 1,
		}).mode,
	).toBe("scoped");
	// A threshold of zero still opens no domain round for a fix that changed
	// nothing at all: only a substantive change can be attributed to an owner.
	expect(
		decideReverification({
			eligibleRoles: ELIGIBLE,
			round: 1,
			record: record({
				delta: { round: 1, complete: true, threshold: 0, files: [] },
			}),
		}).mode,
	).toBe("suite-only");
	expect(DEFAULT_MIN_REVERIFICATION_CHANGED_FILES).toBe(1);
});

test("a fix whose owning role cannot be resolved widens to the full set", () => {
	// The plan names a role the definition no longer launches.
	const decision = decideReverification({
		eligibleRoles: ["security-verifier"],
		round: 1,
		record: record(),
	});
	expect(decision.mode).toBe("full-set");
	expect(decision.reason).toBe("unowned-touched-file");
	expect(decision.rerun).toEqual([]);
});

test("a file the plan gave to no role widens to the full set", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			delta: {
				round: 1,
				complete: true,
				threshold: 1,
				files: [{ path: "src/shared/registry.ts", substantive: true }],
			},
		}),
	});
	expect(decision.mode).toBe("full-set");
	expect(decision.reason).toBe("unowned-touched-file");
});

test("a file the plan gave to several roles widens to the full set", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			plan: [
				{ role: "quality-verifier", files: ["src/a.ts"] },
				{ role: "security-verifier", files: ["src/a.ts"] },
			],
		}),
	});
	expect(decision.mode).toBe("full-set");
	expect(decision.reason).toBe("shared-touched-file");
});

test("an unreadable or foreign measurement widens instead of guessing", () => {
	const cases: Array<
		[string, VerificationScopeRecord, VerificationScopeReason]
	> = [
		["no record", {} as VerificationScopeRecord, "no-previous-round"],
		["another round's record", record({ round: 2 }), "no-previous-round"],
		["a record with no plan", record({ plan: undefined }), "no-plan-ownership"],
		[
			"a plan with no files",
			record({ plan: [], round: 1 }),
			"no-plan-ownership",
		],
		[
			"an incomplete baseline",
			record({
				baseline: { round: 1, complete: false, files: [] },
			}),
			"baseline-unusable",
		],
		[
			"a baseline from another round",
			record({
				baseline: {
					round: 3,
					complete: true,
					files: [{ path: "src/a.ts", raw: "a", normalized: "a" }],
				},
			}),
			"baseline-unusable",
		],
		[
			"an incomplete delta",
			record({
				delta: { round: 1, complete: false, threshold: 1, files: [] },
			}),
			"delta-unusable",
		],
		[
			"a delta from another round",
			record({
				delta: {
					round: 2,
					complete: true,
					threshold: 1,
					files: [{ path: "src/a.ts", substantive: true }],
				},
			}),
			"delta-unusable",
		],
	];
	for (const [label, stored, reason] of cases) {
		const decision = decideReverification({
			eligibleRoles: ELIGIBLE,
			round: 1,
			record: stored,
		});
		expect(decision.mode, label).toBe("full-set");
		expect(decision.reason, label).toBe(reason);
		expect(decision.rerun, label).toEqual([]);
	}
});

test("the persisted record keeps the decision and its per-role reasons", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record(),
	});
	const stored = decisionRecord(decision, 2);
	expect(stored.round).toBe(2);
	expect(stored.mode).toBe("scoped");
	expect(stored.rerun).toEqual([
		{ role: "quality-verifier", reason: "owner-touched" },
	]);
	expect(stored.skipped).toHaveLength(2);
	// Storing it is a copy: a later decision cannot rewrite what was recorded.
	expect(stored.rerun).not.toBe(decision.rerun);
});

test("a plan beyond the record's file cap is recorded without ownership", () => {
	const files = Array.from({ length: 513 }, (_, index) => `src/f${index}.ts`);
	const truncated = planRecord([
		{ role: "quality-verifier", files: files.slice(0, 500) },
		{ role: "security-verifier", files: files.slice(500, 512) },
	]);
	expect(truncated.complete).toBe(true);
	expect(truncated.plan?.map((entry) => entry.files.length)).toEqual([500, 12]);
	// A plan the record cannot hold is recorded as *no* ownership rather than as
	// an omitted field: the record is merged field by field, so an omitted plan
	// would keep the previous round's ownership under this round's stamp.
	const overflow = planRecord([{ role: "quality-verifier", files }]);
	expect(overflow.complete).toBe(false);
	expect(overflow.plan).toEqual([]);
	// A path longer than the record can carry is not a path a round may scope
	// from, so the whole plan is unrecordable rather than half-written.
	const long = planRecord([
		{ role: "quality-verifier", files: [`src/${"a".repeat(1024)}.ts`] },
	]);
	expect(long.complete).toBe(false);
	expect(long.plan).toEqual([]);
	// A plan with more roles than the record holds is unrecordable too.
	const roles = Array.from({ length: 10 }, (_, index) => ({
		role: `verifier-${index}`,
		files: [`src/f${index}.ts`],
	}));
	expect(planRecord(roles).plan).toEqual([]);
});

test("a digest set only measures content, so reformatting is not a fix", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-"));
	try {
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
		fs.writeFileSync(path.join(root, "src", "b.ts"), "const b = 2;\n");
		const paths = ["src/a.ts", "src/b.ts"];
		const baseline = captureVerificationBaseline(
			observeVerificationTree(root, paths),
			1,
		);
		expect(baseline.complete).toBe(true);
		expect(baseline.files.map((entry) => entry.path)).toEqual(paths);
		expect(baseline.files[0]?.raw).toHaveLength(16);

		// A whitespace-only edit keeps the normalized digest and only moves the
		// raw one; a content edit moves both; a new file is substantive.
		fs.writeFileSync(path.join(root, "src", "a.ts"), "const a  =  1;\n");
		let delta = measureVerificationDelta(
			observeVerificationTree(root, paths),
			baseline,
			1,
			1,
		);
		expect(delta.complete).toBe(true);
		expect(delta.files).toEqual([{ path: "src/a.ts", substantive: false }]);

		fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 2;\n");
		fs.writeFileSync(path.join(root, "src", "c.ts"), "const c = 3;\n");
		delta = measureVerificationDelta(
			observeVerificationTree(root, [...paths, "src/c.ts"]),
			baseline,
			1,
			1,
		);
		expect(delta.files).toEqual([
			{ path: "src/a.ts", substantive: true },
			{ path: "src/c.ts", substantive: true },
		]);

		// A file the baseline holds but the tree no longer lists is a removal.
		fs.rmSync(path.join(root, "src", "b.ts"));
		delta = measureVerificationDelta(
			observeVerificationTree(root, ["src/a.ts", "src/c.ts"]),
			baseline,
			1,
			1,
		);
		expect(delta.files.some((entry) => entry.path === "src/b.ts")).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the engine's own store is never part of the measured tree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-store-"));
	try {
		fs.mkdirSync(path.join(root, ".herdr-workflow", "wf"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".herdr-workflow", "wf", "telemetry.jsonl"),
			"{}\n",
		);
		fs.writeFileSync(path.join(root, "src.ts"), "const a = 1;\n");
		const observed = observeVerificationTree(root, [
			".herdr-workflow/wf/telemetry.jsonl",
			"src.ts",
		]);
		// Engine bookkeeping changes on every step, so counting it as the fix
		// would widen every round and hide the optimization.
		expect(observed.files.map((entry) => entry.path)).toEqual(["src.ts"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable or oversized observation is an incomplete measurement", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-caps-"));
	try {
		fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
		expect(observeVerificationTree(root, ["big.bin"]).complete).toBe(false);
		const tooMany = Array.from({ length: 513 }, (_, index) => `f${index}.ts`);
		expect(observeVerificationTree(root, tooMany).complete).toBe(false);
		// A missing path the manifest still lists is a deletion the delta reports,
		// not an unmeasurable tree: a reserved digest pair records "this path is
		// not in the tree", which omission could not express.
		const observed = observeVerificationTree(root, ["gone.ts"]);
		expect(observed.complete).toBe(true);
		expect(observed.files).toEqual([
			{
				path: "gone.ts",
				raw: "0000000000000000",
				normalized: "0000000000000000",
			},
		]);
		// An incomplete observation can never produce a usable delta.
		const delta = measureVerificationDelta(
			{ complete: false, files: [] },
			{
				round: 1,
				complete: true,
				files: [{ path: "x.ts", raw: "x", normalized: "x" }],
			},
			1,
			1,
		);
		expect(delta.complete).toBe(false);
		expect(
			decideReverification({
				eligibleRoles: ELIGIBLE,
				round: 1,
				record: record({ delta }),
			}).mode,
		).toBe("full-set");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a role that reported a finding reruns whatever file the fix touched", () => {
	// The fix only touched `src/a.ts`, which `quality-verifier` owns, but the
	// round's findings came from `security-verifier`: the fix exists to resolve
	// them, so that role sees it too.
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({ reported: { round: 1, roles: ["security-verifier"] } }),
	});
	expect(decision.mode).toBe("scoped");
	expect(decision.reason).toBe("owner-touched");
	expect(reverificationRoles(decision)).toEqual([
		"quality-verifier",
		"security-verifier",
	]);
	expect(decision.rerun).toEqual([
		{ role: "quality-verifier", reason: "owner-touched" },
		{ role: "security-verifier", reason: "findings-reported" },
	]);
	expect(decision.skipped).toEqual([
		{ role: "test-quality-verifier", reason: "not-owner" },
	]);
});

test("a reported role reruns even when the fix is below the minimum diff", () => {
	const whitespaceOnly = record({
		reported: { round: 1, roles: ["security-verifier"] },
		delta: {
			round: 1,
			complete: true,
			threshold: 1,
			files: [{ path: "src/a.ts", substantive: false }],
		},
	});
	const scoped = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: whitespaceOnly,
	});
	// The floor outranks the saving: a fix that resolved nothing the delta can see
	// is exactly the round where a second look matters.
	expect(scoped.mode).toBe("scoped");
	expect(scoped.reason).toBe("findings-reported");
	expect(scoped.touched).toBe(0);
	expect(reverificationRoles(scoped)).toEqual(["security-verifier"]);
	expect(scoped.skipped).toEqual([
		{ role: "quality-verifier", reason: "below-minimum-diff" },
		{ role: "test-quality-verifier", reason: "below-minimum-diff" },
	]);
	// Without a reported role the same fix opens no domain round at all.
	const suiteOnly = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({
			delta: {
				round: 1,
				complete: true,
				threshold: 1,
				files: [{ path: "src/a.ts", substantive: false }],
			},
		}),
	});
	expect(suiteOnly.mode).toBe("suite-only");
	expect(suiteOnly.reason).toBe("below-minimum-diff");
	expect(reverificationRoles(suiteOnly)).toEqual([]);
});

test("a reported role the definition no longer offers widens the round", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({ reported: { round: 1, roles: ["usability-verifier"] } }),
	});
	// The role cannot be launched, so dropping it silently would leave the finding
	// it reported unverified: the round widens instead.
	expect(decision.mode).toBe("full-set");
	expect(decision.reason).toBe("reported-role-outside-catalog");
});

test("a reported role from another round is ignored", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 1,
		record: record({ reported: { round: 2, roles: ["security-verifier"] } }),
	});
	expect(decision.mode).toBe("scoped");
	expect(reverificationRoles(decision)).toEqual(["quality-verifier"]);
});

test("a classifier-decided round still reruns the roles that reported findings", () => {
	const decision = decideReverification({
		eligibleRoles: ELIGIBLE,
		round: 0,
	});
	const filled = withClassifierRoles(decision, ELIGIBLE, ["quality-verifier"]);
	expect(filled.rerun).toEqual([
		{ role: "quality-verifier", reason: "classifier-selected" },
	]);
	const reported = withClassifierRoles(
		{ ...decision, reported: ["security-verifier"] },
		ELIGIBLE,
		["quality-verifier"],
	);
	expect(reported.rerun).toEqual([
		{ role: "quality-verifier", reason: "classifier-selected" },
		{ role: "security-verifier", reason: "findings-reported" },
	]);
});

test("a deletion is a substantive change in both directions", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-delete-"));
	try {
		fs.writeFileSync(path.join(root, "keep.ts"), "const keep = 1;\n");
		fs.writeFileSync(path.join(root, "gone.ts"), "const gone = 1;\n");
		const baseline = captureVerificationBaseline(
			observeVerificationTree(root, ["keep.ts", "gone.ts"]),
			1,
		);
		fs.rmSync(path.join(root, "gone.ts"));
		const delta = measureVerificationDelta(
			observeVerificationTree(root, ["keep.ts", "gone.ts"]),
			baseline,
			1,
			1,
		);
		expect(delta.complete).toBe(true);
		expect(delta.files).toEqual([{ path: "gone.ts", substantive: true }]);
		// A path neither tree holds is not a change: the reserved deletion digest
		// makes "absent then" and "absent now" compare equal.
		const repeated = captureVerificationBaseline(
			observeVerificationTree(root, ["gone.ts"]),
			2,
		);
		expect(
			measureVerificationDelta(
				observeVerificationTree(root, ["gone.ts"]),
				repeated,
				2,
				1,
			).files,
		).toEqual([]);
		expect(repeated.files[0]?.raw).toBe("0000000000000000");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a path that leaves the worktree is never read", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-outside-"));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-symlink-"));
	try {
		fs.writeFileSync(path.join(outside, "secret.ts"), "const s = 1;\n");
		fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
		// An untracked symlink is in the changed-file manifest, so the measurement
		// must refuse it rather than digest a file outside the worktree.
		expect(observeVerificationTree(root, ["link.ts"]).complete).toBe(false);
		// A pathname that is not a regular file is unbounded (`/dev/zero` never
		// reaches EOF) and is refused the same way.
		if (process.platform !== "win32") {
			fs.symlinkSync("/dev/zero", path.join(root, "zero.ts"));
			expect(observeVerificationTree(root, ["zero.ts"]).complete).toBe(false);
		}
		// A relative path that climbs out of the worktree is refused before any
		// file-system call.
		expect(observeVerificationTree(root, ["../outside"]).complete).toBe(false);
		// An in-worktree symlink to an in-worktree file is a normal read.
		fs.writeFileSync(path.join(root, "real.ts"), "const r = 1;\n");
		fs.symlinkSync(path.join(root, "real.ts"), path.join(root, "alias.ts"));
		const observed = observeVerificationTree(root, ["alias.ts"]);
		expect(observed.complete).toBe(true);
		expect(observed.files[0]?.raw).toHaveLength(16);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("a path longer than the record can carry widens instead of failing", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverify-long-"));
	try {
		const long = `src/${"a".repeat(1024)}.ts`;
		expect(observeVerificationTree(root, [long])).toEqual({
			complete: false,
			files: [],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a second fix in the same round window folds into the round's delta", () => {
	const first = {
		round: 1,
		complete: true,
		threshold: 1,
		files: [{ path: "src/a.ts", substantive: true }],
	};
	const second = {
		round: 1,
		complete: true,
		threshold: 1,
		files: [{ path: "src/b.ts", substantive: true }],
	};
	expect(unionVerificationDelta(second, first).files).toEqual([
		{ path: "src/a.ts", substantive: true },
		{ path: "src/b.ts", substantive: true },
	]);
	// A file both measurements saw is substantive when either saw content change.
	expect(
		unionVerificationDelta(
			{ ...second, files: [{ path: "src/a.ts", substantive: false }] },
			first,
		).files,
	).toEqual([{ path: "src/a.ts", substantive: true }]);
	// A foreign round is not this round's delta; an incomplete measurement on
	// either side keeps the delta incomplete, which widens the round.
	expect(unionVerificationDelta(second, { ...first, round: 2 })).toBe(second);
	expect(
		unionVerificationDelta(second, { ...first, complete: false }).complete,
	).toBe(false);
	// The union is stamped with the measurement's own round and threshold.
	const union = unionVerificationDelta({ ...second, threshold: 3 }, first);
	expect(union.round).toBe(1);
	expect(union.threshold).toBe(3);
});

test("the minimum changed-file count is configuration with a bounded range", () => {
	const withThreshold = (value: number | undefined) =>
		minReverificationChangedFiles({
			...DEFAULT_CONFIG,
			workflow: {
				...DEFAULT_CONFIG.workflow,
				min_reverification_changed_files: value,
			},
		});
	expect(DEFAULT_CONFIG.workflow.min_reverification_changed_files).toBe(
		DEFAULT_MIN_REVERIFICATION_CHANGED_FILES,
	);
	expect(withThreshold(undefined)).toBe(1);
	expect(withThreshold(0)).toBe(0);
	expect(withThreshold(3)).toBe(3);
	for (const refused of [21, -1, 1.5]) {
		expect(() => withThreshold(refused)).toThrow(WorkflowRuntimeError);
		expect(() => withThreshold(refused)).toThrow(
			/min_reverification_changed_files/,
		);
	}
});
