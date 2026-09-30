import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { pruneFileJudgments } from "../src/workflow/classifiers.ts";
import {
	type FileSignalSweepDeps,
	fileSignalSweep,
} from "../src/workflow/effect-runner.ts";

// The sweep's own work is `deps`; every case here injects them, so nothing
// touches a repository, a classifier endpoint, or the filesystem. The snapshot
// is only passed through, which is what makes a bare object sufficient.
const SNAPSHOT = { workflowId: "wf-1", revision: 4 } as never;

interface Harness {
	readonly deps: FileSignalSweepDeps;
	readonly calls: string[];
	readonly judged: Array<Record<string, unknown>>;
}

function harness(overrides: Partial<FileSignalSweepDeps> = {}): Harness {
	const calls: string[] = [];
	const judged: Array<Record<string, unknown>> = [];
	const base = {
		agents: (() => ({
			profiles: {},
			file_judgment: { enabled: true },
		})) as unknown as FileSignalSweepDeps["agents"],
		provider: (() => "laya-local") as FileSignalSweepDeps["provider"],
		collect: (async () => {
			calls.push("collect");
			return {
				candidates: [
					{ path: "src/a.ts", content: "export async function a() {}" },
				],
				skipped: [],
			};
		}) as FileSignalSweepDeps["collect"],
		judge: ((...args: unknown[]) => {
			calls.push("judge");
			judged.push(args[3] as Record<string, unknown>);
			return Effect.succeed(
				pruneFileJudgments([{ path: "src/a.ts", noul: 0.9 }], []),
			);
		}) as unknown as FileSignalSweepDeps["judge"],
		write: ((filePath: string) => {
			calls.push("write");
			return { path: filePath, digest: "digest" };
		}) as FileSignalSweepDeps["write"],
		path: (() => "/tmp/file-signals/r4.md") as FileSignalSweepDeps["path"],
	} satisfies FileSignalSweepDeps;
	return { deps: { ...base, ...overrides }, calls, judged };
}

function run(deps: FileSignalSweepDeps) {
	return Effect.runPromise(fileSignalSweep(SNAPSHOT, undefined, deps));
}

describe("per-file judgment sweep", () => {
	test("a disabled sweep reads nothing at all", async () => {
		const h = harness({
			agents: (() => ({
				profiles: {},
				file_judgment: { enabled: false },
			})) as unknown as FileSignalSweepDeps["agents"],
		});
		expect(await run(h.deps)).toBeUndefined();
		expect(h.calls).toEqual([]);
	});

	test("a configuration with no file_judgment table stays disabled", async () => {
		const h = harness({
			agents: (() => ({
				profiles: {},
			})) as unknown as FileSignalSweepDeps["agents"],
		});
		expect(await run(h.deps)).toBeUndefined();
		expect(h.calls).toEqual([]);
	});

	test("an enabled sweep with no changed files makes no classifier call", async () => {
		const h = harness({
			collect: (async () => {
				h.calls.push("collect");
				return { candidates: [], skipped: [] };
			}) as FileSignalSweepDeps["collect"],
		});
		expect(await run(h.deps)).toBeUndefined();
		expect(h.calls).toEqual(["collect"]);
	});

	test("a successful sweep returns the artifact reference", async () => {
		const h = harness();
		expect(await run(h.deps)).toEqual({
			path: "/tmp/file-signals/r4.md",
			digest: "digest",
		});
		expect(h.calls).toEqual(["collect", "judge", "write"]);
	});

	test("configured bounds reach the classifier call", async () => {
		const h = harness({
			agents: (() => ({
				profiles: {},
				file_judgment: {
					enabled: true,
					threshold: 0.75,
					unsure: 0.3,
					concurrency: 2,
				},
			})) as unknown as FileSignalSweepDeps["agents"],
		});
		await run(h.deps);
		expect(h.judged[0]?.thresholds).toEqual({ flag: 0.75, unsure: 0.3 });
		expect(h.judged[0]?.concurrency).toBe(2);
	});

	test("defaults apply when the configuration sets no bounds", async () => {
		const h = harness();
		await run(h.deps);
		expect(h.judged[0]?.thresholds).toEqual({ flag: 0.7, unsure: 0.25 });
		expect(h.judged[0]?.concurrency).toBeUndefined();
	});

	test("a classifier outage yields no reference instead of blocking the round", async () => {
		const h = harness({
			judge: (() => {
				h.calls.push("judge");
				return Effect.fail(new Error("classifier unavailable"));
			}) as unknown as FileSignalSweepDeps["judge"],
		});
		expect(await run(h.deps)).toBeUndefined();
		// The artifact is never written from a failed sweep: a stale or empty
		// section would read to a verifier as a real result.
		expect(h.calls).toEqual(["collect", "judge"]);
	});

	test("an unwritable artifact yields no reference", async () => {
		const h = harness({
			write: (() => {
				throw new Error("EACCES");
			}) as FileSignalSweepDeps["write"],
		});
		expect(await run(h.deps)).toBeUndefined();
	});

	test("a collect failure yields no reference", async () => {
		const h = harness({
			collect: (async () => {
				throw new Error("git failed");
			}) as FileSignalSweepDeps["collect"],
		});
		expect(await run(h.deps)).toBeUndefined();
	});
});
