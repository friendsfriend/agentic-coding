import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { git } from "../src/git.ts";
import { serve } from "../src/server.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (repository: string) =>
	fauxAssistantMessage(fauxToolCall("env_discover", { repository }), {
		stopReason: "toolUse",
	});

test("authenticated discovery and the home tool return bounded untrusted hints without publishing, leaking bodies or following links", async () => {
	const { app, config, fake } = await fixture();
	const repo = config.repositories[0] ?? "";
	fs.mkdirSync(config.configDir);
	const marker = "fixture-private-body-not-for-discovery";
	const source = JSON.stringify({
		packageManager: "bun@1.4.4",
		scripts: {
			dev: `touch discovery-executed; echo ${marker}`,
			build: "echo build",
			test: "echo test",
		},
		credentials: marker,
	});
	fs.writeFileSync(path.join(repo, "package.json"), source);
	fs.writeFileSync(path.join(repo, "bun.lock"), marker);
	fs.writeFileSync(path.join(repo, "Dockerfile"), marker);
	fs.writeFileSync(path.join(config.configDir, ".env"), marker);
	fs.writeFileSync(
		path.join(config.configDir, "private.json"),
		JSON.stringify({
			packageManager: "bun@1.4.4",
			scripts: { "test:private": marker },
		}),
	);
	const host = serve(app);
	try {
		const url = new URL(host.url);
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
		};
		const route = `/api/environments/discovery?repository=${encodeURIComponent(repo)}`;
		const get = (route: string) => fetch(new URL(route, url), { headers });
		expect((await fetch(new URL(route, url))).status).toBe(401);
		const result = await get(route);
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		const module = await fetch(new URL("/definition-discovery.js", url));
		expect(module.status).toBe(200);
		expect(module.headers.get("x-content-type-options")).toBe("nosniff");
		const report = await result.json();
		expect(report.source).toEqual({
			repository: repo,
			root: repo,
			directory: ".",
			kind: "developer-checkout",
		});
		expect(report.configuration.written).toBe(false);
		const nested = path.join(repo, "apps", "web");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), source);
		const nestedResponse = await get(`${route}&directory=apps/web`);
		expect(nestedResponse.status).toBe(200);
		const nestedReport = await nestedResponse.json();
		expect(nestedReport.source).toMatchObject({
			root: nested,
			directory: "apps/web",
		});
		expect(nestedReport.suggestions).toEqual(report.suggestions);
		expect(JSON.stringify(nestedReport)).not.toContain(marker);
		fs.symlinkSync(config.configDir, path.join(repo, "linked"));
		fs.symlinkSync(nested, path.join(repo, "apps", "alias"));
		for (const directory of [
			"../escape",
			".git",
			"apps/.private",
			"/tmp",
			"apps/alias",
			"linked",
			"a/b/c/d/e",
			"apps/web/../web",
		]) {
			expect(
				(await get(`${route}&directory=${encodeURIComponent(directory)}`))
					.status,
			).toBe(400);
		}
		expect(
			(await get(`${route}&directory=apps/web&directory=apps/web`)).status,
		).toBe(400);
		expect(
			report.suggestions.find((s: { script: string }) => s.script === "dev"),
		).toMatchObject({ invocation: ["bun", "run", "dev"], trusted: false });
		expect(
			report.evidence.find((e: { path: string }) => e.path === "package.json")
				.digest,
		).toMatch(/^[a-f0-9]{64}$/);
		expect(
			report.evidence.find((e: { path: string }) => e.path === "Dockerfile")
				.contentsRead,
		).toBe(false);
		expect(JSON.stringify(report)).not.toContain(marker);
		expect(
			(await get(`${route}&repository=${encodeURIComponent(repo)}`)).status,
		).toBe(400);
		expect((await get(`${route}&promote=true`)).status).toBe(400);
		expect(
			(
				await get(
					`/api/environments/discovery?repository=${encodeURIComponent(config.configDir)}`,
				)
			).status,
		).toBe(400);
		let observed = false;
		fake.setResponses([
			call(repo),
			(transcript) => {
				const messages = JSON.stringify(transcript.messages);
				expect(messages).toContain("developer-checkout");
				expect(messages).toContain("package.json");
				expect(messages).not.toContain(marker);
				observed = true;
				return fauxAssistantMessage(
					"Discovery complete; these hints are not trusted definitions.",
				);
			},
		]);
		await app.chat(
			"Inspect explicit repository definition evidence",
			"discovery-home",
		);
		await eventually(
			async () => observed,
			(value) => value,
		);
		fs.unlinkSync(path.join(repo, "package.json"));
		fs.symlinkSync(
			path.join(config.configDir, "private.json"),
			path.join(repo, "package.json"),
		);
		const linked = await (await get(route)).json();
		expect(
			linked.evidence.find((e: { path: string }) => e.path === "package.json"),
		).toMatchObject({ state: "symlink-not-followed", contentsRead: false });
		expect(linked.suggestions).toEqual([]);
		expect(JSON.stringify(linked)).not.toContain("test:private");
		fs.unlinkSync(path.join(repo, "package.json"));
		fs.writeFileSync(path.join(repo, "package.json"), source);
		fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), marker);
		const conflicting = await (await get(route)).json();
		expect(conflicting.suggestions).toEqual([]);
		expect(conflicting.findings.join(" ")).toContain(
			"Conflicting package-manager evidence",
		);
		fs.unlinkSync(path.join(repo, "pnpm-lock.yaml"));
		fs.writeFileSync(
			path.join(repo, "package.json"),
			JSON.stringify({
				packageManager: "bun@1.4.4",
				scripts: Object.fromEntries(
					Array.from({ length: 60 }, (_, i) => [`test:bounded-${i}`, marker]),
				),
			}),
		);
		const bounded = await (await get(route)).json();
		expect(bounded.suggestions).toHaveLength(24);
		expect(bounded.omittedSuggestions).toBe(36);
		expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
			12000,
		);
		fs.writeFileSync(path.join(repo, "package.json"), marker.repeat(5000));
		const oversized = await (await get(route)).json();
		expect(oversized.suggestions).toEqual([]);
		expect(oversized.findings.join(" ")).toContain("exceeded 64 KiB");
		expect(JSON.stringify(oversized)).not.toContain(marker);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		expect(fs.existsSync(path.join(repo, "discovery-executed"))).toBe(false);
		const state = await app.snapshot();
		expect(state.tasks).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
		expect(state.environments.projects).toHaveLength(0);
		expect(state.environments.runs).toHaveLength(0);
	} finally {
		host.stop();
	}
});

