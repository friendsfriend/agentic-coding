import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

test("a planted staging directory or symlink is never adopted, written or discarded by assembly", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
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
		const repository = config.repositories[0] ?? "";
		const created = await (
			await api("/api/environments/drafts", {
				requestId: "create",
				content: JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository,
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
				requestId: "stage",
				id: created.id,
				revision: 1,
				app: "api",
				target: "stack",
				content: "services:\n  api:\n    image: planted:latest\n",
			})
		).json();
		const staging = path.join(config.stateDir, "native", "staging");
		fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
		const temporaryName = (requestId: string) =>
			`tree-${digest(`preflight-assembly:${digest(requestId)}`)}`;
		const preflight = (requestId: string) =>
			api("/api/environments/drafts/preflight", {
				requestId,
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
			}).then((response) => response.json());
		// A planted directory at this request's temporary name is never written
		// into, adopted or discarded: assembly fails closed.
		const planted = path.join(staging, temporaryName("planted-assembly"));
		fs.mkdirSync(planted, { mode: 0o700 });
		fs.writeFileSync(path.join(planted, "marker"), "untouched");
		const refused = await preflight("planted-assembly");
		expect(refused.accepted).toBe(false);
		expect(fs.readFileSync(path.join(planted, "marker"), "utf8")).toBe(
			"untouched",
		);
		expect(fs.lstatSync(planted).isDirectory()).toBe(true);
		// The same request replays the recorded refusal; the effect is not retried.
		const replayed = await preflight("planted-assembly");
		expect(replayed.accepted).toBe(false);
		expect(replayed.id).toBe(refused.id);
		// A planted symlink at another request's temporary name is likewise left
		// alone: mkdir never follows it, and the decoy is untouched.
		const decoy = path.join(config.stateDir, "namespace-decoy");
		fs.mkdirSync(decoy);
		fs.writeFileSync(path.join(decoy, "marker"), "untouched");
		const plantedLink = path.join(staging, temporaryName("planted-symlink"));
		fs.symlinkSync(decoy, plantedLink);
		const refusedLink = await preflight("planted-symlink");
		expect(refusedLink.accepted).toBe(false);
		expect(fs.readFileSync(path.join(decoy, "marker"), "utf8")).toBe(
			"untouched",
		);
		expect(fs.lstatSync(plantedLink).isSymbolicLink()).toBe(true);
		// Both plants are recorded on their failed attempts as unavailable
		// temporaries, never as present trees, and the failed attempts completed
		// instead of blocking new work.
		const trees = await (await api("/api/environments/drafts/trees")).json();
		for (const name of [
			temporaryName("planted-assembly"),
			temporaryName("planted-symlink"),
		]) {
			const attempt = trees.cleanupAttempts.find(
				(attempt: { assembly?: { temporaryName: string } }) =>
					attempt.assembly?.temporaryName === name,
			);
			expect(attempt?.status).toBe("completed");
			expect(attempt?.temporary?.state).toBe("unavailable");
		}
		// A foreign name no attempt owns is disclosed as unowned, never deleted
		// here and never adopted by a later assembly under another key.
		const foreign = `tree-${digest("foreign-temporary-plant")}`;
		expect(foreign).not.toBe(temporaryName("planted-assembly"));
		fs.mkdirSync(path.join(staging, foreign), { mode: 0o700 });
		const foreignTrees = await (
			await api("/api/environments/drafts/trees")
		).json();
		expect(
			foreignTrees.unownedTemporary.map(
				(entry: { name: string }) => entry.name,
			),
		).toContain(foreign);
		expect(fs.lstatSync(path.join(staging, foreign)).isDirectory()).toBe(true);
		fs.rmSync(path.join(staging, foreign), { recursive: true });
		// With the plants removed, a fresh request under its own key assembles.
		fs.rmSync(planted, { recursive: true });
		fs.unlinkSync(plantedLink);
		const clean = await preflight("clean-assembly");
		expect(clean.accepted).toBe(true);
		expect(clean.treeDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(() =>
			fs.lstatSync(path.join(staging, temporaryName("clean-assembly"))),
		).toThrow();
	} finally {
		await host.stop();
		await app.close();
	}
}, 60000);
