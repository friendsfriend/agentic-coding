// The env-setup promotion (`add-environment-setup-workflow`, task 3.4): atomic
// writes into the live configuration with a protected backup, a catalog reload,
// and a full rollback when any part of it fails.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupDraftsDir } from "../src/server/environment/setup-drafts.ts";
import {
	promoteSetupDrafts,
	type SetupPromotionIo,
	setupPromotionJournalPath,
	setupPromotionLockPath,
} from "../src/server/environment/setup-promote.ts";

/** The run identity and journal secret every fixture promotion uses. */
const RUN_ID = "2026-01-01T00:00:00.000Z";
const SECRET = "promotion-secret";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

/** Every file of a tree with its content, so a rollback can be compared. */
function snapshot(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string, relative: string): void => {
		for (const entry of fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const child = path.join(dir, entry.name);
			const childRelative =
				relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) walk(child, childRelative);
			else files[childRelative] = fs.readFileSync(child, "utf8");
		}
	};
	walk(root, "");
	return files;
}

function scenario() {
	const configDir = tempDir("env-setup-promote-");
	// The drafts directory is the one the workflow's own pin resolves: the
	// promotion refuses a directory outside the configuration's drafts root.
	const draftsDir = setupDraftsDir(configDir, "wf-1");
	const backupDir = tempDir("env-setup-promote-backup-");
	writeFile(
		path.join(configDir, "apps", "compose", "shop-compose.yml"),
		"live-a\n",
	);
	writeFile(path.join(configDir, "apps", "run", "shop-api.sh"), "live-b\n");
	writeFile(
		path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
		"draft-a\n",
	);
	writeFile(path.join(draftsDir, "apps", "run", "shop-api.sh"), "draft-b\n");
	writeFile(path.join(draftsDir, "apps", "run", "shop-worker.sh"), "draft-c\n");
	return { configDir, draftsDir, backupDir };
}

describe("promotion", () => {
	test("approved drafts replace and add files, with a backup of every replaced one", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		let reloaded = 0;
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			reload: () => {
				reloaded += 1;
			},
		});
		expect(result.ok).toBe(true);
		expect(reloaded).toBe(1);
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("draft-a\n");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "run", "shop-worker.sh"),
				"utf8",
			),
		).toBe("draft-c\n");
		expect(
			fs.readFileSync(
				path.join(backupDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("live-a\n");
		expect(
			fs.readFileSync(
				path.join(backupDir, "apps", "run", "shop-api.sh"),
				"utf8",
			),
		).toBe("live-b\n");
		expect(
			fs.existsSync(path.join(backupDir, "apps", "run", "shop-worker.sh")),
		).toBe(false);
		// The promoted drafts are moved aside, so the workflow's own overlay can
		// no longer shadow the files it just published.
		expect(fs.existsSync(draftsDir)).toBe(false);
		expect(
			fs.existsSync(
				path.join(configDir, ".drafts", "env-setup", "wf-1.promoted"),
			),
		).toBe(true);
	});

	test("a write failure on the third of three files restores the live configuration", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const before = snapshot(configDir);
		let writes = 0;
		const io: Partial<SetupPromotionIo> = {
			writeFile: (filePath, content) => {
				// Backups are written first: only the live writes are counted.
				if (!filePath.startsWith(backupDir)) {
					writes += 1;
					if (writes === 3) throw new Error("disk full");
				}
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, content);
			},
		};
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io,
		});
		expect(result.ok).toBe(false);
		expect(result.rolledBack).toBe(true);
		expect(result.error).toContain("disk full");
		expect(snapshot(configDir)).toEqual(before);
		// The drafts stay where they were: nothing was promoted, so the workflow
		// keeps its overlay for the retry the developer decides on.
		expect(fs.existsSync(draftsDir)).toBe(true);
	});

	test("a rejected reload rolls the live configuration back", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const before = snapshot(configDir);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			reload: () => {
				throw new Error("catalog refused the reload");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("catalog refused the reload");
		expect(snapshot(configDir)).toEqual(before);
	});
});

