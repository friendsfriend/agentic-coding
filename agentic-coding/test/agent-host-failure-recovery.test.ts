import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	Harness,
	type ReportInfo,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

const ISOLATED_ENV = [
	"HOME",
	"AGENTIC_CODING_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"HERDR_WIKI_DIR",
] as const;

type HarnessReporter = (error: unknown, info: ReportInfo) => void;
type MutableHarnessClass = {
	open: typeof Harness.open;
};

function isolateHome(root: string): () => void {
	const previous = new Map<string, string | undefined>();
	const values: Record<(typeof ISOLATED_ENV)[number], string> = {
		HOME: path.join(root, "home"),
		AGENTIC_CODING_CONFIG_DIR: path.join(root, "config"),
		PI_CODING_AGENT_DIR: path.join(root, "pi"),
		HERDR_WIKI_DIR: path.join(root, "wiki"),
	};
	for (const key of ISOLATED_ENV) {
		previous.set(key, process.env[key]);
		fs.mkdirSync(values[key], { recursive: true });
		process.env[key] = values[key];
	}
	return () => {
		for (const key of ISOLATED_ENV) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function installWorkflowCli(root: string): {
	statePath: string;
	restore: () => void;
} {
	const bin = path.join(root, "bin");
	const statePath = path.join(root, "workflow-state");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(statePath, "active");
	const executable = path.join(bin, "agentic-coding");
	fs.writeFileSync(
		executable,
		'#!/bin/sh\nif [ "$1" = "workflow" ] && [ "$2" = "resume-run" ]; then\n  printf \'{"state":"%s"}\\n\' "$(cat "$HERDR_TEST_STATE_FILE")"\n  exit 0\nfi\nexit 2\n',
	);
	fs.chmodSync(executable, 0o700);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
	return {
		statePath,
		restore: () => {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		},
	};
}

function writeRunEnv(
	dir: string,
	runId: string,
	workflowStateFile?: string,
): { path: string; telemetry: string } {
	const telemetry = path.join(dir, `${runId}.telemetry.jsonl`);
	const envPath = path.join(dir, `${runId}.env`);
	fs.writeFileSync(
		envPath,
		[
			`HERDR_WORKFLOW_ID='workflow-${runId}'`,
			`HERDR_RUN_ID='${runId}'`,
			"HERDR_STEP_ID='core.implementation'",
			"HERDR_ROLE='worker'",
			"HERDR_PROFILE='durable-default'",
			`HERDR_TELEMETRY_PATH='${telemetry}'`,
			...(workflowStateFile
				? [
						"HERDR_RUN_TOKEN='isolated-test-token'",
						`HERDR_TEST_STATE_FILE='${workflowStateFile}'`,
					]
				: []),
		].join("\n"),
	);
	return { path: envPath, telemetry };
}

async function openHost(
	dir: string,
	storage: Storage,
	captureReporter: (reporter: HarnessReporter) => void,
	log?: (line: string) => void,
	retryCapability?: string,
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const mutable = Harness as unknown as MutableHarnessClass;
	const originalOpen = mutable.open;
	mutable.open = (async (...args: Parameters<typeof Harness.open>) => {
		const options = args[1] as unknown as {
			onReport?: HarnessReporter;
		};
		if (options.onReport) captureReporter(options.onReport);
		return originalOpen(...args);
	}) as typeof Harness.open;
	try {
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage,
			models,
			...(log ? { log } : {}),
			...(retryCapability ? { retryCapability } : {}),
		});
		return { host, faux };
	} finally {
		mutable.open = originalOpen;
	}
}

async function waitForStatus(
	host: DurableHost,
	runId: string,
	predicate: (status: Awaited<ReturnType<DurableHost["status"]>>) => boolean,
): Promise<Awaited<ReturnType<DurableHost["status"]>>> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const status = await host.status(runId);
		if (predicate(status)) return status;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return await host.status(runId);
}

async function waitForIdle(host: DurableHost, runId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await host.status(runId)).status === "idle") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the faux provider turn did not settle");
}

