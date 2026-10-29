import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSchedulingDatabase } from "../src/server/scheduling/database.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";
import { openSecureDatabase } from "../src/workflow/native/database.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../src/workflow/secure-fs.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-secure-"));
	roots.push(root);
	const directory = path.join(root, "scheduling");
	const store = SchedulingStore.open(directory);
	const filename = store.filename;
	store.close();
	return { root, directory, filename };
}
const job = {
	name: "fixture",
	task: "report only",
	originalInstruction: "report only",
	reason: "test",
	references: [],
	reportingDestination: "transcript",
	target: {
		kind: "wake-up" as const,
		hostId: "host",
		hostSocket: "/fixture",
		conversationId: "conversation",
		runId: "orchestrator",
	},
};

test("scheduler establishes a fresh nested config root through private directory capabilities", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-fresh-"));
	roots.push(root);
	const directory = path.join(root, "new-config", "nested", "scheduling"),
		store = SchedulingStore.open(directory);
	try {
		for (const entry of [
			path.join(root, "new-config"),
			path.join(root, "new-config", "nested"),
			directory,
		])
			expect(fs.statSync(entry).mode & 0o777).toBe(0o700);
		expect(fs.statSync(store.filename).mode & 0o777).toBe(0o600);
	} finally {
		store.close();
	}
});

test("scheduler refuses non-private directories and files without fixing their permissions", () => {
	for (const target of ["directory", "main"]) {
		const f = fixture(),
			file = target === "directory" ? f.directory : f.filename;
		const before = fs.readFileSync(f.filename);
		fs.chmodSync(file, target === "directory" ? 0o755 : 0o644);
		expect(() => SchedulingStore.open(f.directory)).toThrow("private");
		expect(fs.statSync(file).mode & 0o777).toBe(
			target === "directory" ? 0o755 : 0o644,
		);
		expect(fs.readFileSync(f.filename)).toEqual(before);
	}
});

test("scheduler refuses substituted directories, symlink mains and hardlink mains before SQLite access", () => {
	for (const kind of ["directory", "symlink", "hardlink"]) {
		const f = fixture(),
			victim = path.join(f.root, "victim");
		fs.mkdirSync(victim, { mode: 0o700 });
		const foreign = path.join(victim, "scheduling.sqlite");
		fs.copyFileSync(f.filename, foreign);
		fs.chmodSync(foreign, 0o600);
		const before = fs.readFileSync(foreign);
		if (kind === "directory") {
			fs.rmSync(f.directory, { recursive: true });
			fs.symlinkSync(victim, f.directory);
		} else {
			fs.unlinkSync(f.filename);
			if (kind === "symlink") fs.symlinkSync(foreign, f.filename);
			else fs.linkSync(foreign, f.filename);
		}
		expect(() => SchedulingStore.open(f.directory)).toThrow();
		expect(fs.readFileSync(foreign)).toEqual(before);
		expect(fs.statSync(foreign).mode & 0o777).toBe(0o600);
	}
});

test("all scheduler sidecar names refuse symlinks, hardlinks and foreign modes without truncation", () => {
	for (const suffix of ["-journal", "-wal", "-shm"]) {
		for (const kind of ["symlink", "hardlink", "mode"]) {
			const f = fixture(),
				sidecar = f.filename + suffix,
				victim = path.join(f.root, "victim");
			fs.writeFileSync(victim, "foreign bytes", { mode: 0o600 });
			fs.rmSync(sidecar, { force: true });
			if (kind === "symlink") fs.symlinkSync(victim, sidecar);
			else if (kind === "hardlink") fs.linkSync(victim, sidecar);
			else fs.writeFileSync(sidecar, "foreign bytes", { mode: 0o644 });
			expect(() => SchedulingStore.open(f.directory)).toThrow();
			expect(fs.readFileSync(victim, "utf8")).toBe("foreign bytes");
			if (kind === "mode")
				expect(fs.readFileSync(sidecar, "utf8")).toBe("foreign bytes");
		}
	}
});

