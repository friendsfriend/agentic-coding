import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readGitBranches,
	readGitRemotes,
	readGitWorktrees,
} from "../src/adapters/process/git-actions.ts";
import { createGitActionService } from "../src/services/git-action-service.ts";

test("git actions guard dirty state, switch branches and manage worktrees", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-actions-")),
	);
	const remote = path.join(root, "remote.git");
	const repository = path.join(root, "repo");
	const clone = path.join(root, "clone");
	const linked = path.join(root, "linked");
	const git = (cwd: string, ...args: string[]) => {
		const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
	};
	const signal = new AbortController().signal;
	const service = createGitActionService();
	try {
		fs.mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(root, "init", "--initial-branch=main", repository);
		git(repository, "config", "user.name", "Fixture");
		git(repository, "config", "user.email", "fixture@example.invalid");
		fs.writeFileSync(path.join(repository, "tracked.txt"), "one\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "--quiet", "-m", "initial");
		git(repository, "remote", "add", "origin", remote);
		git(repository, "push", "--quiet", "-u", "origin", "main");
		git(repository, "branch", "feature");

		const initial = await readGitBranches(repository, signal);
		expect(initial.current).toBe("main");
		expect(initial.branches.map((branch) => branch.name)).toEqual([
			"main",
			"feature",
		]);
		const checkout = await service.run(
			repository,
			{ action: "checkout", branch: "feature" },
			signal,
		);
		expect(checkout.status).toBe("completed");
		expect((await readGitBranches(repository, signal)).current).toBe("feature");

		fs.writeFileSync(path.join(repository, "untracked.txt"), "dirty\n");
		const refused = await service.run(
			repository,
			{ action: "checkout", branch: "main" },
			signal,
		);
		expect(refused).toMatchObject({
			status: "refused",
			reason: "dirty-worktree",
		});
		fs.rmSync(path.join(repository, "untracked.txt"));

		const added = await service.run(
			repository,
			{ action: "worktree-add", path: linked, branch: "main", create: false },
			signal,
		);
		expect(added.status).toBe("completed");
		const worktrees = await readGitWorktrees(repository, signal);
		expect(worktrees.worktrees.map((entry) => entry.path)).toEqual([
			repository,
			linked,
		]);
		fs.writeFileSync(path.join(linked, "dirty.txt"), "dirty\n");
		const dirtyRemoval = await service.run(
			repository,
			{ action: "worktree-remove", path: linked },
			signal,
		);
		expect(dirtyRemoval).toMatchObject({
			status: "refused",
			reason: "dirty-worktree",
		});
		fs.rmSync(path.join(linked, "dirty.txt"));
		const currentRemoval = await service.run(
			repository,
			{ action: "worktree-remove", path: repository },
			signal,
		);
		expect(currentRemoval).toMatchObject({
			status: "refused",
			reason: "current-worktree",
		});
		const removed = await service.run(
			repository,
			{ action: "worktree-remove", path: linked },
			signal,
		);
		expect(removed.status).toBe("completed");
		expect(fs.existsSync(linked)).toBe(false);

		const created = await service.run(
			repository,
			{
				action: "worktree-add",
				path: linked,
				branch: "worktree-new",
				create: true,
			},
			signal,
		);
		expect(created.status).toBe("completed");
		expect(
			(await readGitBranches(repository, signal)).branches.some(
				(branch) => branch.name === "worktree-new",
			),
		).toBe(true);
		expect(
			(
				await service.run(
					repository,
					{ action: "worktree-remove", path: linked },
					signal,
				)
			).status,
		).toBe("completed");
		const deleted = await service.run(
			repository,
			{ action: "branch-delete", branch: "worktree-new" },
			signal,
		);
		expect(deleted.status).toBe("completed");
		expect(
			(await readGitBranches(repository, signal)).branches.some(
				(branch) => branch.name === "worktree-new",
			),
		).toBe(false);
		const currentDelete = await service.run(
			repository,
			{ action: "branch-delete", branch: "feature" },
			signal,
		);
		expect(currentDelete).toMatchObject({
			status: "refused",
			reason: "current-branch",
		});

		expect((await readGitRemotes(repository, signal)).remotes[0]?.name).toBe(
			"origin",
		);
		const addedRemote = await service.run(
			repository,
			{ action: "remote-add", name: "mirror", url: remote },
			signal,
		);
		expect(addedRemote.status).toBe("completed");
		expect(
			(await readGitRemotes(repository, signal)).remotes.map(
				(entry) => entry.name,
			),
		).toContain("mirror");
		expect(
			(
				await service.run(
					repository,
					{
						action: "remote-add",
						name: "bad",
						url: "https://user:token@example.invalid/repo.git",
					},
					signal,
				)
			).reason,
		).toBe("remote-invalid");
		expect(
			(
				await service.run(
					repository,
					{ action: "remote-remove", name: "mirror" },
					signal,
				)
			).status,
		).toBe("completed");
		expect(
			(await readGitRemotes(repository, signal)).remotes.map(
				(entry) => entry.name,
			),
		).not.toContain("mirror");

		git(repository, "switch", "--quiet", "main");
		Bun.spawnSync(["git", "clone", "--quiet", remote, clone], {
			stdout: "ignore",
			stderr: "ignore",
		});
		git(clone, "config", "user.name", "Fixture");
		git(clone, "config", "user.email", "fixture@example.invalid");
		fs.writeFileSync(path.join(clone, "remote.txt"), "remote\n");
		git(clone, "add", "remote.txt");
		git(clone, "commit", "--quiet", "-m", "remote");
		git(clone, "push", "--quiet", "origin", "main");

		expect(
			(await service.run(repository, { action: "fetch" }, signal)).status,
		).toBe("completed");
		const behind = (await readGitBranches(repository, signal)).branches.find(
			(branch) => branch.name === "main",
		);
		expect(behind?.behind).toBe(1);
		expect(
			(await service.run(repository, { action: "pull" }, signal)).status,
		).toBe("completed");
		expect(fs.existsSync(path.join(repository, "remote.txt"))).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("guarded git writes preview, confirm and refuse unsafe state", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-writes-")),
	);
	const remote = path.join(root, "remote.git");
	const mirror = path.join(root, "mirror.git");
	const repository = path.join(root, "repo");
	const git = (cwd: string, ...args: string[]) => {
		const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (child.exitCode !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
		return child.stdout.toString().trim();
	};
	const signal = new AbortController().signal;
	const service = createGitActionService();
	const write = async (
		request: Parameters<typeof service.write>[1],
		requestId: string,
	) => {
		const preview = await service.write(
			repository,
			request,
			requestId,
			undefined,
			signal,
		);
		if (preview.status !== "confirmation-required")
			throw new Error("no confirmation digest");
		return await service.write(
			repository,
			request,
			requestId,
			preview.digest,
			signal,
		);
	};
	try {
		fs.mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		fs.mkdirSync(mirror);
		git(mirror, "init", "--bare", "--initial-branch=main");
		git(root, "init", "--initial-branch=main", repository);
		git(repository, "config", "user.name", "Fixture");
		git(repository, "config", "user.email", "fixture@example.invalid");
		fs.writeFileSync(path.join(repository, "tracked.txt"), "one\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "--quiet", "-m", "initial");
		git(repository, "remote", "add", "origin", remote);
		git(repository, "remote", "add", "mirror", mirror);
		git(repository, "push", "--quiet", "-u", "origin", "main");
		git(repository, "branch", "feature");

		const tagged = await write({ action: "tag", name: "v1" }, "tag-1");
		expect(tagged).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "tag" },
		});
		expect(git(repository, "tag", "--list")).toContain("v1");
		if (tagged.status !== "completed") throw new Error("tag not completed");
		expect(
			await service.write(
				repository,
				{ action: "tag", name: "v1" },
				"tag-1",
				tagged.digest,
				signal,
			),
		).toMatchObject({ status: "replayed" });
		const different = await service.write(
			repository,
			{ action: "tag", name: "v2" },
			"tag-1",
			undefined,
			signal,
		);
		if (different.status !== "confirmation-required")
			throw new Error("no confirmation digest");
		await expect(
			service.write(
				repository,
				{ action: "tag", name: "v2" },
				"tag-1",
				different.digest,
				signal,
			),
		).rejects.toMatchObject({ code: "request-conflict" });

		expect(
			await write(
				{ action: "branch-rename", branch: "feature", name: "renamed" },
				"rename-1",
			),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", branch: "main" },
		});
		expect(git(repository, "branch", "--list", "renamed")).not.toBe("");

		const before = git(repository, "rev-parse", "HEAD");
		fs.writeFileSync(path.join(repository, "committed.txt"), "new\n");
		expect(
			await write(
				{ action: "commit-all", message: "add committed" },
				"commit-1",
			),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "commit-all" },
		});
		expect(git(repository, "rev-parse", "HEAD")).not.toBe(before);
		expect(git(repository, "log", "-1", "--format=%s")).toBe("add committed");

		expect(
			await write(
				{
					action: "remote-set-url",
					name: "mirror",
					url: remote,
				},
				"remote-url-1",
			),
		).toMatchObject({ status: "completed" });
		expect(git(repository, "remote", "get-url", "mirror")).toBe(remote);

		expect(
			await write(
				{
					action: "push",
					branch: "main",
					remote: "origin",
					setUpstream: false,
				},
				"push-1",
			),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "push" },
		});
		expect(git(remote, "rev-parse", "main")).toBe(
			git(repository, "rev-parse", "main"),
		);

		git(repository, "checkout", "--quiet", "-b", "merge-me");
		fs.writeFileSync(path.join(repository, "merged.txt"), "merged\n");
		git(repository, "add", "merged.txt");
		git(repository, "commit", "--quiet", "-m", "merge me");
		git(repository, "checkout", "--quiet", "main");
		expect(
			await write({ action: "merge", branch: "merge-me" }, "merge-1"),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "merge" },
		});
		expect(git(repository, "log", "--format=%s")).toContain("merge me");

		git(repository, "checkout", "--quiet", "-b", "topic");
		fs.writeFileSync(path.join(repository, "topic.txt"), "topic\n");
		git(repository, "add", "topic.txt");
		git(repository, "commit", "--quiet", "-m", "topic work");
		git(repository, "checkout", "--quiet", "main");
		fs.writeFileSync(path.join(repository, "main.txt"), "main\n");
		git(repository, "add", "main.txt");
		git(repository, "commit", "--quiet", "-m", "main work");
		git(repository, "checkout", "--quiet", "topic");
		expect(
			await write({ action: "rebase", branch: "main" }, "rebase-1"),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "rebase" },
		});
		expect(
			Bun.spawnSync(
				[
					"git",
					"-C",
					repository,
					"merge-base",
					"--is-ancestor",
					"main",
					"topic",
				],
				{ stdout: "ignore", stderr: "ignore" },
			).exitCode,
		).toBe(0);

		fs.writeFileSync(path.join(repository, "tracked.txt"), "dirty\n");
		const dirtyMerge = await write(
			{ action: "merge", branch: "main" },
			"merge-dirty",
		);
		expect(dirtyMerge).toMatchObject({
			status: "completed",
			outcome: { status: "refused", reason: "dirty-worktree" },
		});
		const stashed = await write(
			{ action: "stash", message: "fixture stash" },
			"stash-1",
		);
		expect(stashed).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "stash" },
		});
		expect(git(repository, "status", "--porcelain")).toBe("");
		expect(git(repository, "stash", "list")).toContain("fixture stash");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("tags, stashes and staging writes", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-staging-")),
	);
	const repository = path.join(root, "repo");
	const git = (cwd: string, ...args: string[]) => {
		const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (child.exitCode !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
		return child.stdout.toString().trim();
	};
	const signal = new AbortController().signal;
	const service = createGitActionService();
	const write = async (
		request: Parameters<typeof service.write>[1],
		requestId: string,
	) => {
		const preview = await service.write(
			repository,
			request,
			requestId,
			undefined,
			signal,
		);
		if (preview.status !== "confirmation-required")
			throw new Error("no confirmation digest");
		return await service.write(
			repository,
			request,
			requestId,
			preview.digest,
			signal,
		);
	};
	try {
		git(root, "init", "--initial-branch=main", repository);
		git(repository, "config", "user.name", "Fixture");
		git(repository, "config", "user.email", "fixture@example.invalid");
		fs.writeFileSync(path.join(repository, "tracked.txt"), "one\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "--quiet", "-m", "initial");

		fs.writeFileSync(path.join(repository, "untracked.txt"), "new\n");
		expect(
			await service.run(repository, { action: "stage-all" }, signal),
		).toMatchObject({ status: "completed" });
		expect((await service.tags(repository, signal)).tags.length).toBe(0);
		const staged = await service.run(
			repository,
			{ action: "unstage", path: "untracked.txt" },
			signal,
		);
		expect(staged.status).toBe("completed");
		expect(
			(
				await service.run(
					repository,
					{ action: "unstage", path: "untracked.txt" },
					signal,
				)
			).reason,
		).toBe("not-staged");
		expect(
			await service.run(
				repository,
				{ action: "stage", path: "untracked.txt" },
				signal,
			),
		).toMatchObject({ status: "completed" });
		expect(
			(
				await service.run(
					repository,
					{ action: "stage", path: "../outside" },
					signal,
				)
			).reason,
		).toBe("path-invalid");

		const stagedCommit = await write(
			{ action: "commit", message: "staged commit" },
			"commit-staged",
		);
		expect(stagedCommit).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "commit" },
		});
		expect(git(repository, "log", "-1", "--format=%s")).toBe("staged commit");

		fs.writeFileSync(path.join(repository, "all.txt"), "all\n");
		const allCommit = await write(
			{ action: "commit-all", message: "all commit" },
			"commit-all",
		);
		expect(allCommit).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "commit-all" },
		});
		expect(git(repository, "log", "-1", "--format=%s")).toBe("all commit");
		fs.writeFileSync(path.join(repository, "nothing.txt"), "nothing\n");
		const nothingStaged = await write(
			{ action: "commit", message: "nothing staged" },
			"commit-nothing",
		);
		expect(nothingStaged).toMatchObject({
			status: "completed",
			outcome: { status: "refused", reason: "nothing-staged" },
		});
		fs.rmSync(path.join(repository, "nothing.txt"));

		expect(
			await write(
				{ action: "tag", name: "v1", message: "release one" },
				"tag-annotated",
			),
		).toMatchObject({ status: "completed" });
		const tags = await service.tags(repository, signal);
		expect(tags.tags).toEqual([
			{
				name: "v1",
				sha: expect.any(String),
				annotated: true,
				date: expect.any(String),
				subject: "release one",
			},
		]);
		expect(
			await write({ action: "tag-delete", name: "v1" }, "tag-delete"),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", action: "tag-delete" },
		});
		expect((await service.tags(repository, signal)).tags).toEqual([]);

		fs.writeFileSync(path.join(repository, "tracked.txt"), "stash one\n");
		expect(
			await write({ action: "stash", message: "first stash" }, "stash-first"),
		).toMatchObject({ status: "completed" });
		expect(git(repository, "status", "--porcelain")).toBe("");
		const stashes = await service.stashes(repository, signal);
		expect(stashes.stashes).toEqual([
			{
				index: 0,
				ref: "stash@{0}",
				branch: "main",
				message: "first stash",
				date: expect.any(String),
			},
		]);
		expect(
			await write({ action: "stash-apply", index: 0 }, "stash-apply"),
		).toMatchObject({ status: "completed" });
		expect(git(repository, "status", "--porcelain")).toContain("tracked.txt");
		expect((await service.stashes(repository, signal)).stashes.length).toBe(1);
		git(repository, "checkout", "--", "tracked.txt");
		expect(
			await write({ action: "stash-pop", index: 0 }, "stash-pop"),
		).toMatchObject({ status: "completed" });
		expect((await service.stashes(repository, signal)).stashes).toEqual([]);
		expect(git(repository, "status", "--porcelain")).toContain("tracked.txt");

		git(repository, "checkout", "--", "tracked.txt");
		fs.writeFileSync(path.join(repository, "tracked.txt"), "stash two\n");
		expect(
			await write({ action: "stash", message: "second stash" }, "stash-second"),
		).toMatchObject({ status: "completed" });
		expect(
			await write({ action: "stash-drop", index: 0 }, "stash-drop"),
		).toMatchObject({ status: "completed" });
		expect((await service.stashes(repository, signal)).stashes).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
