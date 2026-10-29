// Real process termination, not a thrown transaction callback: native admission
// must not survive partly committed after its writer disappears.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../src/workflow/runtime/store.ts";
import {
	canonicalStorePath,
	initializeStore,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

test("native commit never removes a foreign journal after the runtime directory is rebound", () => {
	const root = createTempRepoFixture(
		"schedule-journal-rebind-",
		repoPreset.readme,
	);
	initializeStore(root);
	const file = canonicalStorePath(root),
		directory = path.dirname(file),
		db = openStore(root);
	try {
		db.exec("BEGIN IMMEDIATE");
		db.query(
			"INSERT INTO workflow_scheduled_reservations(occurrence_id,workflow_id,content_digest,input_digest,definition_digest,input_json,created_at) VALUES (?,?,?,?,?,?,?)",
		).run(
			"rebind-fixture",
			"rebind-workflow",
			"a".repeat(64),
			"b".repeat(64),
			"c".repeat(64),
			"{}",
			"fixture",
		);
		// Rebind after the journal would have opened, not just before BEGIN. A
		// real-path DELETE-journal connection unlinks this unrelated sentinel at
		// COMMIT, even when native HAS_MOVED proved its identity before BEGIN.
		fs.renameSync(directory, `${directory}.pinned`);
		fs.mkdirSync(directory, { mode: 0o700 });
		const foreign = path.join(directory, `${path.basename(file)}-journal`);
		fs.writeFileSync(foreign, "foreign-journal-must-survive", { mode: 0o600 });
		try {
			db.exec("COMMIT");
		} catch {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* A path-security refusal is safe; touching the foreign file is not. */
			}
		}
		expect(fs.readFileSync(foreign, "utf8")).toBe(
			"foreign-journal-must-survive",
		);
	} finally {
		db.close();
	}
});

test("native reservation store recovers an interrupted commit atomically", async () => {
	const root = createTempRepoFixture("schedule-crash-", repoPreset.readme);
	initializeStore(root);
	const databaseFile = canonicalStorePath(root);
	const source = pathToFileURL(
		`${import.meta.dir}/../src/workflow/runtime/store.ts`,
	).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`import fs from 'node:fs'; import {openStore} from ${JSON.stringify(source)};
 const db=openStore(${JSON.stringify(root)});db.exec("PRAGMA cache_size=2; BEGIN IMMEDIATE");
 const insert=db.query("INSERT INTO workflow_scheduled_reservations(occurrence_id,workflow_id,content_digest,input_digest,definition_digest,input_json,created_at) VALUES (?,?,?,?,?,?,?)");
 for(let n=0;n<10000;n++)insert.run('crash-'+n,'workflow-'+n,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'x'.repeat(8192),'fixture');
 db.exec('COMMIT; BEGIN IMMEDIATE');
 db.query('UPDATE workflow_scheduled_reservations SET input_json=?').run('y'.repeat(8192));
 fs.writeSync(1,'READY-BEFORE-COMMIT\\n');await Bun.sleep(200);db.exec('COMMIT');await Bun.sleep(10000);`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		reader.releaseLock();
		expect(new TextDecoder().decode(first.value)).toContain(
			"READY-BEFORE-COMMIT",
		);
		// Observe an existing page being overwritten, not growth into previously
		// unused pages (which can leave the old image valid) or a timer that might
		// fire after COMMIT. All fixture payloads initially contain only x bytes.
		const offset = fs
			.readFileSync(databaseFile)
			.indexOf(Buffer.alloc(128, 120));
		expect(offset).toBeGreaterThan(0);
		const fd = fs.openSync(databaseFile, "r"),
			byte = Buffer.alloc(1);
		try {
			const deadline = Date.now() + 5000;
			do {
				fs.readSync(fd, byte, 0, 1, offset);
			} while (byte[0] !== 121 && Date.now() < deadline);
			expect(byte[0]).toBe(121);
			child.kill("SIGKILL");
			await child.exited;
		} finally {
			fs.closeSync(fd);
		}
		// Recovery is a native writer operation: a read-only observer must not
		// perform SQLite's hot-journal rollback behind the operator's back.
		const db = openStore(root);
		try {
			expect(db.query("PRAGMA integrity_check").all()).toEqual([
				{ integrity_check: "ok" },
			]);
			expect(
				db
					.query<{ n: number }, []>(
						"SELECT count(*) n FROM workflow_scheduled_reservations WHERE input_json LIKE 'y%'",
					)
					.get()?.n,
			).toBe(0);
		} finally {
			db.close();
		}
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
}, 15000);
