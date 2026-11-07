import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("temporary tree content mutation changes its fingerprint and refuses the old release identity", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let host = serve(app);
	const api = (route: string, body?: unknown) =>
		fetch(new URL(route, host.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		const created = await (
			await api("/api/environments/drafts", {
				requestId: "create",
				content: JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: config.repositories[0],
							targets: [
								{
									id: "stack",
									action: "run",
									runtime: "compose",
									compose: {
										file: "compose.yaml",
										provider: "docker",
										socket: path.join(config.stateDir, "absent.sock"),
									},
								},
							],
						},
					],
				}),
			})
		).json();
		const staged = await (
			await api("/api/environments/drafts/source", {
				requestId: "source",
				id: created.id,
				revision: created.revision,
				app: "api",
				target: "stack",
				content: "services:\n  api:\n    image: initial:latest\n",
			})
		).json();
		const body = {
			requestId: "interrupted-tree",
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			materializeStagedTree: true,
			retainStagedTree: true,
		};
		host.stop();
		await app.close();
		const input = path.join(config.stateDir, "tree-mutation.json");
		fs.writeFileSync(input, JSON.stringify({ config, body, phase: "write" }));
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/tree-interruption.ts"),
				input,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
		try {
			await child.exited;
		} finally {
			clearTimeout(deadline);
		}
		expect(child.signalCode).toBe("SIGKILL");
		host = serve(await open());
		const history = await (await api("/api/environments/drafts/trees")).json();
		const pending = history.cleanupAttempts.find(
			(attempt: { status: string }) => attempt.status === "pending",
		);
		expect(pending.temporary.state).toBe("present");
		const temporary = path.join(
				config.stateDir,
				"native/staging",
				pending.assembly.temporaryName,
			),
			leaf = path.join(temporary, "environments.json"),
			original = fs.readFileSync(leaf),
			stat = fs.statSync(leaf);
		expect(original.length).toBeGreaterThan(0);
		const mutated = Buffer.from(original);
		mutated[0] = mutated[0] === 0x7b ? 0x5b : 0x7b;
		fs.writeFileSync(leaf, mutated);
		fs.utimesSync(leaf, stat.atime, stat.mtime);
		try {
			fs.lutimesSync(leaf, stat.atime, stat.mtime);
		} catch {
			/* Linux updates ctime regardless; the content digest still changes. */
		}
		const reread = await (await api("/api/environments/drafts/trees")).json();
		const fresh = reread.cleanupAttempts.find(
			(attempt: { id: string }) => attempt.id === pending.id,
		);
		expect(fresh.temporary.state).toBe("present");
		expect(fresh.temporary.fingerprint).not.toBe(pending.temporary.fingerprint);
		expect(
			(
				await api("/api/environments/drafts/tree/temporary-release", {
					requestId: "stale-content",
					id: pending.id,
					revision: pending.revision,
					fingerprint: pending.temporary.fingerprint,
					remove: true,
				})
			).status,
		).toBe(400);
		expect(
			reread.unownedTemporary.some(
				(entry: { name: string }) =>
					entry.name === pending.assembly.temporaryName,
			),
		).toBe(false);
	} finally {
		host.stop();
	}
}, 20000);
