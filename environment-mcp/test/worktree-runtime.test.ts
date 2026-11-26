import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("compose and container targets execute from a linked worktree", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-worktree-runtime-")),
	);
	const repository = path.join(root, "repo");
	const linked = path.join(root, "linked");
	const state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	fs.writeFileSync(path.join(repository, "compose.yaml"), "services: {}\n");
	const git = (cwd: string, ...args: string[]) => {
		const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
	};
	git(repository, "init", "--quiet");
	git(repository, "config", "user.name", "Fixture");
	git(repository, "config", "user.email", "fixture@example.invalid");
	git(repository, "add", ".");
	git(repository, "commit", "--quiet", "-m", "fixture");
	const worktree = Bun.spawnSync(
		[
			"git",
			"-C",
			repository,
			"worktree",
			"add",
			"--quiet",
			"-b",
			"linked",
			linked,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	if (worktree.exitCode !== 0) throw new Error("Fixture worktree failed");
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [],
		apps: [
			{
				id: "api",
				repository,
				targets: [
					{
						id: "compose",
						action: "run",
						runtime: "compose",
						executable: {
							kind: "compose",
							socket: "/fixture/docker.sock",
							file: path.join(repository, "compose.yaml"),
							project: "fixture",
							services: ["api"],
						},
					},
					{
						id: "build",
						action: "build",
						runtime: "docker",
						executable: {
							kind: "docker-build",
							socket: "/fixture/docker.sock",
							context: repository,
							dockerfileSource: "FROM scratch\n",
							image: "fixture:latest",
						},
					},
					{
						id: "container",
						action: "run",
						runtime: "docker",
						executable: {
							kind: "container-run",
							socket: "/fixture/docker.sock",
							image: "fixture:latest",
							name: "environment-mcp-api-container",
							readiness: "running",
						},
					},
				],
			},
		],
	});
	const composeId = "a".repeat(64);
	const containerId = "b".repeat(64);
	const seen: {
		compose?: { cwd: string; project: string; file?: string };
		container?: { cwd: string; name: string; image: string };
	} = {};
	const executor = {
		async composeUp({
			executable,
			cwd,
		}: Parameters<NonNullable<ExecutionPort["composeUp"]>>[0]) {
			seen.compose = {
				cwd,
				project: executable.project,
				file: executable.file,
			};
			return {
				exitCode: 0,
				timedOut: false,
				output: "started",
				truncated: false,
			};
		},
		async composeContainers() {
			return [composeId];
		},
		async containersReady() {
			return { readiness: "ready" as const, source: "docker-running" as const };
		},
		async probeEndpoints() {
			return {};
		},
		async containerRun({
			executable,
			cwd,
		}: Parameters<NonNullable<ExecutionPort["containerRun"]>>[0]) {
			seen.container = {
				cwd,
				name: executable.name,
				image: executable.image,
			};
			return {
				containerId,
				timedOut: false,
				output: containerId,
				truncated: false,
			};
		},
		async stopContainers({ containers }: { containers: string[] }) {
			return containers;
		},
		async logs() {
			return "";
		},
	} as unknown as ExecutionPort;
	const journal = openOperationJournal(state, [repository]);
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		{} as never,
		executor,
		{ get: () => undefined },
		{ telemetryDirectory: state },
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		const compose = await agent.admit(
			"compose-worktree",
			{ app: "api", target: "compose", worktree: linked },
			signal,
		);
		await agent.execute(compose.id, signal);
		expect((await agent.wait(compose.id, 5, signal)).receipt).toMatchObject({
			status: "completed",
			kind: "compose",
			readiness: "ready",
		});
		expect(seen.compose?.cwd).toBe(linked);
		expect(seen.compose?.project).toMatch(/^fixture-wt-[a-f0-9]{8}$/);
		expect(seen.compose?.file).toBe(
			fs.realpathSync(path.join(linked, "compose.yaml")),
		);

		const container = await agent.admit(
			"container-worktree",
			{ app: "api", target: "container", worktree: linked },
			signal,
		);
		await agent.execute(container.id, signal);
		expect((await agent.wait(container.id, 5, signal)).receipt).toMatchObject({
			status: "completed",
			kind: "container",
			containerId,
			readiness: "ready",
		});
		expect(seen.container?.cwd).toBe(linked);
		expect(seen.container?.name).toMatch(
			/^environment-mcp-api-container-wt-[a-f0-9]{8}$/,
		);
		expect(seen.container?.image).toMatch(/^fixture:latest-wt-[a-f0-9]{8}$/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