// Replay, serialization and layout boundaries the verification round named
// (`add-environment-setup-workflow`): the promotion is re-executable, so it must
// converge instead of compounding, and it must never publish a path the
// configuration does not define.
describe("promotion replay and boundaries", () => {
	test("a replay after an interrupted promotion never rewrites the original backup", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const backupPath = path.join(
			backupDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		// The first attempt writes everything and then dies before the drafts move
		// (the exact window a lease re-claim resumes from).
		const crashed = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				moveDirectory: () => {
					throw new Error("interrupted");
				},
			},
		});
		expect(crashed.ok).toBe(true);
		expect(crashed.draftsMoved).toBe(false);
		expect(fs.readFileSync(backupPath, "utf8")).toBe("live-a\n");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("draft-a\n");

		// The re-claimed row runs the same promotion again.
		const replay = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(replay.ok).toBe(true);
		expect(replay.draftsMoved).toBe(true);
		// The protected backup is still the pre-promotion content, not the draft.
		expect(fs.readFileSync(backupPath, "utf8")).toBe("live-a\n");
	});

	test("a second promotion into the same configuration root is refused while the lock is held", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const lockPath = setupPromotionLockPath(configDir);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			`${JSON.stringify({ workflowId: "other", at: Date.now() })}\n`,
		);
		const refused = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain("owns");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("live-a\n");

		// A lock a crashed promotion left behind is stolen once it is stale (its
		// own mtime), so a dead run cannot block every future promotion.
		const stale = Date.now() / 1000 - 60 * 60;
		fs.utimesSync(lockPath, stale, stale);
		const promoted = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(promoted.ok).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test("a rollback leaves a path another actor replaced alone and says so", async () => {
		const configDir = tempDir("env-setup-promote-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const backupDir = tempDir("env-setup-promote-backup-");
		for (const name of ["a.sh", "b.sh", "c.sh"]) {
			writeFile(path.join(draftsDir, "apps", "run", name), `draft ${name}\n`);
		}
		const foreign = "another workflow promoted this\n";
		let interfered = false;
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeFile: (filePath, content, mode) => {
					// The promotion writes a temporary sibling and renames it, so the
					// failure has to be injected on that write.
					if (path.basename(filePath).startsWith("c.sh"))
						throw new Error("disk full");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(
						filePath,
						content,
						mode === undefined ? undefined : { mode },
					);
				},
				rename: (from, to) => {
					fs.renameSync(from, to);
					// Another actor replaces the path this promotion just published,
					// in the window before the promotion's own failure.
					if (path.basename(to) === "a.sh" && !interfered) {
						interfered = true;
						fs.writeFileSync(to, foreign);
					}
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.error).toContain("rollback incomplete");
		// The other actor's content survives; the path this promotion added and
		// still owned is removed.
		expect(
			fs.readFileSync(path.join(configDir, "apps", "run", "a.sh"), "utf8"),
		).toBe(foreign);
		expect(fs.existsSync(path.join(configDir, "apps", "run", "b.sh"))).toBe(
			false,
		);
	});

	test("a replaced file keeps its mode and its backup stays private", async () => {
		const configDir = tempDir("env-setup-promote-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const backupDir = tempDir("env-setup-promote-backup-");
		const live = path.join(configDir, "apps", "compose", "shop-compose.yml");
		writeFile(live, "live-a\n");
		fs.chmodSync(live, 0o600);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			"draft-a\n",
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(result.ok).toBe(true);
		expect(fs.statSync(live).mode & 0o777).toBe(0o600);
		expect(
			fs.statSync(path.join(backupDir, "apps", "compose", "shop-compose.yml"))
				.mode & 0o777,
		).toBe(0o600);
	});

	test("a draft outside the configuration layout is refused before anything is written", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		writeFile(path.join(draftsDir, ".env"), "SHOP_TOKEN=secret\n");
		const before = snapshot(configDir);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("outside the configuration layout");
		expect(result.error).toContain(".env");
		expect(snapshot(configDir)).toEqual(before);
	});

	test("a missing drafts directory fails closed, and a completed promotion reports itself", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		fs.rmSync(draftsDir, { recursive: true, force: true });
		const missing = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(missing.ok).toBe(false);
		expect(missing.error).toContain("is missing");

		const {
			configDir: freshConfig,
			draftsDir: freshDrafts,
			backupDir: freshBackup,
		} = scenario();
		const promoted = await promoteSetupDrafts({
			configDir: freshConfig,
			draftsDir: freshDrafts,
			backupDir: freshBackup,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(promoted.ok).toBe(true);
		expect(promoted.alreadyPromoted).toBe(false);
		expect(fs.existsSync(freshDrafts)).toBe(false);
		// The journal records the plan, and the completed promotion is recognisable
		// from it after the drafts are gone.
		const journal = JSON.parse(
			fs.readFileSync(setupPromotionJournalPath(freshBackup), "utf8"),
		) as { complete: boolean; entries: Array<{ path: string }> };
		expect(journal.complete).toBe(true);
		expect(journal.entries.map((entry) => entry.path)).toEqual([
			"apps/compose/shop-compose.yml",
			"apps/run/shop-api.sh",
			"apps/run/shop-worker.sh",
		]);
		const replay = await promoteSetupDrafts({
			configDir: freshConfig,
			draftsDir: freshDrafts,
			backupDir: freshBackup,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(replay.alreadyPromoted).toBe(true);
		expect(replay.ok).toBe(true);
	});
});

// Round-2 findings: the promotion's state under `.backups` is untrusted, the
// lock is owned by a token and kept fresh, and a rollback covers everything the
// promotion's own run changed (`add-environment-setup-workflow`).
describe("promotion provenance and ownership", () => {
	test("a foreign file at the canonical backup path is not trusted as the original", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		// A file the promotion did not write, planted where its backup would go.
		writeFile(
			path.join(backupDir, "apps", "compose", "shop-compose.yml"),
			"forged\n",
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeFile: (filePath, content, mode) => {
					if (path.basename(filePath).startsWith("shop-worker.sh"))
						throw new Error("disk full");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(
						filePath,
						content,
						mode === undefined ? undefined : { mode },
					);
				},
			},
		});
		expect(result.ok).toBe(false);
		// The restored file is the reviewed original, never the planted content.
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("live-a\n");
	});

	test("a planted journal with no entries never reports a promotion", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		fs.rmSync(draftsDir, { recursive: true, force: true });
		writeFile(
			setupPromotionJournalPath(backupDir),
			// Hand-written: no authentication tag, so it is not this run's plan.
			`${JSON.stringify({
				version: 1,
				workflowId: "wf-1",
				runId: "",
				complete: true,
				movePending: false,
				entries: [],
			})}\n`,
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.alreadyPromoted).toBe(false);
		expect(result.error).toContain("is missing");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("live-a\n");
	});

	test("a later failure rolls back what an earlier attempt of the same run wrote", async () => {
		const configDir = tempDir("env-setup-promote-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const backupDir = tempDir("env-setup-promote-backup-");
		writeFile(path.join(draftsDir, "apps", "run", "a.sh"), "draft a\n");
		writeFile(path.join(draftsDir, "apps", "run", "b.sh"), "draft b\n");
		// Attempt 1 applies both paths and dies before the drafts move.
		const interrupted = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				moveDirectory: () => {
					throw new Error("interrupted");
				},
			},
		});
		expect(interrupted.ok).toBe(true);
		expect(interrupted.draftsMoved).toBe(false);
		expect(
			fs.readFileSync(path.join(configDir, "apps", "run", "a.sh"), "utf8"),
		).toBe("draft a\n");
		// Attempt 2 (the re-claimed row) sees them already promoted and fails on a
		// new path: the whole promotion comes back, not just attempt 2's slice.
		writeFile(path.join(draftsDir, "apps", "run", "c.sh"), "draft c\n");
		const failed = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeFile: (filePath, content, mode) => {
					if (path.basename(filePath).startsWith("c.sh"))
						throw new Error("disk full");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(
						filePath,
						content,
						mode === undefined ? undefined : { mode },
					);
				},
			},
		});
		expect(failed.ok).toBe(false);
		expect(failed.rolledBack).toBe(true);
		expect(fs.existsSync(path.join(configDir, "apps", "run", "a.sh"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(configDir, "apps", "run", "b.sh"))).toBe(
			false,
		);
	});

	test("losing the root aborts the promotion and leaves the thief's lock alone", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const lockPath = setupPromotionLockPath(configDir);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeAtomic: (filePath, payload, mode) => {
					fs.writeFileSync(filePath, payload, { mode });
					// Another promotion steals the root mid-write.
					if (
						filePath === lockPath &&
						!fs.readFileSync(filePath, "utf8").includes("thief")
					)
						fs.writeFileSync(
							lockPath,
							`${JSON.stringify({
								workflowId: "other",
								token: "thief",
								at: Date.now(),
							})}\n`,
						);
				},
			},
		});
		// Losing the lock stops the writes (it does not race the winner): the
		// promotion that stole the root owns the live configuration now, so its own
		// rollback (or its completed promotion) is the corrective action and this
		// attempt must not write stale bytes over it. The failure is retryable —
		// the outbox owns the backoff — and the thief keeps the lock it took.
		expect(result.ok).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("took the configuration root");
		expect(result.error).toContain("left to the promotion that owns the root");
		expect(fs.readFileSync(lockPath, "utf8")).toContain("thief");
	});

	test("a lock whose payload cannot be parsed counts as held", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const lockPath = setupPromotionLockPath(configDir);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		// A torn payload from a refresh in flight is not proof that the lock is
		// dead: the holder's own mtime decides, and it is fresh.
		fs.writeFileSync(lockPath, '{"workflowId":"other","token":');
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("owns");
		expect(fs.readFileSync(lockPath, "utf8")).toBe(
			'{"workflowId":"other","token":',
		);
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("live-a\n");
	});

	test("a journal this workflow did not write is ignored", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		// A plan (and a backup) planted under `.backups`, a directory outside both
		// the write guard's coverage and the approval gate's view, claiming a
		// replacement whose "original" is content nobody reviewed.
		writeFile(
			path.join(backupDir, "apps", "compose", "postgres.json"),
			'{"planted":true}\n',
		);
		writeFile(
			setupPromotionJournalPath(backupDir),
			`${JSON.stringify({
				version: 1,
				workflowId: "wf-1",
				runId: RUN_ID,
				complete: false,
				movePending: false,
				entries: [
					{
						path: "apps/compose/postgres.json",
						status: "added",
						writtenDigest: "0".repeat(64),
					},
				],
				directories: [],
				mac: "not-this-run",
			})}\n`,
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
		});
		// The fraudulent entry changed nothing: the run promoted its own drafts,
		// and the planted journal is not what its own plan was built from.
		expect(result.ok).toBe(true);
		expect(result.files.map((file) => file.path)).toEqual([
			"apps/compose/shop-compose.yml",
			"apps/run/shop-api.sh",
			"apps/run/shop-worker.sh",
		]);
		expect(
			fs.existsSync(path.join(configDir, "apps", "compose", "postgres.json")),
		).toBe(false);
	});

	test("the plan is on disk before the live file it describes", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const journalPath = setupPromotionJournalPath(backupDir);
		const compose = path.join(configDir, "apps", "compose", "shop-compose.yml");
		let journalWhenPublishing = "";
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				rename: (from, to) => {
					if (to === compose)
						journalWhenPublishing = fs.readFileSync(journalPath, "utf8");
					fs.renameSync(from, to);
				},
			},
		});
		expect(result.ok).toBe(true);
		// The entry (and the backup it names) preceded the write, so a kill in
		// between leaves a record the re-attempt can trust.
		expect(journalWhenPublishing).toContain("apps/compose/shop-compose.yml");
		expect(journalWhenPublishing).toContain("backupDigest");
	});

	test("a rollback removes the directories the promotion created", async () => {
		const configDir = tempDir("env-setup-promote-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const backupDir = tempDir("env-setup-promote-backup-");
		writeFile(path.join(draftsDir, "apps", "run", "shop-dev.sh"), "echo dev\n");
		writeFile(
			path.join(draftsDir, "infrastructure", "compose", "extra.yml"),
			"services: {}\n",
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeFile: (filePath, content, mode) => {
					if (filePath.includes("extra.yml")) throw new Error("disk full");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(
						filePath,
						content,
						mode === undefined ? undefined : { mode },
					);
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(result.rolledBack).toBe(true);
		// The tree is as it was: no empty `apps/` left behind by the attempt.
		expect(fs.existsSync(path.join(configDir, "apps"))).toBe(false);
		expect(fs.existsSync(path.join(configDir, "infrastructure"))).toBe(false);
	});

	test("the lock is refreshed while the promotion writes", async () => {
		const { configDir, draftsDir, backupDir } = scenario();
		const refreshes: string[] = [];
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-1",
			runId: RUN_ID,
			secret: SECRET,
			io: {
				writeAtomic: (filePath, payload, mode) => {
					if (filePath === setupPromotionLockPath(configDir))
						refreshes.push(payload);
					fs.writeFileSync(filePath, payload, { mode });
				},
			},
		});
		expect(result.ok).toBe(true);
		// One refresh per promoted path: a live-but-slow promotion is never
		// stolen from, because staleness means "no progress".
		expect(refreshes.length).toBeGreaterThanOrEqual(3);
	});
});
