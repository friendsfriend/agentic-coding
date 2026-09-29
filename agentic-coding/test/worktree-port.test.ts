// Worktree port: layout, worktrunk argv, reply decoding, failure
// classification, and a live worktrunk run (introduce-worktree-port, tasks
// 1.2-1.4).
//
// The argv assertions pin what the adapter asks worktrunk for; the live run
// pins what worktrunk actually does, because a mocked argv assertion would not
// have caught the multiplexer bug this port replaces (Luvus silently forking a
// branch from the wrong commit).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import { resolveActiveWorktreePath } from "../src/server/environment/config.ts";
import {
	classifyWorktreeFailure,
	MIN_WORKTRUNK_VERSION,
	meetsMinimumVersion,
	parseWorktrunkVersion,
} from "../src/worktree/cli.ts";
import { validateWorktrunk, WorktreeAdapter } from "../src/worktree/index.ts";
import { WorktreeError } from "../src/worktree/port.ts";
import {
	linkedWorktreePath,
	primaryWorktreePath,
	sanitizeBranch,
	worktreePathConfig,
	worktreeTemplate,
} from "../src/worktree/template.ts";

type EnsureInput = Parameters<WorktreeAdapter["ensure"]>[0];
type RemoveInput = Parameters<WorktreeAdapter["remove"]>[0];

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
	Effect.runPromise(effect);

/** The adapter's availability check runs before the first operation; the argv
 * assertions below are about the operation itself, so it is not recorded. */
const VERSION_OUTPUT = `wt v${MIN_WORKTRUNK_VERSION}`;

/** An adapter whose subprocess is replaced by a scripted reply per command. */
function scripted(
	reply: (argv: readonly string[]) => {
		stdout?: string;
		error?: WorktreeError;
	},
): { adapter: WorktreeAdapter; calls: string[][] } {
	const calls: string[][] = [];
	const adapter = new WorktreeAdapter({
		runner: (argv) => {
			if (argv.includes("--version")) return Effect.succeed(VERSION_OUTPUT);
			calls.push([...argv]);
			const scriptedReply = reply(argv);
			return scriptedReply.error
				? Effect.fail(scriptedReply.error)
				: Effect.succeed(scriptedReply.stdout ?? "{}");
		},
	});
	return { adapter, calls };
}

const LIST_REPLY = JSON.stringify({
	schema: 2,
	items: [
		{
			branch: "main",
			worktree: { path: "/repo", main: true, detached: false },
		},
		{
			branch: "feature/x",
			worktree: { path: "/repo/feature-x", main: false, detached: false },
		},
	],
});

describe("worktree layout", () => {
	test("the shared template is the environment layer's own directory naming", () => {
		// The environment layer must not change layout: `$DEVENV_HOME/{ident}/
		// {ident}.<sanitized branch>` is what the integration fixtures pin, and
		// that layer now resolves its paths through this same template.
		expect(sanitizeBranch("feature/x")).toBe("feature-x");
		expect(sanitizeBranch("feature\\x")).toBe("feature-x");
		expect(sanitizeBranch("plain")).toBe("plain");
		expect(
			resolveActiveWorktreePath(
				"/home/u/.devenv",
				{
					ident: "api",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				},
				() => true,
			),
		).toBe(linkedWorktreePath("/home/u/.devenv", "api", "feature/x"));
		expect(
			resolveActiveWorktreePath(
				"/home/u/.devenv",
				{
					ident: "api",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				},
				() => false,
			),
		).toBe(primaryWorktreePath("/home/u/.devenv", "api"));
		expect(linkedWorktreePath("/home/u/.devenv", "api", "feature/x")).toBe(
			"/home/u/.devenv/api/api.feature-x",
		);
		expect(primaryWorktreePath("/home/u/.devenv", "api")).toBe(
			"/home/u/.devenv/api/api",
		);
		expect(worktreeTemplate("/home/u/.devenv", "api")).toBe(
			"/home/u/.devenv/api/api.{{ branch | sanitize }}",
		);
	});

	test("the config value is one quoted TOML assignment", () => {
		expect(worktreePathConfig("/home/u/.devenv", "api")).toBe(
			'worktree-path="/home/u/.devenv/api/api.{{ branch | sanitize }}"',
		);
		expect(worktreePathConfig('/tmp/odd"dir', "api")).toBe(
			'worktree-path="/tmp/odd\\"dir/api/api.{{ branch | sanitize }}"',
		);
	});
});

