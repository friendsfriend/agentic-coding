import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { initializeStore, openStore } from "../src/workflow/runtime/store.ts";
import { canonicalStorePath } from "../src/workflow/runtime/targets.ts";
import {
	createTempRepoFixture,
	removeRepoFixture,
} from "./support/git-fixture.ts";

const source = pathToFileURL(
	path.resolve(import.meta.dir, "../src/workflow/runtime/store.ts"),
).href;
function fixture() {
	const root = createTempRepoFixture("secure-sqlite-");
	initializeStore(root);
	return root;
}

test("closing another native connection does not release a writer's kernel lock", () => {
	const root = fixture();
	const writer = openStore(root),
		other = openStore(root);
	try {
		writer.exec("BEGIN IMMEDIATE");
		other.close();
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import {openStore} from ${JSON.stringify(source)};const db=openStore(${JSON.stringify(root)});db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');process.exitCode=20;}catch(error){if(error.code!=='SQLITE_BUSY')throw error;}finally{db.close();}`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		expect(probe.exitCode, probe.stderr.toString()).toBe(0);
		const standard = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(canonicalStorePath(root))});db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');process.exitCode=20;}catch(error){if(error.code!=='SQLITE_BUSY')throw error;}finally{db.close();}`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		expect(standard.exitCode, standard.stderr.toString()).toBe(0);
		writer.exec("ROLLBACK");
	} finally {
		writer.close();
		other.close();
		removeRepoFixture(root);
	}
});

test("closing an unrelated guard cannot release another reader's shared lock", () => {
	const root = fixture();
	const reader = openStore(root),
		other = openStore(root),
		writer = openStore(root);
	try {
		writer.exec(
			"CREATE TABLE secure_lock_probe(value TEXT); PRAGMA busy_timeout=0",
		);
		reader.exec("BEGIN");
		reader.query("SELECT * FROM secure_lock_probe").all();
		other.close();
		writer.exec(
			"BEGIN IMMEDIATE; INSERT INTO secure_lock_probe VALUES ('uncommitted')",
		);
		expect(() => writer.exec("COMMIT")).toThrow("locked");
		writer.exec("ROLLBACK");
		reader.exec("ROLLBACK");
	} finally {
		writer.close();
		reader.close();
		other.close();
		removeRepoFixture(root);
	}
});

test("DELETE-mode cleanup refuses a replaced journal inode, preserving foreign bytes", () => {
	const root = fixture();
	const db = openStore(root);
	const journal = `${canonicalStorePath(root)}-journal`;
	const sentinel = Buffer.from(
		"foreign journal, not owned by the active transaction",
	);
	try {
		db.exec(
			"CREATE TABLE secure_sidecar_probe(value TEXT); PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; INSERT INTO secure_sidecar_probe VALUES ('pending')",
		);
		fs.renameSync(journal, `${journal}.owned`);
		fs.writeFileSync(journal, sentinel, { mode: 0o600 });
		expect(() => db.exec("COMMIT")).toThrow();
		expect(fs.readFileSync(journal)).toEqual(sentinel);
	} finally {
		db.close();
		expect(fs.readFileSync(journal)).toEqual(sentinel);
		removeRepoFixture(root);
	}
});

for (const kind of ["symlink", "hardlink"] as const) {
	test(`sidecar ${kind} is refused without modifying its foreign target`, () => {
		const root = fixture(),
			file = canonicalStorePath(root),
			journal = `${file}-journal`;
		const foreign = path.join(root, "foreign"),
			sentinel = Buffer.from("foreign target bytes");
		try {
			fs.writeFileSync(foreign, sentinel, { mode: 0o600 });
			fs.rmSync(journal, { force: true });
			if (kind === "symlink") fs.symlinkSync(foreign, journal);
			else fs.linkSync(foreign, journal);
			expect(() => openStore(root)).toThrow();
			expect(fs.readFileSync(foreign)).toEqual(sentinel);
		} finally {
			removeRepoFixture(root);
		}
	});
}

test("native writer recovers an actually uncheckpointed legacy WAL without a shared-memory path", () => {
	const root = fixture(),
		file = canonicalStorePath(root);
	try {
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(file)});db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE secure_wal_probe(value TEXT); INSERT INTO secure_wal_probe VALUES ('committed')");process.kill(process.pid,'SIGKILL');`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		expect(probe.exitCode).not.toBe(0);
		expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
		const db = openStore(root);
		try {
			expect(db.query("SELECT value FROM secure_wal_probe").all()).toEqual([
				{ value: "committed" },
			]);
			expect(db.query("PRAGMA integrity_check").get()).toEqual({
				integrity_check: "ok",
			});
		} finally {
			db.close();
		}
		expect(fs.readFileSync(file).subarray(18, 20).toString("hex")).toBe("0101");
	} finally {
		removeRepoFixture(root);
	}
});

test("concurrent worker VFS registrations survive worker termination and reopening", async () => {
	const root = fixture();
	try {
		for (let wave = 0; wave < 2; wave++)
			await Promise.all(
				Array.from(
					{ length: 3 },
					(_, id) =>
						new Promise<void>((resolve, reject) => {
							const worker = new Worker(
								new URL("./support/secure-sqlite-smoke.ts", import.meta.url),
								{ workerData: { root, id: `${wave}-${id}` } },
							);
							let observed = false;
							worker.on("message", (message) => {
								observed = message === "ok";
							});
							worker.on("error", reject);
							worker.on("exit", (code) => {
								if (code === 0 && observed) resolve();
								else
									reject(
										new Error(
											`Native worker failed: ${code}, acknowledgement=${observed}`,
										),
									);
							});
						}),
				),
			);
		const db = openStore(root);
		try {
			expect(
				db.query("SELECT count(*) AS count FROM secure_worker_probe").get(),
			).toEqual({ count: 6 });
		} finally {
			db.close();
		}
	} finally {
		removeRepoFixture(root);
	}
}, 30_000);

test("a compiled executable embeds the native VFS and needs no external runtime compiler", () => {
	const root = fixture(),
		binary = path.join(root, "native-smoke");
	try {
		const build = Bun.spawnSync(
			[
				process.execPath,
				"build",
				"--compile",
				"--outfile",
				binary,
				path.resolve(import.meta.dir, "support/secure-sqlite-smoke.ts"),
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		expect(build.exitCode, build.stderr.toString()).toBe(0);
		const run = Bun.spawnSync([binary, root], {
			cwd: root,
			env: { ...process.env, CC: path.join(root, "no-runtime-compiler") },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const db = openStore(root);
		try {
			expect(db.query("SELECT value FROM secure_worker_probe").all()).toEqual([
				{ value: "compiled" },
			]);
		} finally {
			db.close();
		}
	} finally {
		removeRepoFixture(root);
	}
}, 30_000);
