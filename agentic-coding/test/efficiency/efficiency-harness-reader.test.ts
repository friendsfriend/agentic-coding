// Item 23 of the efficiency backlog: the harness reader and the empty-source
// alarm.
//
// Two things are pinned here.
//
// 1. A harness store copied into the snapshot without its `-shm`/`-wal`
//    companions still parses. The fixture is a real WAL-mode SQLite file built
//    in a temporary directory from the committed `.sql` fixture, then stripped
//    of both companions — never a committed binary blob. Plain SQLite cannot
//    read such a file read-only (that is the bug: `unable to open database
//    file`), so the reader opens it through `immutable=1` and the test asserts
//    both the row counts and that the fallback was the path taken.
//
// 2. A source file whose parse yields zero rows fails the dataset build with a
//    message naming it, unless its pattern is allow-listed.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	EMPTY_SOURCE_ALLOWLIST,
	type EmptySourceAllowEntry,
	findEmptySources,
	isEmptySourceAllowed,
	pathPatternToRegExp,
} from "../../scripts/efficiency/lib/empty-sources.ts";
import { extractTables } from "../../scripts/efficiency/lib/extract.ts";
import { readHarness } from "../../scripts/efficiency/lib/harness.ts";
import type { SourceFileRow } from "../../scripts/efficiency/lib/types.ts";
import { makeTempDir } from "./fixture.ts";

/** Every temp root this file creates, removed once the file's tests are done. */
const cleanups: Array<() => void> = [];

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "efficiency");
const PACKAGE_ROOT = path.join(import.meta.dir, "..", "..");
const BUILD = path.join(
	PACKAGE_ROOT,
	"scripts",
	"efficiency",
	"build-dataset.ts",
);

/**
 * Write a harness store the way the snapshot holds one: a WAL-mode SQLite file
 * whose `-shm` and `-wal` companions were not copied. The header keeps the WAL
 * write/read version, and every page is checkpointed into the main file first,
 * so what remains is exactly the frozen file the reader has to cope with.
 */
function writeSnapshotHarnessStore(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file, { create: true });
	try {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec(
			fs.readFileSync(
				path.join(FIXTURES, "sql", "orchestrator-harness.sql"),
				"utf8",
			),
		);
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
	for (const suffix of ["-wal", "-shm"])
		fs.rmSync(`${file}${suffix}`, { force: true });
}

/** An evidence root with a MANIFEST and nothing else yet. */
function makeEvidenceRoot(prefix: string): { path: string; cleanup(): void } {
	const root = makeTempDir(prefix);
	fs.writeFileSync(
		path.join(root.path, "MANIFEST.md"),
		"# synthetic\n\nA snapshot root for the harness reader and the empty-source alarm.\n",
	);
	return root;
}

interface BuildRun {
	exitCode: number;
	stderr: string;
	stdout: string;
	outDir: string;
	cleanup(): void;
}