describe("worktree argv", () => {
	test("list asks worktrunk for structured output", async () => {
		const { adapter, calls } = scripted(() => ({ stdout: LIST_REPLY }));
		const refs = await run(adapter.list("/repo"));
		expect(
			refs.map((ref) => `${ref.branch}|${ref.path}|${ref.isMain}`),
		).toEqual(["main|/repo|true", "feature/x|/repo/feature-x|false"]);
		expect(calls[0]).toEqual(["wt", "-C", "/repo", "list", "--format", "json"]);
	});

	test("ensure carries the layout and the automation flags", async () => {
		const { adapter, calls } = scripted(() => ({
			stdout: JSON.stringify({
				action: "existing",
				branch: "feature/x",
				path: "/repo/feature-x",
			}),
		}));
		const ref = await run(
			adapter.ensure({
				repo: "/repo",
				branch: "feature/x",
				location: { root: "/home/u/.devenv", ident: "api" },
			} satisfies EnsureInput),
		);
		expect(ref.created).toBe(false);
		expect(calls[0]).toEqual([
			"wt",
			"-C",
			"/repo",
			"--config-set",
			'worktree-path="/home/u/.devenv/api/api.{{ branch | sanitize }}"',
			"switch",
			"feature/x",
			"--no-cd",
			"--no-hooks",
			"-y",
			"--format",
			"json",
		]);
	});

	test("an explicit path overrides the layout template", async () => {
		const { adapter, calls } = scripted(() => ({
			stdout: JSON.stringify({
				action: "created",
				branch: "feature/x",
				path: "/srv/wt",
				created_branch: false,
			}),
		}));
		await run(
			adapter.ensure({
				repo: "/repo",
				branch: "feature/x",
				path: "/srv/wt",
				location: { root: "/home/u/.devenv", ident: "api" },
			}),
		);
		// A template with no variables is a constant: the caller's path wins.
		expect(calls[0]?.[4]).toBe('worktree-path="/srv/wt"');
	});

	test("a base creates the branch first and reports the creation", async () => {
		const { adapter, calls } = scripted(() => ({
			stdout: JSON.stringify({
				action: "created",
				branch: "feature/wf-1",
				path: "/repo/feature-wf-1",
				created_branch: true,
			}),
		}));
		const ref = await run(
			adapter.ensure({
				repo: "/repo",
				branch: "feature/wf-1",
				base: "abc123",
			}),
		);
		expect(ref.created).toBe(true);
		// argv[3] is the subcommand: there is no --config-set without a location.
		expect(calls[0]?.slice(3)).toEqual([
			"switch",
			"--create",
			"--base",
			"abc123",
			"feature/wf-1",
			"--no-cd",
			"--no-hooks",
			"-y",
			"--format",
			"json",
		]);
	});

	test("a branch that already exists falls back to reusing its worktree", async () => {
		let attempt = 0;
		const { adapter, calls } = scripted(() => {
			attempt += 1;
			return attempt === 1
				? {
						error: new WorktreeError(
							"conflict",
							"wt switch failed (exit 1): Branch wf-1 already exists",
						),
					}
				: {
						stdout: JSON.stringify({
							action: "existing",
							branch: "wf-1",
							path: "/repo/wf-1",
						}),
					};
		});
		const ref = await run(
			adapter.ensure({ repo: "/repo", branch: "wf-1", base: "abc123" }),
		);
		expect(ref.path).toBe("/repo/wf-1");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("--create");
		expect(calls[1]).not.toContain("--create");
	});

	test("removal keeps the branch, and force and reap are opt-in", async () => {
		const keep = scripted((argv) =>
			argv.includes("list") ? { stdout: LIST_REPLY } : { stdout: "[]" },
		);
		await run(
			keep.adapter.remove({
				repo: "/repo",
				branch: "feature/x",
			} satisfies RemoveInput),
		);
		expect(keep.calls[1]).toEqual([
			"wt",
			"-C",
			"/repo",
			"remove",
			"feature/x",
			"--no-delete-branch",
			"--no-hooks",
			"-y",
			"--format",
			"json",
		]);

		const forced = scripted((argv) =>
			argv.includes("list") ? { stdout: LIST_REPLY } : { stdout: "[]" },
		);
		await run(
			forced.adapter.remove({
				repo: "/repo",
				path: "/repo/feature-x",
				force: true,
				deleteBranch: true,
				reap: true,
			} satisfies RemoveInput),
		);
		expect(forced.calls[1]).toContain("--force");
		expect(forced.calls[1]).toContain("--reap");
		expect(forced.calls[1]).not.toContain("--no-delete-branch");
	});

	test("the primary worktree is refused with the port's own diagnostic", async () => {
		const { adapter } = scripted(() => ({ stdout: LIST_REPLY }));
		const outcome = await run(
			Effect.either(adapter.remove({ repo: "/repo", branch: "main" })),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) {
			expect(outcome.left.kind).toBe("conflict");
			expect(outcome.left.message).toContain(
				"cannot remove the primary worktree",
			);
		}
	});

	test("an unknown branch is confirmed absence, not a transport failure", async () => {
		const { adapter } = scripted(() => ({ stdout: LIST_REPLY }));
		expect(await run(adapter.find("/repo", "nope"))).toBeUndefined();
		const outcome = await run(
			Effect.either(adapter.remove({ repo: "/repo", branch: "nope" })),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) expect(outcome.left.kind).toBe("absent");
	});

	test("an unexpected reply shape is bounded, never silently defaulted", async () => {
		const { adapter } = scripted(() => ({ stdout: "not json" }));
		const outcome = await run(Effect.either(adapter.list("/repo")));
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) {
			expect(outcome.left.kind).toBe("invalid-response");
			expect(outcome.left.message).toContain("invalid JSON");
		}
	});
});