test("same-uid socket callers cannot retry without the launcher capability", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-retry-auth-"));
	const storage = await openNodeJsonlStorage(
		path.join(dir, "storage.jsonl"),
		BACKGROUND_CONTEXT,
	);
	const capability = "a".repeat(64);
	const { host } = await openHost(
		dir,
		storage,
		() => {},
		undefined,
		capability,
	);
	await host.listen();
	try {
		const { harness } = host as unknown as { harness: Harness };
		const originalWake = harness.wake;
		try {
			expect(host.prepareRestartForReattachment()).toBe("ready");
			harness.wake = () => ({ active: true });
			expect(host.prepareRestartForReattachment()).toBe("busy");
			harness.wake = () => ({ active: false, at: Date.now() + 60_000 });
			expect(host.prepareRestartForReattachment()).toBe("busy");
		} finally {
			harness.wake = originalWake;
		}
		const client = new HostClient(hostLayout(dir).socketPath, 2_000);
		await expect(
			client.retryTask("run-1", "conversation-1", "task-1", 1),
		).resolves.toMatchObject({
			status: "refused",
			reason: "operator recovery authority required",
		});
		const malformed = new HostClient(
			hostLayout(dir).socketPath,
			2_000,
			"😀".repeat(32),
		);
		await expect(
			malformed.retryTask("run-1", "conversation-1", "task-1", 1),
		).resolves.toMatchObject({
			status: "refused",
			reason: "operator recovery authority required",
		});
	} finally {
		await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function taskReport(conversationId: number): ReportInfo {
	return {
		type: "task_parked",
		task: {
			id: 7 as TaskId,
			kind: "worker.task",
			conversationId: conversationId as unknown as ConversationId,
		},
	};
}

function asRecordForTest(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

describe("durable Harness failure visibility and recovery", () => {
	test("retains structured reports across reopen and permits only an owned explicit native retry", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "durable-failure-recovery-"),
		);
		const restoreEnv = isolateHome(root);
		const workflowCli = installWorkflowCli(root);
		const dir = path.join(root, "host");
		fs.mkdirSync(dir, { recursive: true });
		const storagePath = path.join(root, "durable-store");
		let reporter: HarnessReporter | undefined;
		let host: DurableHost | undefined;
		let continuationHost: DurableHost | undefined;
		let tempTaskState: unknown;
		let retryCalls = 0;
		try {
			const first = await openHost(
				dir,
				await openNodeJsonlStorage(storagePath, BACKGROUND_CONTEXT),
				(value) => (reporter = value),
				() => {
					throw new Error("diagnostic logger failed");
				},
			);
			host = first.host;
			// This recovery fixture represents already-issued legacy ownership, not
			// new managed dispatch (which now requires a server-verified claim).
			const issued = await host.ensureRun({
				runEnvPath: "",
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				toolPolicy: "default",
				model: `${first.faux.getModel().provider}/${first.faux.getModel().id}`,
			});
			await host.stopRun("run-1");
			const env = writeRunEnv(dir, "run-1", workflowCli.statePath);
			const run = await host.ensureRun({
				expectedConversationId: issued.conversationId,
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: env.path,
				toolPolicy: "default",
				model: `${first.faux.getModel().provider}/${first.faux.getModel().id}`,
			});
			const report = reporter;
			if (!report) throw new Error("Harness did not expose onReport");
			const conversationId = Number(run.conversationId);
			const secret = "sk-live-abcdefghijklmnop";
			// Real Harness reports retain structured error class/reason only, never the
			// free-form message where prompts or tool payloads may appear.
			const extensionError = new Error(`raw prompt ${secret}`);
			extensionError.name = secret;
			report(extensionError, {
				type: "extension_error",
				conversationId: conversationId as unknown as ConversationId,
			});
			const extensionVisible = await waitForStatus(
				host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "extension_failure",
			);
			expect(extensionVisible.runtimeFailure).toMatchObject({
				kind: "extension_failure",
				domain: "extension",
			});
			expect(extensionVisible.runtimeFailure?.error).toBe("HarnessError");
			report(new Error("task faulted"), {
				type: "task_faulted",
				conversationId,
			} as unknown as ReportInfo);
			const faultedVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "task_faulted",
			);
			expect(faultedVisible.runtimeFailure).toMatchObject({
				kind: "task_faulted",
				domain: "task",
			});
			report(new Error("host failed"), {
				type: "host_error",
				conversationId,
			} as unknown as ReportInfo);
			const hostFailureVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "host_failure",
			);
			expect(hostFailureVisible.runtimeFailure).toMatchObject({
				kind: "host_failure",
				domain: "host",
			});
			report(new Error("session failed"), {
				type: "session_failed",
				conversationId,
			} as unknown as ReportInfo);
			const sessionFailureVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "session_failure",
			);
			expect(sessionFailureVisible.runtimeFailure).toMatchObject({
				kind: "session_failure",
				domain: "session",
			});
			report(new Error("outdated"), {
				type: "task_outdated",
				reason: "incompatible_task",
				conversationId,
			} as unknown as ReportInfo);
			const outdatedVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "other_failure",
			);
			expect(outdatedVisible.runtimeFailure).toMatchObject({
				kind: "other_failure",
				domain: "task",
				reason: "incompatible_task",
			});
			report(new Error("migration"), {
				type: "migration_failed",
				conversationId,
			} as unknown as ReportInfo);
			const migrationVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) =>
					status.runtimeFailure?.kind === "other_failure" &&
					status.runtimeFailure.domain === "task" &&
					status.runtimeFailure.reason === undefined,
			);
			expect(migrationVisible.runtimeFailure).toMatchObject({
				kind: "other_failure",
				domain: "task",
			});
			report(new Error("task faulted again"), {
				type: "task_faulted",
				conversationId,
			} as unknown as ReportInfo);
			await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "task_faulted",
			);
			report(new Error("task error"), {
				type: "task_error",
				conversationId,
			} as unknown as ReportInfo);
			const taskErrorVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) =>
					status.runtimeFailure?.kind === "other_failure" &&
					status.runtimeFailure.domain === "task" &&
					status.runtimeFailure.reason === undefined,
			);
			expect(taskErrorVisible.runtimeFailure).toMatchObject({
				kind: "other_failure",
				domain: "task",
			});
			report(new Error("listener error"), {
				type: "listener_error",
				conversationId,
			} as unknown as ReportInfo);
			const listenerVisible = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "host_failure",
			);
			expect(listenerVisible.runtimeFailure).toMatchObject({
				kind: "host_failure",
				domain: "host",
			});
			report(new Error(`tool arguments ${secret}`), taskReport(conversationId));
			const visible = await waitForStatus(
				host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "task_parked",
			);
			expect(visible.status).not.toBe("blocked");
			expect(visible.runtimeFailure).toMatchObject({
				kind: "task_parked",
				domain: "task",
				taskId: "7",
				reason: "restart_limit",
			});
			const telemetryPath = env.telemetry;
			const firstTelemetry = fs.readFileSync(telemetryPath, "utf8");
			expect(firstTelemetry).toContain("runtime.failure");
			expect(firstTelemetry).toContain("task_parked");
			expect(firstTelemetry).toContain("extension_failure");
			expect(firstTelemetry).not.toContain("developer_question");
			expect(firstTelemetry).not.toContain(secret);
			expect(firstTelemetry).not.toContain("raw prompt");
			expect(firstTelemetry).not.toContain("tool arguments");
			const failureInternals = first.host as unknown as {
				clearRuntimeFailure: (
					conversationId: number,
					generation: number,
				) => Promise<void>;
			};
			await failureInternals.clearRuntimeFailure(conversationId, 0);
			expect((await first.host.status("run-1")).runtimeFailure).toMatchObject({
				kind: "task_parked",
				domain: "task",
			});
			report(new Error("parked again"), taskReport(conversationId));
			const persistedParked = await waitForStatus(
				first.host,
				"run-1",
				(status) => status.runtimeFailure?.kind === "task_parked",
			);
			const persistedGeneration = persistedParked.runtimeFailure?.generation;
			if (persistedGeneration === undefined)
				throw new Error("persisted parked report has no generation");
			const hostLogPath = hostLayout(dir).logPath;
			let hostDiagnostics = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					hostDiagnostics = fs.readFileSync(hostLogPath, "utf8");
				} catch {
					// The asynchronous diagnostic writer has not created the log yet.
				}
				if (
					hostDiagnostics.includes("harness extension_failure") &&
					hostDiagnostics.includes("task_parked")
				)
					break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(hostDiagnostics).toContain("harness extension_failure");
			expect(hostDiagnostics).toContain("task_parked");
			expect(hostDiagnostics).toContain("restart_limit");
			expect(hostDiagnostics).not.toContain(secret);
			expect(hostDiagnostics).not.toContain("raw prompt");
			expect(hostDiagnostics).not.toContain("tool arguments");
			await host.shutdown();
			host = undefined;

			// Reopen the same durable store and association. The parked identity is
			// still visible after a host restart instead of depending on a live callback.
			const reopened = await openHost(
				dir,
				await openNodeJsonlStorage(storagePath, BACKGROUND_CONTEXT),
				(value) => (reporter = value),
			);
			continuationHost = reopened.host;
			const continuationInternals = continuationHost as unknown as {
				harness: Harness;
				runtimeFailureListeners: Map<number, Set<() => void>>;
				clearRuntimeFailure: (
					conversationId: ConversationId,
					generation: number,
				) => Promise<void>;
			};
			const originalGetTask = continuationInternals.harness.getTask;
			const originalInspect = continuationInternals.harness.inspect;
			const originalCommit = continuationInternals.harness.commit.bind(
				continuationInternals.harness,
			);
			let scanCalls = 0;
			tempTaskState = {
				record: {
					id: 7,
					conversationId: conversationId as unknown as ConversationId,
					restarts: 5,
					state: { status: "pending", checkpoint: {} },
				},
				state: { kind: "blocked", reason: "restart_limit" },
			};
			continuationInternals.harness.getTask = (async () =>
				tempTaskState) as Harness["getTask"];
			continuationInternals.harness.inspect = async () => {
				throw new Error("recovery must not inspect global host work");
			};
			continuationInternals.harness.commit = (change, context) =>
				originalCommit(async (tx) => {
					const originalScan = tx.scanTasks;
					tx.scanTasks = async (query, limit, cursor) => {
						scanCalls++;
						expect(query.status).toBe("pending");
						expect(query.conversationId).toBeDefined();
						expect(limit).toBe(64);
						expect(cursor).toBeUndefined();
						const task = asRecordForTest(tempTaskState);
						const record = asRecordForTest(task?.record) ?? task;
						return {
							items:
								query.conversationId === conversationId && record
									? ([record] as unknown as Awaited<
											ReturnType<typeof tx.scanTasks>
										>["items"])
									: [],
						};
					};
					try {
						return await change(tx);
					} finally {
						tx.scanTasks = originalScan;
					}
				}, context);
			await continuationInternals.clearRuntimeFailure(
				conversationId as unknown as ConversationId,
				persistedGeneration,
			);
			const rebound = await continuationHost.ensureRun({
				expectedConversationId: run.conversationId,
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: env.path,
				toolPolicy: "default",
				model: `${reopened.faux.getModel().provider}/${reopened.faux.getModel().id}`,
			});
			expect(rebound.conversationId).toBe(run.conversationId);
			expect(scanCalls).toBe(1);
			// The synthetic parked record cannot hide real unbound scheduler work.
			expect(continuationHost.prepareRestartForReattachment()).toBe("busy");
			const reopenedHost = continuationHost;
			if (!reopenedHost) throw new Error("reopened host is unavailable");
			const originalSnapshot = continuationInternals.harness.snapshot;
			continuationInternals.harness.snapshot = async () => {
				throw new Error("private diagnostic read failure");
			};
			try {
				const degradedStatus = await reopenedHost.status("run-1");
				expect(degradedStatus.runtimeFailure).toBeUndefined();
				const watched: unknown[] = [];
				const stopWatch = await reopenedHost.watchRun("run-1", (value) => {
					watched.push(value);
				});
				stopWatch();
				expect(watched).toHaveLength(1);
				expect(asRecordForTest(watched[0])?.runtimeFailure).toBeUndefined();
			} finally {
				continuationInternals.harness.snapshot = originalSnapshot;
			}
			const reopenedStatus = await reopenedHost.status("run-1");
			const initialGeneration = reopenedStatus.runtimeFailure?.generation;
			if (initialGeneration === undefined)
				throw new Error("parked report has no generation");
			let reportGeneration: number = initialGeneration;
			const firstEpisodeGeneration = reportGeneration;
			const retryFor = (runId: string, conversation: string, taskId: string) =>
				reopenedHost.retryParkedTask(
					runId,
					conversation,
					taskId,
					reportGeneration,
				);
			expect(reopenedStatus.runtimeFailure).toMatchObject({
				kind: "task_parked",
				taskId: "7",
				reason: "restart_limit",
			});
			// A repeated parked report after reopen is idempotent and remains bounded.
			reporter?.(
				new Error(`private prompt ${secret}`),
				taskReport(conversationId),
			);
			await waitForStatus(
				continuationHost,
				"run-1",
				(status) => status.runtimeFailure?.taskId === "7",
			);

			const secondIssued = await continuationHost.ensureRun({
				runEnvPath: "",
				runId: "run-2",
				name: "worker-2",
				cwd: dir,
				toolPolicy: "default",
			});
			// Fresh native issuance still needs no recovery scan.
			expect(scanCalls).toBe(1);
			await continuationHost.stopRun("run-2");
			const secondEnv = writeRunEnv(dir, "run-2");
			const secondRun = await continuationHost.ensureRun({
				expectedConversationId: secondIssued.conversationId,
				runId: "run-2",
				name: "worker-2",
				cwd: dir,
				runEnvPath: secondEnv.path,
				toolPolicy: "default",
			});
			// Explicit legacy reattachment performs one conversation-scoped scan.
			expect(scanCalls).toBe(2);
			// Even a correct task id cannot be replayed through a different run's
			// conversation, and a stale identity is not forwarded to native retry.
			expect(
				await retryFor("run-1", secondRun.conversationId, "7"),
			).toMatchObject({ status: "refused" });
			expect(
				await retryFor("run-2", secondRun.conversationId, "7"),
			).not.toMatchObject({ status: "retried" });

			const internal = continuationInternals.harness;
			const originalRetryTask = internal.retryTask;
			let releaseNativeRetry: (() => void) | undefined;
			internal.retryTask = async () => {
				retryCalls++;
				await new Promise<void>((resolve) => {
					releaseNativeRetry = resolve;
				});
				tempTaskState = {
					id: 7,
					conversationId,
					state: { status: "pending", checkpoint: {} },
				};
			};
			try {
				tempTaskState = {
					record: {
						id: 7,
						conversationId,
						restarts: 5,
						state: { status: "pending", checkpoint: {} },
					},
					state: { kind: "blocked", reason: "restart_limit" },
				};
				fs.writeFileSync(workflowCli.statePath, "blocked");
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "refused",
					reason: "workflow is blocked",
				});
				expect(retryCalls).toBe(0);
				fs.writeFileSync(workflowCli.statePath, "active");
				const retry = retryFor("run-1", run.conversationId, "7");
				for (let attempt = 0; attempt < 100 && !releaseNativeRetry; attempt++)
					await new Promise((resolve) => setTimeout(resolve, 1));
				if (!releaseNativeRetry)
					throw new Error(
						`native retry did not start: ${JSON.stringify(await retry)}`,
					);
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "already-in-progress",
				});
				releaseNativeRetry();
				const retryResult = await retry;
				expect(retryResult).toMatchObject({ status: "retried" });
				expect(retryCalls).toBe(1);
				let duplicateReportFinished = false;
				const duplicateReportListener = () => {
					duplicateReportFinished = true;
				};
				const listeners =
					continuationInternals.runtimeFailureListeners.get(conversationId) ??
					new Set<() => void>();
				listeners.add(duplicateReportListener);
				continuationInternals.runtimeFailureListeners.set(
					conversationId,
					listeners,
				);
				reporter?.(
					new Error("duplicate parked report"),
					taskReport(conversationId),
				);
				for (
					let attempt = 0;
					attempt < 100 && !duplicateReportFinished;
					attempt++
				)
					await new Promise((resolve) => setTimeout(resolve, 1));
				listeners.delete(duplicateReportListener);
				expect(duplicateReportFinished).toBe(true);
				const duplicateReport = await reopenedHost.status("run-1");
				expect(duplicateReport.runtimeFailure).toBeUndefined();
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "stale",
				});
				expect(retryCalls).toBe(1);
				tempTaskState = {
					record: {
						id: 7,
						conversationId,
						restarts: 5,
						state: { status: "pending", checkpoint: {} },
					},
					state: { kind: "blocked", reason: "restart_limit" },
				};
				reporter?.(
					new Error("reparked after accepted retry"),
					taskReport(conversationId),
				);
				const reparked = await waitForStatus(
					continuationHost,
					"run-1",
					(status) =>
						(status.runtimeFailure?.generation ?? 0) > reportGeneration,
				);
				reportGeneration = reparked.runtimeFailure?.generation ?? 0;
				expect(reportGeneration).toBeGreaterThan(firstEpisodeGeneration);
				internal.retryTask = async () => {
					retryCalls++;
					tempTaskState = {
						id: 7,
						conversationId,
						state: { status: "pending", checkpoint: {} },
					};
				};
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "retried",
				});
				expect(retryCalls).toBe(2);
				// No status/watch read observes the reset to zero. A second crash
				// loop reaching the SAME limit must still become a new episode.
				tempTaskState = {
					id: 7,
					conversationId,
					restarts: 5,
					state: { status: "pending", checkpoint: {} },
				};
				reporter?.(new Error("another crash loop"), taskReport(conversationId));
				const repeated = await waitForStatus(
					continuationHost,
					"run-1",
					(status) =>
						(status.runtimeFailure?.generation ?? 0) > reportGeneration,
				);
				expect(repeated.runtimeFailure?.generation).toBeGreaterThan(
					reportGeneration,
				);
				expect(
					await reopenedHost.retryParkedTask(
						"run-1",
						run.conversationId,
						"7",
						reportGeneration,
					),
				).toMatchObject({ status: "stale" });
				reportGeneration = repeated.runtimeFailure?.generation ?? 0;
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "retried",
				});
				expect(retryCalls).toBe(3);
				const resumedTask = asRecordForTest(tempTaskState);
				if (!resumedTask) throw new Error("parked task state is unavailable");
				tempTaskState = {
					...resumedTask,
					state: { kind: "ready", migrates: false },
				};
				await continuationHost.status("run-1");
				expect(
					(await continuationHost.status("run-1")).runtimeFailure,
				).toBeUndefined();

				// A completed native retry leaves the conversation usable. The next
				// native turn settles idle and does not alter workflow lifecycle state.
				// This unit fixture invokes the host's internal admission boundary;
				// it deliberately does not authorize an unfenced control-socket turn.
				reopened.faux.setResponses([
					fauxAssistantMessage([fauxText("continued")]),
				]);
				await continuationHost.submit(
					"run-1",
					"continue after explicit retry",
					"after-retry",
					"followUp",
					true,
				);
				await waitForIdle(continuationHost, "run-1");

				// A finished workflow and a stale terminal task are both refused before
				// native retry; neither path can revive a terminal workflow.
				tempTaskState = {
					record: {
						id: 7,
						conversationId,
						state: { status: "pending", checkpoint: {} },
					},
					state: { kind: "blocked", reason: "restart_limit" },
				};
				reporter?.(new Error("parked"), taskReport(conversationId));
				const nextReport = await waitForStatus(
					continuationHost,
					"run-1",
					(status) => status.runtimeFailure?.taskId === "7",
				);
				reportGeneration = nextReport.runtimeFailure?.generation ?? 0;
				if (reportGeneration < 1)
					throw new Error("new parked report has no generation");
				expect(reportGeneration).not.toBe(firstEpisodeGeneration);
				expect(
					await reopenedHost.retryParkedTask(
						"run-1",
						run.conversationId,
						"7",
						firstEpisodeGeneration,
					),
				).toMatchObject({ status: "stale" });
				internal.retryTask = async () => {
					retryCalls++;
					throw new Error("native retry outcome cannot be read safely");
				};
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "already-in-progress",
					reason: "native retry outcome is uncertain; do not resubmit",
				});
				expect(retryCalls).toBe(4);
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "already-in-progress",
				});
				expect(retryCalls).toBe(4);
				fs.writeFileSync(workflowCli.statePath, "finished");
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "refused",
				});
				expect(retryCalls).toBe(4);
				tempTaskState = {
					id: 7,
					conversationId,
					state: { status: "terminal", outcome: "success" },
				};
				expect(await retryFor("run-1", run.conversationId, "7")).toMatchObject({
					status: "stale",
				});
				expect(retryCalls).toBe(4);
			} finally {
				internal.commit = originalCommit;
				if (originalGetTask !== undefined) internal.getTask = originalGetTask;
				if (originalInspect !== undefined) internal.inspect = originalInspect;
				if (originalRetryTask !== undefined)
					internal.retryTask = originalRetryTask;
			}
		} finally {
			await continuationHost?.shutdown();
			await host?.shutdown();
			workflowCli.restore();
			restoreEnv();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
