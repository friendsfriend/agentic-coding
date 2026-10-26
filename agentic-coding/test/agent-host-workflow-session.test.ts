// Canonical workflow-session lookup uses the selected target's read-only store,
// not a transported socket or dashboard repository/worktree fields.

import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	createHostIdentity,
	hostIdentityPaths,
} from "../src/agent-host/host-identity.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { verifyWorkflowSessions } from "../src/agent-host/workflow-session-lookup.ts";

const mockedBatchExecutor = async (
	...args: Parameters<typeof verifyWorkflowSessions>
) => verifyWorkflowSessions(...args);

import {
	createWorkflowSessionResolver,
	workflowSessionSocket,
} from "../src/agent-host/workflow-session.ts";
import * as stores from "../src/workflow/runtime/store.ts";
import * as targets from "../src/workflow/runtime/targets.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function socketFile(runtimeDir: string) {
	const layout = hostLayout(runtimeDir);
	fs.mkdirSync(layout.root, { recursive: true });
	fs.writeFileSync(layout.socketPath, "");
	return layout.socketPath;
}

function fixture() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "workflow-session-")),
	);
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const files = new Map<string, string>();
	let nextFile = 0;
	const open = spyOn(stores, "openReadStore").mockImplementation((target) => {
		const file = files.get(target);
		if (!file) throw new Error("workflow target is unavailable");
		return new Database(file, { readonly: true });
	});
	cleanups.push(() => open.mockRestore());
	const add = (target: string, worktree: unknown, extraRuns = 0) => {
		if (typeof worktree === "string" && path.isAbsolute(worktree))
			socketFile(path.join(worktree, ".herdr-workflow"));
		const file = path.join(root, `store-${nextFile++}.db`);
		const db = new Database(file);
		try {
			db.exec(
				"CREATE TABLE workflow_instances(id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL); CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL)",
			);
			for (const id of ["flow", "other-flow"]) {
				db.query("INSERT INTO workflow_instances VALUES (?, ?)").run(
					id,
					JSON.stringify({ metadata: { worktree } }),
				);
				db.query("INSERT INTO workflow_runs VALUES (?, ?)").run(
					`${id}-run`,
					id,
				);
			}
			for (let i = 0; i < extraRuns; i++)
				db.query("INSERT INTO workflow_runs VALUES (?, ?)").run(
					`extra-${i}`,
					"flow",
				);
		} finally {
			db.close();
		}
		files.set(target, file);
	};
	return { root, add, open, files };
}

test("the selected target's exact workflow/run resolves its worktree host, not the repository host", () => {
	const f = fixture();
	const worktree = path.join(f.root, "linked-worktree");
	f.add("/selected-repository", worktree);
	f.add("/other-repository", path.join(f.root, "other-worktree"));
	const socket = hostLayout(path.join(worktree, ".herdr-workflow")).socketPath;
	expect(
		workflowSessionSocket("/selected-repository", "flow", "flow-run", socket),
	).toBe(socket);
	expect(f.open).toHaveBeenCalledWith("/selected-repository");
	for (const forged of [
		"/tmp/unrelated.sock",
		hostLayout("/selected-repository/.herdr-workflow").socketPath,
		"relative.sock",
		`${socket}/../host.sock`,
	]) {
		expect(() =>
			workflowSessionSocket("/selected-repository", "flow", "flow-run", forged),
		).toThrow(/does not belong/);
	}
	// Even the same workflow/run strings in another target have another host.
	expect(() =>
		workflowSessionSocket("/other-repository", "flow", "flow-run", socket),
	).toThrow(/does not belong/);
	expect(() =>
		workflowSessionSocket(
			"/selected-repository",
			"flow",
			"other-flow-run",
			socket,
		),
	).toThrow(/run does not belong/);
	expect(() =>
		workflowSessionSocket(
			"/selected-repository",
			"flow",
			"missing-run",
			socket,
		),
	).toThrow(/run does not belong/);
	expect(() =>
		workflowSessionSocket("/missing-target", "flow", "flow-run", socket),
	).toThrow(/target is unavailable/);
});