/** Run the dataset build the way a developer would, in a child process. */
function runBuild(root: string, extraArgs: string[] = []): BuildRun {
	const out = makeTempDir("efficiency-build-out-");
	const child = Bun.spawnSync(
		[
			process.execPath,
			BUILD,
			"--evidence",
			root,
			"--out",
			out.path,
			"--quiet",
			...extraArgs,
		],
		// A neutral working directory: the tooling must not depend on the
		// package's own bunfig preload to run.
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	return {
		exitCode: child.exitCode ?? -1,
		stderr: child.stderr.toString(),
		stdout: child.stdout.toString(),
		outDir: out.path,
		cleanup: out.cleanup,
	};
}

describe("a harness store copied without its WAL companions", () => {
	let store: string;
	let root: { path: string; cleanup(): void };

	beforeAll(() => {
		const dir = makeTempDir("efficiency-wal-store-");
		cleanups.push(dir.cleanup);
		store = path.join(dir.path, "orchestrator", "harness.sqlite");
		writeSnapshotHarnessStore(store);
		root = makeEvidenceRoot("efficiency-wal-root-");
		cleanups.push(root.cleanup);
		fs.mkdirSync(path.join(root.path, "orchestrator"), { recursive: true });
		fs.copyFileSync(
			store,
			path.join(root.path, "orchestrator", "harness.sqlite"),
		);
	});

	test("the fixture is a WAL store with neither companion", () => {
		// Bytes 18/19 of a SQLite header are the write and read versions: 2 means
		// the database is in WAL mode, which is why a read-only open needs the
		// shared-memory index that the snapshot does not copy.
		expect([...fs.readFileSync(store).subarray(18, 20)]).toEqual([2, 2]);
		expect(fs.existsSync(`${store}-wal`)).toBe(false);
		expect(fs.existsSync(`${store}-shm`)).toBe(false);
		// Plain SQLite refuses exactly this file read-only — the failure the
		// repair is about — and the failed attempt leaves no companion behind.
		let message = "";
		try {
			const db = new Database(store, { readonly: true });
			try {
				db.query("select count(*) as n from sqlite_master").get();
			} finally {
				db.close();
			}
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("unable to open database file");
		expect(fs.readdirSync(path.dirname(store))).toEqual(["harness.sqlite"]);
	});

	test("parses the transcript instead of reporting zero rows", () => {
		const read = readHarness(store);
		expect(read.stats.records).toBe(5);
		expect(read.stats.parsed).toBe(5);
		expect(read.stats.skipped).toBe(0);
		expect(read.conversations).toHaveLength(1);
		const conversation = read.conversations[0];
		expect(conversation?.label).toBe("orchestrator");
		expect(conversation?.turns).toHaveLength(2);
		expect(conversation?.toolResults.size).toBe(1);
		expect(conversation?.compactions).toHaveLength(1);
		expect(conversation?.turns[0]?.toolCalls.map((call) => call.tool)).toEqual([
			"list_workflows",
		]);
		expect(conversation?.turns[0]?.stopReason).toBe("toolUse");
		// The note names the fallback, so a future SQLite that opens the file
		// read-only after all is visible in the snapshot rather than silent.
		expect(read.stats.notes.join("; ")).toContain("immutable=1");
	});

	test("extracts the turns and calls, and no longer notes the store as unreadable", () => {
		const tables = extractTables({ evidenceDir: root.path }).tables;
		const sourceFile = tables.sourceFiles.find(
			(file) => file.kind === "harness",
		);
		expect(sourceFile?.path).toBe("orchestrator/harness.sqlite");
		expect(sourceFile?.records).toBe(5);
		expect(sourceFile?.parsed).toBe(5);
		expect(sourceFile?.note).not.toContain("unreadable");
		expect(sourceFile?.note).toContain("1 conversation(s)");
		expect(tables.turns).toHaveLength(2);
		expect(
			tables.turns.every((turn) => turn.source === "harness.orchestrator"),
		).toBe(true);
		expect(tables.toolCalls).toHaveLength(1);
		expect(tables.toolCalls[0]?.tool).toBe("list_workflows");
		expect(tables.toolCalls[0]?.result_bytes).toBeGreaterThan(0);
		// The repaired reader leaves nothing for the gap query to report.
		expect(findEmptySources(tables.sourceFiles)).toEqual([]);
	});
});

describe("the empty-source allow-list", () => {
	const row = (
		source: SourceFileRow["source"],
		filePath: string,
		parsed = 0,
	): SourceFileRow => ({
		source,
		path: filePath,
		kind: "harness",
		records: parsed,
		parsed,
		skipped: 0,
	});

	test("matches a path segment with `*` and any depth with `**`", () => {
		expect(
			pathPatternToRegExp("worktrees/*/harness.sqlite").test(
				"worktrees/a/harness.sqlite",
			),
		).toBe(true);
		expect(
			pathPatternToRegExp("worktrees/*/harness.sqlite").test(
				"worktrees/a/b/harness.sqlite",
			),
		).toBe(false);
		expect(
			pathPatternToRegExp("main-store/**").test("main-store/telemetry/x.jsonl"),
		).toBe(true);
		expect(pathPatternToRegExp("**/*.jsonl").test("a/b/c.jsonl")).toBe(true);
	});

	test("clears an allow-listed empty source and keeps every other one", () => {
		const files = [
			row("harness.worktree", "worktrees/empty-wf/harness.sqlite"),
			row("telemetry.worktree", "worktrees/empty-wf/telemetry.jsonl"),
			row("harness.wiki", "wiki-workflows/harness.sqlite", 12),
		];
		expect(findEmptySources(files)).toHaveLength(2);

		const allowlist: EmptySourceAllowEntry[] = [
			{
				path: "worktrees/*/harness.sqlite",
				source: "harness.worktree",
				reason: "the agent host writes the store before its first turn",
			},
		];
		expect(findEmptySources(files, allowlist)).toEqual([files[1]]);
		// The same pattern must not clear the telemetry file of that worktree:
		// the source narrows the entry.
		expect(isEmptySourceAllowed(files[1], allowlist)).toBe(false);
	});

	test("the committed allow-list starts empty", () => {
		// A pinned-snapshot rebuild parses every file it ships; an entry here
		// silences the alarm for a shape of file and needs a reason.
		expect(EMPTY_SOURCE_ALLOWLIST).toEqual([]);
	});
});

describe("the dataset build fails on a source that parsed nothing", () => {
	let root: { path: string; cleanup(): void };
	let emptyFile: string;

	beforeAll(() => {
		root = makeEvidenceRoot("efficiency-empty-source-");
		cleanups.push(root.cleanup);
		const telemetryDir = path.join(root.path, "main-store", "telemetry");
		fs.mkdirSync(telemetryDir, { recursive: true });
		emptyFile = path.join(telemetryDir, "empty-wf.jsonl");
		fs.writeFileSync(emptyFile, "");
	});

	test("exits non-zero and names the file, and writes no dataset", () => {
		const run = runBuild(root.path);
		try {
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain("parsed into zero rows");
			expect(run.stderr).toContain("main-store/telemetry/empty-wf.jsonl");
			expect(run.stderr).toContain("--allow-empty");
			expect(fs.existsSync(path.join(run.outDir, "dataset.sqlite"))).toBe(
				false,
			);
			expect(run.stdout).toBe("");
		} finally {
			run.cleanup();
		}
	});

	test("a pattern that matches the file clears it, and an unrelated one does not", () => {
		const allowed = runBuild(root.path, [
			"--allow-empty",
			"main-store/telemetry/empty-wf.jsonl",
		]);
		try {
			expect(allowed.exitCode).toBe(0);
			const dataset = path.join(allowed.outDir, "dataset.sqlite");
			expect(fs.existsSync(dataset)).toBe(true);
			// The empty file keeps its row — it is a recorded gap, not a failure.
			const db = new Database(dataset, { readonly: true });
			try {
				const rows = db
					.query<{ path: string; records: number; parsed: number }, []>(
						"SELECT path, records, parsed FROM source_files WHERE path LIKE '%empty-wf.jsonl'",
					)
					.all();
				expect(rows).toEqual([
					{
						path: "main-store/telemetry/empty-wf.jsonl",
						records: 0,
						parsed: 0,
					},
				]);
			} finally {
				db.close();
			}
		} finally {
			allowed.cleanup();
		}

		const unrelated = runBuild(root.path, [
			"--allow-empty",
			"worktrees/*/telemetry.jsonl",
		]);
		try {
			expect(unrelated.exitCode).toBe(1);
			expect(unrelated.stderr).toContain("main-store/telemetry/empty-wf.jsonl");
		} finally {
			unrelated.cleanup();
		}
	});
});

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});