test("read-only skill discovery uses its captured worktree and refuses another configured repository", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		const other = path.join(config.stateDir, "other");
		fs.mkdirSync(other);
		fs.writeFileSync(
			path.join(other, "package.json"),
			JSON.stringify({
				packageManager: "bun@1.4.4",
				scripts: { "test:foreign": "echo foreign" },
			}),
		);
		config.repositories.push(fs.realpathSync(other));
	});
	const repo = config.repositories[0] ?? "";
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({
			packageManager: "bun@1.4.4",
			scripts: { "test:captured": "echo fixture" },
		}),
	);
	fs.mkdirSync(path.join(repo, "apps", "nested"), { recursive: true });
	fs.copyFileSync(
		path.join(repo, "package.json"),
		path.join(repo, "apps", "nested", "package.json"),
	);
	await git(repo, ["add", "package.json", "apps/nested/package.json"]);
	await git(repo, ["commit", "-m", "discovery fixture"]);
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({
			packageManager: "bun@1.4.4",
			scripts: { "dev:dirty": "echo dirty" },
		}),
	);
	let observed = false;
	fake.setResponses([
		call(repo),
		(transcript) => {
			const messages = JSON.stringify(transcript.messages);
			expect(messages).toContain("native-task-workspace");
			expect(messages).toContain("test:captured");
			expect(messages).not.toContain("dev:dirty");
			return fauxAssistantMessage(
				fauxToolCall("env_discover", {
					repository: repo,
					directory: "apps/nested",
				}),
				{ stopReason: "toolUse" },
			);
		},
		(transcript) => {
			const messages = JSON.stringify(transcript.messages);
			expect(messages).toContain("apps/nested");
			expect(messages).toContain("test:captured");
			return call(config.repositories[1] ?? "");
		},
		(transcript) => {
			const messages = JSON.stringify(transcript.messages);
			expect(messages).toContain("only their own repository");
			expect(messages).not.toContain("test:foreign");
			observed = true;
			return fauxAssistantMessage("Inspected only this task workspace.");
		},
	]);
	const task = await app.startTask({ ...invocation, policy: "read-only" });
	await app.harness.waitForTask(task as TaskId, context);
	expect(observed).toBe(true);
	expect((await app.snapshot()).reviews).toHaveLength(0);
});