test("repository-independent targets have separate workflow hosts under the canonical data root", () => {
	const f = fixture();
	const dataRoot = path.join(f.root, "data");
	socketFile(path.join(dataRoot, "flow"));
	const wikiRoot = spyOn(targets, "wikiWorkflowDataRoot").mockReturnValue(
		dataRoot,
	);
	cleanups.push(() => wikiRoot.mockRestore());
	for (const target of targets.NON_REPOSITORY_WORKFLOW_TARGETS) {
		f.add(target, "not-a-repository");
		const socket = hostLayout(path.join(dataRoot, "flow")).socketPath;
		expect(workflowSessionSocket(target, "flow", "flow-run", socket)).toBe(
			socket,
		);
		expect(f.open).toHaveBeenCalledWith(target);
		const otherSocket = hostLayout(
			path.join(dataRoot, "other-flow"),
		).socketPath;
		expect(() =>
			workflowSessionSocket(target, "flow", "flow-run", otherSocket),
		).toThrow(/does not belong/);
		expect(() =>
			workflowSessionSocket(target, "flow", "other-flow-run", socket),
		).toThrow(/run does not belong/);
	}
});

test("invalid workflow identities and unusable worktree metadata fail closed", () => {
	const f = fixture();
	for (const worktree of [undefined, null, "relative", 42]) {
		f.add("/selected-repository", worktree);
		expect(() =>
			workflowSessionSocket(
				"/selected-repository",
				"flow",
				"flow-run",
				"/tmp/host.sock",
			),
		).toThrow(/location is unavailable/);
	}
	const before = f.open.mock.calls.length;
	for (const id of ["../other", "flow/../../other", "", "/absolute"]) {
		expect(() =>
			workflowSessionSocket(
				"/selected-repository",
				id,
				"flow-run",
				"/tmp/host.sock",
			),
		).toThrow();
	}
	expect(f.open.mock.calls).toHaveLength(before);
});

test("worktree and ancestor symlinks cannot redirect a canonical-looking socket", () => {
	const f = fixture();
	for (const component of ["worktree", "ancestor"]) {
		const destination = path.join(f.root, `foreign-${component}`);
		fs.mkdirSync(destination);
		const link = path.join(f.root, `link-${component}`);
		fs.symlinkSync(destination, link);
		const worktree =
			component === "worktree" ? link : path.join(link, "child-worktree");
		f.add(`/repository-${component}`, worktree);
		const socket = hostLayout(
			path.join(worktree, ".herdr-workflow"),
		).socketPath;
		expect(fs.existsSync(socket)).toBe(true);
		expect(() =>
			workflowSessionSocket(
				`/repository-${component}`,
				"flow",
				"flow-run",
				socket,
			),
		).toThrow(/symlink/);
	}
});

