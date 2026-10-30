import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

// Release gate for native manual → blocking admission. Keep the first summary
// pending with a latch, rather than depending on provider timing.
for (const outcome of ["success", "failure", "cancel", "shutdown"] as const)
	for (const order of [
		"manual-first",
		"native-first",
		"concurrent-manual",
		"background-first",
	] as const)
		test(`compaction ${order} cleans up after ${outcome}`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-overlap-"));
			const faux = fauxProvider({
				models: [{ id: "small", contextWindow: 100_000 }],
			});
			const models = createModels();
			models.setProvider(faux.provider);
			const independent = fauxProvider({
				provider: "independent",
				models: [{ id: "wide", contextWindow: 1_000_000 }],
			});
			models.setProvider(independent.provider);
			let enabled = false;
			let active = 0;
			let maximum = 0;
			const summarizer = async (block: boolean) => {
				active++;
				maximum = Math.max(maximum, active);
				try {
					if (block) await pending;
					if (block && outcome === "failure")
						return {
							...fauxAssistantMessage([]),
							stopReason: "error" as const,
							errorMessage: "summary failed",
						};
					return fauxAssistantMessage([fauxText("summary")]);
				} finally {
					active--;
				}
			};
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const open = () =>
				DurableHost.open({
					layout: hostLayout(dir),
					settings: {},
					globalAgentDir: dir,
					...(outcome === "shutdown" ? {} : { storage: new MemoryStorage() }),
					models,
					compaction: () => ({
						enabled,
						ceilingTokens: 0,
						backgroundTokens: order === "background-first" ? 32000 : 0,
					}),
				});
			let host = await open();
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const events = () =>
				fs.existsSync(telemetryPath)
					? fs
							.readFileSync(telemetryPath, "utf8")
							.trim()
							.split("\n")
							.filter(Boolean)
							.map(
								(line) =>
									JSON.parse(line) as {
										event?: string;
										reason?: string;
										blocking?: boolean;
									},
							)
					: [];
			const wait = async (condition: () => boolean | Promise<boolean>) => {
				for (let i = 0; i < 300; i++) {
					if (await condition()) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error("condition timed out");
			};
			try {
				const envPath = path.join(dir, "run.env");
				fs.writeFileSync(
					envPath,
					`HERDR_RUN_ID='overlap'\nHERDR_TELEMETRY_PATH='${telemetryPath}'\n`,
				);
				await host.ensureRun({
					runId: "overlap",
					name: "overlap",
					cwd: dir,
					runEnvPath: envPath,
					toolPolicy: "default",
					model: `${faux.getModel("small")?.provider}/small`,
				});
				faux.setResponses([
					fauxAssistantMessage([fauxText("ok")]),
					fauxAssistantMessage([fauxText("ok")]),
				]);
				await host.submit(
					"overlap",
					"old history ".repeat(order === "background-first" ? 12000 : 30000),
					"seed-1",
				);
				await wait(
					async () => (await host.status("overlap")).status === "idle",
				);
				await host.submit("overlap", "recent tail", "seed-2");
				await wait(
					async () => (await host.status("overlap")).status === "idle",
				);
				let blockNext = true;
				const responses: Parameters<typeof faux.appendResponses>[0] = [];
				for (let i = 0; i < 10; i++)
					responses.push(async (context) => {
						if (
							JSON.stringify(context.messages[0]).includes(
								"context summarization assistant",
							)
						) {
							const block = blockNext;
							blockNext = false;
							return summarizer(block);
						}
						return fauxAssistantMessage([fauxText("answer")]);
					});
				faux.appendResponses(responses);
				if (order === "manual-first") {
					expect((await host.compactRun("overlap")).status).toBe("started");
					enabled = true;
					await host.submit("overlap", "continue", "next");
					await wait(() => host.compactionWaitersForTest() === 1);
				} else if (order === "background-first") {
					enabled = true;
					await host.submit("overlap", "continue", "background");
					await wait(() => active === 1);
					expect(
						events().find((event) => event.event === "runtime.compaction_start")
							?.blocking,
					).toBe(false);
					await host.submit("overlap", "added ".repeat(60000), "blocking");
					await wait(() => host.compactionWaitersForTest() === 1);
				} else if (order === "concurrent-manual") {
					await Promise.all([
						host.compactRun("overlap"),
						host.compactRun("overlap"),
					]);
					await wait(() => host.compactionWaitersForTest() === 1);
				} else {
					enabled = true;
					await host.submit("overlap", "continue", "next");
					await wait(() => active === 1);
					const requests = await Promise.all([
						host.compactRun("overlap"),
						host.compactRun("overlap"),
					]);
					expect(requests.map((request) => request.status)).toEqual([
						"already-compacting",
						"already-compacting",
					]);
				}
				expect(active).toBe(1);
				// An unrelated conversation needs its own environment AND binding.
				const independentEnv = path.join(dir, "independent.env");
				fs.writeFileSync(independentEnv, "HERDR_RUN_ID='independent'\n");
				await host.ensureRun({
					runId: "independent",
					name: "independent",
					cwd: dir,
					runEnvPath: independentEnv,
					toolPolicy: "default",
					model: `${independent.getModel("wide")?.provider}/wide`,
				});
				independent.setResponses([
					fauxAssistantMessage([fauxText("independent answer")]),
				]);
				await host.submit("independent", "hello", "independent-request");
				await wait(
					async () => (await host.status("independent")).status === "idle",
				);
				expect(active).toBe(1);
				expect((await host.compactRun("overlap")).status).toBe(
					"already-compacting",
				);
				const starts = events().filter(
					(event) => event.event === "runtime.compaction_start",
				);
				expect(starts.map((event) => event.reason)).toEqual(
					order === "manual-first"
						? ["manual", "threshold"]
						: order === "concurrent-manual"
							? ["manual", "manual"]
							: order === "background-first"
								? ["threshold", "threshold"]
								: ["threshold"],
				);
				if (outcome === "shutdown") {
					const closing = host.shutdown();
					release();
					await closing;
					host = await open();
					await host.ensureRun({
						runId: "overlap",
						name: "overlap",
						cwd: dir,
						runEnvPath: envPath,
						toolPolicy: "default",
						model: `${faux.getModel("small")?.provider}/small`,
					});
				} else if (outcome === "cancel") {
					const aborted = host.abort("overlap");
					release();
					await aborted;
				} else release();
				if (outcome === "cancel" || outcome === "shutdown") {
					enabled = false;
					await host.submit(
						"overlap",
						"after interruption",
						"after-interruption",
					);
				}
				await wait(
					async () => (await host.status("overlap")).status === "idle",
				);
				await wait(() => host.compactionWaitersForTest() === 0 && active === 0);
				await wait(
					async () => (await host.liveCompactionCountForTest("overlap")) === 0,
				);
				expect(maximum).toBe(1);
				expect(host.compactionWaitersForTest()).toBe(0);
			} catch (error) {
				console.error({
					order,
					outcome,
					status: await host.status("overlap"),
					active,
					waiters: host.compactionWaitersForTest(),
					live: await host.liveCompactionCountForTest("overlap"),
				});
				throw error;
			} finally {
				release();
				await host.shutdown();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