test("an open scheduler connection never truncates a replaced journal", () => {
	const f = fixture(),
		store = SchedulingStore.open(f.directory),
		victim = path.join(f.root, "victim"),
		journal = `${f.filename}-journal`;
	try {
		// Pin the original journal in this connection before replacing its name.
		store.createJob(job, 0);
		fs.writeFileSync(victim, "preserve replacement", { mode: 0o600 });
		fs.renameSync(victim, journal);
		expect(() => store.createJob({ ...job, name: "later" }, 1)).toThrow();
		expect(fs.readFileSync(journal, "utf8")).toBe("preserve replacement");
	} finally {
		store.close();
	}
});

test("a supported private WAL draft converts to durable rollback mode without losing rows", () => {
	const f = fixture(),
		legacy = new Database(f.filename);
	try {
		legacy.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES ('preserved')",
		);
	} finally {
		legacy.close();
	}
	const { db } = openSchedulingDatabase(f.directory);
	try {
		expect(
			db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
				?.journal_mode,
		).toBe("truncate");
		expect(
			db.query<{ value: string }, []>("SELECT value FROM legacy_marker").get()
				?.value,
		).toBe("preserved");
	} finally {
		db.close();
	}
});

test("workflow and scheduling basenames cannot borrow one another's native root or sidecars", () => {
	const f = fixture(),
		directory = openSecureDirectory(f.directory, f.root, false);
	const workflowFile = path.join(f.directory, "herdr.db");
	fs.writeFileSync(workflowFile, "", { mode: 0o600 });
	const main = openSecureFile(directory, "herdr.db", fs.constants.O_RDWR);
	let workflow: Database | undefined, scheduling: Database | undefined;
	try {
		expect(() =>
			openSecureDatabase(directory, main, false, "scheduling.sqlite"),
		).toThrow("capability mismatch");
		workflow = openSecureDatabase(directory, main, false);
		workflow.exec(
			"PRAGMA journal_mode=TRUNCATE; CREATE TABLE workflow_marker(value TEXT); INSERT INTO workflow_marker VALUES ('workflow')",
		);
		scheduling = openSchedulingDatabase(f.directory).db;
		expect(
			scheduling
				.query("SELECT name FROM sqlite_master WHERE name='workflow_marker'")
				.get(),
		).toBeNull();
		expect(
			workflow.query("SELECT name FROM sqlite_master WHERE name='jobs'").get(),
		).toBeNull();
		for (const basename of [
			"../herdr.db",
			"scheduling.sqlite-journal",
			"other.db",
		])
			expect(() =>
				Reflect.apply(openSecureDatabase, undefined, [
					directory,
					main,
					false,
					basename,
				]),
			).toThrow("Unsupported");
	} finally {
		scheduling?.close();
		workflow?.close();
		fs.closeSync(main);
		closeSecureDirectory(directory);
	}
});

test("scheduler recovers a genuine hot rollback journal after abrupt process death", () => {
	const f = fixture();
	const module = path.resolve(
		import.meta.dir,
		"../src/server/scheduling/database.ts",
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import {openSchedulingDatabase} from ${JSON.stringify(module)};const {db}=openSchedulingDatabase(process.argv[1]);db.exec("CREATE TABLE crash_probe(value BLOB); PRAGMA cache_size=1; BEGIN IMMEDIATE; INSERT INTO crash_probe SELECT randomblob(4096) FROM json_each('[1,2,3,4,5,6,7,8,9,10]')");process.kill(process.pid,'SIGKILL');`,
			f.directory,
		],
		{ env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.success).toBe(false);
	expect(fs.statSync(`${f.filename}-journal`).size).toBeGreaterThan(0);
	const { db } = openSchedulingDatabase(f.directory);
	try {
		expect(
			db.query<{ n: number }, []>("SELECT count(*) n FROM crash_probe").get()
				?.n,
		).toBe(0);
		expect(
			db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
				?.integrity_check,
		).toBe("ok");
	} finally {
		db.close();
	}
});