test("a dashboard fan-out shares one store open, one location read and one path resolution", async () => {
	const f = fixture();
	const worktree = path.join(f.root, "worktree");
	f.add("/repository", worktree, 600);
	const socket = hostLayout(path.join(worktree, ".herdr-workflow")).socketPath;
	const queries = spyOn(Database.prototype, "query");
	const paths = spyOn(fs, "realpathSync");
	const resolver = createWorkflowSessionResolver(
		"/repository",
		"flow",
		mockedBatchExecutor,
	);
	try {
		const requests = Array.from({ length: 600 }, (_, i) =>
			resolver.resolve(`extra-${i}`, socket),
		);
		const missing = resolver.resolve("other-flow-run", socket);
		const forged = resolver.resolve("flow-run", "/tmp/foreign.sock");
		// Acquisitions do not perform per-target synchronous I/O in the caller.
		expect(f.open).not.toHaveBeenCalled();
		const results = await Promise.allSettled([...requests, missing, forged]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(600);
		expect(results.slice(-2).every((r) => r.status === "rejected")).toBe(true);
		expect(f.open).toHaveBeenCalledTimes(1);
		expect(queries).toHaveBeenCalledTimes(4); // one location + three bounded membership queries
		expect(paths).toHaveBeenCalledTimes(1);
		expect(await resolver.resolve("flow-run", socket)).toBe(socket);
		expect(f.open).toHaveBeenCalledTimes(2); // new batch revalidates, not a permanent trust cache
		fs.rmSync(socket);
		await expect(resolver.resolve("flow-run", socket)).rejects.toThrow();
	} finally {
		resolver.dispose();
		queries.mockRestore();
		paths.mockRestore();
	}
});

test("resolver disposal rejects queued and just-validated acquisitions before use", async () => {
	const f = fixture();
	const worktree = path.join(f.root, "worktree");
	f.add("/repository", worktree);
	const socket = hostLayout(path.join(worktree, ".herdr-workflow")).socketPath;
	const queued = createWorkflowSessionResolver(
		"/repository",
		"flow",
		mockedBatchExecutor,
	);
	const cancelled = queued.resolve("flow-run", socket);
	queued.dispose();
	await expect(cancelled).rejects.toThrow(/disposed/);
	expect(f.open).not.toHaveBeenCalled();
	await expect(queued.resolve("flow-run", socket)).rejects.toThrow(/disposed/);
	const validated = createWorkflowSessionResolver(
		"/repository",
		"flow",
		mockedBatchExecutor,
	);
	const late = validated.resolve("flow-run", socket);
	queueMicrotask(() => validated.dispose());
	await expect(late).rejects.toThrow(/disposed/);
	expect(f.open).toHaveBeenCalledTimes(1);
});

test("production validation runs off-thread while a locked store leaves the TUI event loop responsive", async () => {
	const f = fixture();
	const target = path.join(f.root, "repository");
	f.add(target, target, 600);
	expect(Bun.spawnSync(["git", "init", "--quiet", target]).exitCode).toBe(0);
	const source = f.files.get(target);
	if (!source) throw new Error("fixture store missing");
	const file = targets.canonicalStorePath(target);
	fs.copyFileSync(source, file);
	const lock = new Database(file);
	lock.exec(
		`PRAGMA user_version = ${stores.STORE_SCHEMA_VERSION}; BEGIN EXCLUSIVE`,
	);
	const socket = hostLayout(path.join(target, ".herdr-workflow")).socketPath;
	const paths = spyOn(fs, "realpathSync");
	const resolver = createWorkflowSessionResolver(target, "flow");
	let released = false;
	const timer = setTimeout(() => {
		lock.exec("COMMIT");
		released = true;
	}, 20);
	try {
		const results = await Promise.all(
			Array.from({ length: 600 }, (_, i) =>
				resolver.resolve(`extra-${i}`, socket),
			),
		);
		expect(released).toBe(true);
		expect(results).toHaveLength(600);
		expect(new Set(results)).toEqual(new Set([socket]));
		// Mocks are isolate-local: real SQLite/path work occurred in the worker,
		// not through either synchronous boundary on the calling event loop.
		expect(f.open).not.toHaveBeenCalled();
		expect(paths).not.toHaveBeenCalled();
		const foreign = await resolver
			.resolve("other-flow-run", socket)
			.catch((error) => error);
		expect(foreign).toBeInstanceOf(Error);
		expect(foreign.message).toContain("belong");
		fs.rmSync(socket);
		const missing = await resolver
			.resolve("flow-run", socket)
			.catch((error) => error);
		expect(missing).toBeInstanceOf(Error);
	} finally {
		clearTimeout(timer);
		if (!released) lock.exec("ROLLBACK");
		lock.close();
		paths.mockRestore();
		resolver.dispose();
	}
});

test("disposing during an executor flight rejects all acquisitions and discards late replies", async () => {
	const gate: {
		complete?: (value: Awaited<ReturnType<typeof mockedBatchExecutor>>) => void;
	} = {};
	const resolver = createWorkflowSessionResolver(
		"target",
		"flow",
		async () =>
			new Promise((resolve) => {
				gate.complete = resolve;
			}),
	);
	const first = resolver.resolve("first", "/socket");
	await Promise.resolve(); // enter the executor before disposal
	const second = resolver.resolve("second", "/socket");
	const settled = Promise.allSettled([first, second]);
	resolver.dispose();
	const results = await settled;
	expect(
		results.every(
			(result) =>
				result.status === "rejected" &&
				result.reason instanceof Error &&
				/disposed/.test(result.reason.message),
		),
	).toBe(true);
	gate.complete?.([{ socket: "/socket" }]);
	await expect(resolver.resolve("third", "/socket")).rejects.toThrow(
		/disposed/,
	);
});

test("production worker disposal rejects promptly, terminates the real worker and never delivers a late result", async () => {
	const f = fixture();
	const target = path.join(f.root, "repository");
	f.add(target, target);
	expect(Bun.spawnSync(["git", "init", "--quiet", target]).exitCode).toBe(0);
	const source = f.files.get(target);
	if (!source) throw new Error("fixture store missing");
	const file = targets.canonicalStorePath(target);
	fs.copyFileSync(source, file);
	const lock = new Database(file);
	lock.exec(
		`PRAGMA user_version = ${stores.STORE_SCHEMA_VERSION}; BEGIN EXCLUSIVE`,
	);
	const observed = {
		posted: false,
		opened: false,
		started: false,
		closed: false,
		replies: 0,
	};
	const post = Worker.prototype.postMessage;
	const posting = spyOn(Worker.prototype, "postMessage").mockImplementation(
		function (
			this: Worker,
			message: unknown,
			options?: Transferable[] | StructuredSerializeOptions,
		) {
			observed.posted = true;
			this.addEventListener("open", () => {
				observed.opened = true;
			});
			this.addEventListener("close", () => {
				observed.closed = true;
			});
			this.addEventListener("message", (event) => {
				if (event.data?.started) observed.started = true;
				else observed.replies++;
			});
			post.call(
				this,
				message,
				Array.isArray(options) ? { transfer: options } : options,
			);
		},
	);
	const resolver = createWorkflowSessionResolver(target, "flow");
	let unlocked = false;
	try {
		const request = resolver
			.resolve(
				"flow-run",
				hostLayout(path.join(target, ".herdr-workflow")).socketPath,
			)
			.catch((error) => error);
		const deadline = Date.now() + 2000;
		while (!observed.started || !observed.posted) {
			if (Date.now() > deadline) throw new Error("worker did not start");
			await Bun.sleep(5);
		}
		// The real request is in flight with no possible SQLite result yet.
		expect(observed.replies).toBe(0);
		resolver.dispose();
		const result = await request;
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toContain("disposed");
		lock.exec("COMMIT");
		unlocked = true;
		const stopped = Date.now() + 2000;
		while (!observed.closed) {
			if (Date.now() > stopped)
				throw new Error("disposed production worker remained alive");
			await Bun.sleep(5);
		}
		expect(observed.closed).toBe(true);
		expect(observed.replies).toBe(0);
	} finally {
		resolver.dispose();
		posting.mockRestore();
		if (!unlocked) lock.exec("ROLLBACK");
		lock.close();
	}
});

test("authenticated connections refresh the instance pin and fail closed after path/authority changes", async () => {
	const f = fixture();
	const worktree = path.join(f.root, "worktree");
	f.add("/repository", worktree);
	const socket = hostLayout(path.join(worktree, ".herdr-workflow")).socketPath;
	const paths = hostIdentityPaths(socket);
	fs.writeFileSync(paths.socket, "");
	const first = createHostIdentity();
	fs.writeFileSync(paths.certificate, first.cert, { mode: 0o600 });
	const resolver = createWorkflowSessionResolver(
		"/repository",
		"flow",
		mockedBatchExecutor,
	);
	try {
		expect(await resolver.connection("flow-run", socket)).toEqual({
			socket: paths.socket,
			fingerprint: first.fingerprint,
		});
		const restarted = createHostIdentity();
		fs.writeFileSync(paths.certificate, restarted.cert);
		expect((await resolver.connection("flow-run", socket)).fingerprint).toBe(
			restarted.fingerprint,
		);
		await expect(resolver.connection("other-flow-run", socket)).rejects.toThrow(
			/belong/,
		);
		fs.rmSync(paths.certificate);
		await expect(resolver.connection("flow-run", socket)).rejects.toThrow(
			/restart the local host/,
		);
		fs.writeFileSync(paths.certificate, restarted.cert, { mode: 0o600 });
		const original = `${worktree}-original`;
		fs.renameSync(worktree, original);
		fs.symlinkSync(original, worktree);
		await expect(resolver.connection("flow-run", socket)).rejects.toThrow(
			/symlink/,
		);
	} finally {
		resolver.dispose();
	}
});

test("a canonical-looking path cannot follow runtime, host-directory or socket symlinks", () => {
	const f = fixture();
	for (const component of ["runtime", "host", "socket"]) {
		const worktree = path.join(f.root, component);
		const runtimeDir = path.join(worktree, ".herdr-workflow");
		const layout = hostLayout(runtimeDir);
		fs.mkdirSync(layout.root, { recursive: true });
		f.add(`/repository-${component}`, worktree);
		const file =
			component === "runtime"
				? runtimeDir
				: component === "host"
					? layout.root
					: layout.socketPath;
		fs.rmSync(file, { recursive: true, force: true });
		const elsewhere = path.join(f.root, `elsewhere-${component}`);
		fs.mkdirSync(elsewhere);
		if (component === "runtime") socketFile(elsewhere);
		if (component === "host")
			fs.writeFileSync(path.join(elsewhere, "host.sock"), "");
		fs.symlinkSync(elsewhere, file);
		expect(() =>
			workflowSessionSocket(
				`/repository-${component}`,
				"flow",
				"flow-run",
				layout.socketPath,
			),
		).toThrow(/symlink/);
	}
});

test("real Unix sockets resolve for plain and authenticated workflow sessions", async () => {
	const f = fixture();
	const worktree = path.join(f.root, "worktree");
	f.add("/repository", worktree);
	const socket = hostLayout(path.join(worktree, ".herdr-workflow")).socketPath;
	const paths = hostIdentityPaths(socket);
	fs.rmSync(socket);
	const identity = createHostIdentity();
	fs.writeFileSync(paths.certificate, identity.cert, { mode: 0o600 });
	const servers = [net.createServer(), net.createServer()];
	try {
		for (const [index, file] of [socket, paths.socket].entries()) {
			const server = servers[index];
			if (!server) throw new Error("missing server");
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(file, resolve);
			});
			expect(fs.lstatSync(file).isSocket()).toBe(true);
		}
		expect(
			verifyWorkflowSessions("/repository", "flow", [
				{ runId: "flow-run", recordedSocket: socket },
				{ runId: "flow-run", recordedSocket: socket, authenticated: true },
			]),
		).toEqual([
			{ socket },
			{ socket: paths.socket, fingerprint: identity.fingerprint },
		]);
		// The leaf remains protected even though realpath is no longer called on it.
		const alias = path.join(path.dirname(socket), "alias.sock");
		fs.renameSync(socket, alias);
		fs.symlinkSync(alias, socket);
		expect(() =>
			workflowSessionSocket("/repository", "flow", "flow-run", socket),
		).toThrow(/symlink/);
	} finally {
		for (const server of servers)
			if (server.listening)
				await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