describe("worktree failure classification", () => {
	test("conflicts are permanent and transport failures are transient", () => {
		expect(classifyWorktreeFailure("Branch feature already exists")).toBe(
			"conflict",
		);
		expect(classifyWorktreeFailure("fatal: not a git repository")).toBe(
			"conflict",
		);
		expect(classifyWorktreeFailure("cannot remove the main worktree")).toBe(
			"conflict",
		);
		expect(classifyWorktreeFailure("ENOENT: wt not found")).toBe("unavailable");
		expect(classifyWorktreeFailure("index.lock: file exists")).toBe(
			"unavailable",
		);
		expect(classifyWorktreeFailure("effect ownership was lost")).toBe(
			"ownership-lost",
		);
	});

	test("the version floor is compared part by part", () => {
		expect(parseWorktrunkVersion("wt v0.80.0")).toEqual([0, 80, 0]);
		expect(parseWorktrunkVersion("no version here")).toBeUndefined();
		expect(meetsMinimumVersion([0, 80, 0], "0.80.0")).toBe(true);
		expect(meetsMinimumVersion([0, 80, 1], "0.80.0")).toBe(true);
		expect(meetsMinimumVersion([1, 0, 0], "0.80.0")).toBe(true);
		expect(meetsMinimumVersion([0, 79, 9], "0.80.0")).toBe(false);
	});

	test("presence is re-checked on every run, not decided once", async () => {
		// The adapter memoizes this effect, so an eager presence check would keep
		// answering "worktrunk is missing" after it was installed (the failure
		// that stranded a running shell on this machine).
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktrunk-check-"));
		const bin = path.join(root, "fake wt");
		try {
			const validation = validateWorktrunk({ binPath: bin });
			const missing = await run(Effect.either(validation));
			expect(Either.isLeft(missing)).toBe(true);
			if (Either.isLeft(missing)) {
				expect(missing.left.kind).toBe("unavailable");
				expect(missing.left.message).toContain("on PATH");
			}
			fs.writeFileSync(bin, `#!/bin/sh\necho wt v${MIN_WORKTRUNK_VERSION}\n`);
			fs.chmodSync(bin, 0o755);
			expect(await run(Effect.either(validation))).toEqual(
				Either.right(undefined),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Live worktrunk run: what worktrunk actually does, not what we asked for.
// ---------------------------------------------------------------------------

describe.skipIf(Bun.which("wt") === null)(
	"worktree port against the installed worktrunk",
	() => {
		test("create-from-base, reuse, primary reuse and removal", async () => {
			// macOS resolves the temporary directory (`/var` -> `/private/var`), and
			// the adapter normalizes every path it reports.
			const root = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "worktree-port-")),
			);
			const git = (cwd: string, args: string[]) => {
				const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0)
					throw new Error(
						`git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
					);
				return result.stdout.toString().trim();
			};
			try {
				const origin = path.join(root, "origin.git");
				const repo = path.join(root, "demo", "demo");
				fs.mkdirSync(path.dirname(repo), { recursive: true });
				git(root, ["init", "-q", "--bare", "-b", "main", origin]);
				git(root, ["clone", "-q", origin, repo]);
				git(repo, ["config", "user.email", "a@b.c"]);
				git(repo, ["config", "user.name", "a"]);
				fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
				git(repo, ["add", "f.txt"]);
				git(repo, ["commit", "-qm", "c1"]);
				const base = git(repo, ["rev-parse", "HEAD"]);
				fs.appendFileSync(path.join(repo, "f.txt"), "two\n");
				git(repo, ["commit", "-qam", "c2"]);

				const adapter = new WorktreeAdapter({ binPath: "wt" });
				const location = { root, ident: "demo" };

				// 1. A new branch starts at the requested base, not at HEAD.
				const created = await run(
					adapter.ensure({
						repo,
						branch: "feature/from-base",
						base,
						location,
					}),
				);
				expect(created.created).toBe(true);
				expect(created.path).toBe(
					linkedWorktreePath(root, "demo", "feature/from-base"),
				);
				expect(git(created.path, ["rev-parse", "HEAD"])).toBe(base);

				// 2. A second ensure reuses the same worktree.
				const reused = await run(
					adapter.ensure({
						repo,
						branch: "feature/from-base",
						base,
						location,
					}),
				);
				expect(reused.created).toBe(false);
				expect(reused.path).toBe(created.path);

				// 3. A branch checked out in the primary worktree resolves to it, and
				// the check is exact even when the caller names a linked worktree.
				const primary = await run(
					adapter.ensure({ repo, branch: "main", location }),
				);
				expect(primary.isMain).toBe(true);
				expect(created.isMain).toBe(false);
				const fromLinked = await run(
					adapter.ensure({
						repo: created.path,
						branch: "main",
						location,
					}),
				);
				expect(fromLinked.isMain).toBe(true);
				expect(fromLinked.path).toBe(primary.path);

				// 4. Removal keeps the branch.
				await run(adapter.remove({ repo, branch: "feature/from-base" }));
				expect(git(repo, ["branch", "--list", "feature/from-base"])).toContain(
					"feature/from-base",
				);
				expect(
					await run(adapter.find(repo, "feature/from-base")),
				).toBeUndefined();
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
