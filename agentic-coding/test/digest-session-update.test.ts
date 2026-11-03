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
import {
	applyDigestSessionUpdate,
	digestSessionSettings,
	digestSettingsRevision,
	previewDigestSessionUpdate,
} from "../src/agent-host/digest-session-update.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { schedulingDigest } from "../src/agent-host/scheduled-admission.ts";
import { sessionCommand } from "../src/agent-host/session-command.ts";
import { decodeScheduling } from "../src/contracts/scheduling.ts";
import { schedulingRequestSchema } from "../src/contracts/scheduling-api.ts";
import {
	bindDurableSession,
	createDurableSession,
	deleteDurableSession,
	durableSessionOwner,
	initializeDurableSessions,
	readDurableSessionRegistry,
	requireDurableSession,
} from "../src/pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../src/pi-durable-state.ts";
import {
	DAILY_DIGEST_TASK,
	dailyDigestJobMigration,
	dailyDigestProposal,
} from "../src/scheduling/daily-digest-setup.ts";
import {
	type DigestCollectionSettings,
	validateDigestSettings,
} from "../src/scheduling/digest-settings.ts";

function settings(root: string): DigestCollectionSettings {
	return {
		gitlabHosts: ["gitlab.example.invalid"],
		gitlabToolHost: "gitlab.example.invalid",
		repositoryRoots: [root],
		productionSources: [
			{
				provider: "azure-monitor",
				environment: "production",
				environmentField: "environment",
				environmentValue: "production",
				services: ["synthetic-prod"],
				provenance: "reviewed-config:fixture",
			},
		],
	};
}
test("guarded metadata update preserves identity/selection; stale/foreign/deleted/unbound targets and unsafe settings fail closed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "digest-update-")),
		owner = durableSessionOwner();
	try {
		initializeDurableSessions(root, root, owner);
		const record = createDurableSession(root, {
			operationId: "fixture",
			name: "Digest",
			owner,
			cwd: root,
			model: "fake/model",
			thinking: "off",
			toolPolicy: "collection",
		});
		expect(() =>
			previewDigestSessionUpdate(root, record.id, owner, settings(root)),
		).toThrow("bound");
		bindDurableSession(root, record.id, owner, {
			hostId: "fixture-host",
			conversationId: "fixture-conversation",
		});
		const prior = readDurableSessionRegistry(root),
			preview = previewDigestSessionUpdate(
				root,
				record.id,
				owner,
				settings(root),
			);
		expect(readDurableSessionRegistry(root)).toEqual(prior);
		expect(() =>
			previewDigestSessionUpdate(
				root,
				record.id,
				"foreign-owner",
				settings(root),
			),
		).toThrow();
		for (const invalid of [
			{ ...settings(root), query: "arbitrary" },
			{ ...settings(root), gitlabToolHost: "foreign.example.invalid" },
			{
				...settings(root),
				productionSources: [
					{ ...settings(root).productionSources[0], environment: "qa" },
				],
			},
			{
				...settings(root),
				productionSources: [
					{
						...settings(root).productionSources[0],
						environmentValue: "prod' or true",
					},
				],
			},
			{ ...settings(root), repositoryRoots: ["/"] },
			...["/.", "//", `${root}/..`, `${root}/\0`].map((repositoryRoot) => ({
				...settings(root),
				repositoryRoots: [repositoryRoot],
			})),
			{
				...settings(root),
				productionSources: [
					{ ...settings(root).productionSources[0], environmentValue: "qa" },
				],
			},
		])
			expect(() => validateDigestSettings(invalid)).toThrow();
		const updated = applyDigestSessionUpdate(
			root,
			record.id,
			owner,
			preview.expectedRevision,
			preview.settings,
		);
		for (const key of [
			"id",
			"owner",
			"runId",
			"operationId",
			"name",
			"createdAt",
			"cwd",
			"model",
			"thinking",
			"toolPolicy",
		] as const)
			expect(updated[key]).toEqual(record[key]);
		expect(updated.binding).toEqual(preview.binding);
		expect(readDurableSessionRegistry(root)?.activeId).toBe(prior?.activeId);
		expect(updated.collectionRevision).toBe(1);
		expect(digestSessionSettings(updated)).toEqual(preview.settings);
		expect(() =>
			applyDigestSessionUpdate(
				root,
				record.id,
				owner,
				preview.expectedRevision,
				preview.settings,
			),
		).toThrow("stale");
		deleteDurableSession(root, record.id, owner);
		expect(() =>
			applyDigestSessionUpdate(
				root,
				record.id,
				owner,
				digestSettingsRevision(updated),
				preview.settings,
			),
		).toThrow();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("existing-job migration is nonactivated, revision guarded, exact-destination preserving and exposed without opening a host", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "digest-job-update-")),
		runtimeDir = piDurableRuntimeDir(root),
		owner = durableSessionOwner();
	try {
		initializeDurableSessions(runtimeDir, root, owner);
		const created = createDurableSession(runtimeDir, {
			operationId: "fixture",
			name: "Digest",
			owner,
			cwd: root,
			model: "fake/model",
			thinking: "off",
			toolPolicy: "collection",
		});
		bindDurableSession(runtimeDir, created.id, owner, {
			hostId: "fixture-host",
			conversationId: "fixture-conversation",
		});
		const registry = readDurableSessionRegistry(runtimeDir);
		if (!registry) throw new Error("fixture registry missing");
		const record = requireDurableSession(registry, created.id, owner),
			job = {
				...dailyDigestProposal(record, "main").job,
				id: "existing-job",
				revision: 7,
				task: "old task",
				createdAt: 1,
				updatedAt: 2,
			};
		const result = dailyDigestJobMigration(
			record,
			job,
			"existing-schedule",
			settings(root),
		);
		expect(
			decodeScheduling(schedulingRequestSchema, result.request).operation,
		).toBe("jobs.update");
		expect(result.settingsDiff.proposed.productionSources).toEqual(
			settings(root).productionSources,
		);
		expect(result.settingsExpectedRevision).toBe(
			digestSettingsRevision(record),
		);
		expect(result.activated).toBe(false);
		expect(result.request.revision).toBe(7);
		expect(result.request.affectedSchedules).toEqual(["existing-schedule"]);
		expect(result.request.job).toEqual({
			...dailyDigestProposal(record, "main").job,
			task: DAILY_DIGEST_TASK,
		});
		expect(result.request.job.target).toEqual(job.target);
		expect(() =>
			dailyDigestJobMigration(
				record,
				{ ...job, revision: 0 },
				"existing-schedule",
			),
		).toThrow();
		expect(() =>
			dailyDigestJobMigration(
				{
					...record,
					binding: { hostId: "replacement", conversationId: "replacement" },
				},
				job,
				"existing-schedule",
			),
		).toThrow();
		fs.writeFileSync(path.join(root, "job.json"), JSON.stringify(job));
		fs.writeFileSync(
			path.join(root, "settings-fixture.json"),
			JSON.stringify(settings(root)),
		);
		const output: string[] = [],
			options = {
				configDir: root,
				print: (value: string) => output.push(value),
				open: async (): Promise<never> => {
					throw new Error("must not open host");
				},
			};
		expect(
			await sessionCommand(
				[
					"digest-job-update-proposal",
					record.id,
					"--job",
					path.join(root, "job.json"),
					"--schedule",
					"existing-schedule",
					"--settings",
					path.join(root, "settings-fixture.json"),
				],
				options,
			),
		).toBe(0);
		expect(
			await sessionCommand(
				[
					"digest-settings-preview",
					record.id,
					"--settings",
					path.join(root, "settings-fixture.json"),
				],
				options,
			),
		).toBe(0);
		expect(readDurableSessionRegistry(runtimeDir)).toEqual(registry);
		expect(output.join(" ")).toContain("expectedRevision");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("session help exposes non-mutating migration preview/proposal and revision-fenced apply without opening a host", async () => {
	const output: string[] = [];
	expect(
		await sessionCommand(["--help"], {
			print: (value) => output.push(value),
			open: async () => {
				throw new Error("must not open host");
			},
		}),
	).toBe(0);
	for (const command of [
		"digest-settings-preview ID --settings FILE",
		"digest-settings-apply ID --settings FILE --expected-revision REVISION",
		"digest-job-update-proposal ID --job FILE --schedule ID",
		"--gitlab-tool-host HOST",
		"do not mutate",
		"idle existing host",
	])
		expect(output.join(" ")).toContain(command);
});
test("native collection settings replacement shares admission fencing and recovery cannot restore stale run.env settings", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "digest-native-update-")),
	);
	const keys = [
			"HOME",
			"AGENTIC_CODING_CONFIG_DIR",
			"PI_CODING_AGENT_DIR",
			"HERDR_WIKI_DIR",
		] as const,
		previous = keys.map((key) => [key, process.env[key]] as const);
	let host: DurableHost | undefined;
	let release = () => {};
	try {
		for (const key of keys) process.env[key] = root;
		fs.writeFileSync(
			path.join(root, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"] }),
		);
		const runtimeDir = piDurableRuntimeDir(root),
			owner = durableSessionOwner(),
			faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		initializeDurableSessions(runtimeDir, root, owner);
		const record = createDurableSession(runtimeDir, {
			operationId: "fixture",
			name: "Digest",
			owner,
			cwd: root,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
			thinking: "off",
			toolPolicy: "collection",
		});
		host = await DurableHost.open({
			layout: hostLayout(runtimeDir),
			globalAgentDir: root,
			session: true,
			settings: { localPiTools: { enabled: false } },
			models,
		});
		const env = path.join(root, "run.env");
		fs.writeFileSync(env, 'HERDR_DIGEST_GITLAB_HOSTS=["stale.invalid"]\n');
		const run = {
			runId: record.runId,
			name: record.runId,
			cwd: root,
			runEnvPath: env,
			toolPolicy: "collection" as const,
			model: record.model,
		};
		const opened = await host.ensureRun(run);
		bindDurableSession(runtimeDir, record.id, owner, {
			hostId: await host.scheduledIdentity(),
			conversationId: opened.conversationId,
		});
		const preview = previewDigestSessionUpdate(
			runtimeDir,
			record.id,
			owner,
			settings(root),
		);
		await host.updateDigestSettings({
			sessionId: record.id,
			expectedRevision: preview.expectedRevision,
			settings: preview.settings,
		});
		const contexts = host as unknown as {
			runContexts: Map<string, { env: Record<string, string> }>;
		};
		expect(
			contexts.runContexts.get(record.runId)?.env.HERDR_DIGEST_GITLAB_TOOL_HOST,
		).toBe("gitlab.example.invalid");
		await host.ensureRun({
			...run,
			expectedConversationId: opened.conversationId,
		});
		expect(
			contexts.runContexts.get(record.runId)?.env.HERDR_DIGEST_GITLAB_HOSTS,
		).toBe('["gitlab.example.invalid"]');
		await expect(
			host.updateDigestSettings({
				sessionId: record.id,
				expectedRevision: preview.expectedRevision,
				settings: preview.settings,
			}),
		).rejects.toThrow("Stale");
		expect(
			readDurableSessionRegistry(runtimeDir)?.sessions.filter(
				(session) => session.id === record.id,
			),
		).toHaveLength(1);
		await host.shutdown();
		host = await DurableHost.open({
			layout: hostLayout(runtimeDir),
			globalAgentDir: root,
			session: true,
			settings: { localPiTools: { enabled: false } },
			models,
		});
		await host.ensureRun({
			...run,
			expectedConversationId: opened.conversationId,
		});
		const recovered = host as unknown as {
			runContexts: Map<string, { env: Record<string, string> }>;
		};
		expect(
			recovered.runContexts.get(record.runId)?.env.HERDR_DIGEST_GITLAB_HOSTS,
		).toBe('["gitlab.example.invalid"]');
		const next = previewDigestSessionUpdate(
			runtimeDir,
			record.id,
			owner,
			settings(root),
		);
		const update = {
			sessionId: record.id,
			expectedRevision: next.expectedRevision,
			settings: {
				...next.settings,
				gitlabHosts: ["gitlab.changed.invalid"],
				gitlabToolHost: "gitlab.changed.invalid",
			},
		};
		const text = "synthetic admission race",
			envelope = {
				runId: record.runId,
				occurrenceId: "settings-race",
				nominalDue: Date.now(),
				text,
				digest: schedulingDigest(text),
				expectedHostId: await host.scheduledIdentity(),
				expectedConversationId: opened.conversationId,
			};
		const raced = await Promise.allSettled([
			host.scheduledAdmission("reserve", envelope, 1),
			host.updateDigestSettings(update),
		]);
		expect(raced[0]?.status).toBe("fulfilled");
		const afterRace = previewDigestSessionUpdate(
			runtimeDir,
			record.id,
			owner,
			settings(root),
		);
		expect(afterRace.expectedRevision === next.expectedRevision).toBe(
			raced[1]?.status === "rejected",
		);
		update.expectedRevision = afterRace.expectedRevision;
		expect(
			recovered.runContexts.get(record.runId)?.env.HERDR_DIGEST_GITLAB_HOSTS,
		).toBe(JSON.stringify(afterRace.prior.gitlabHosts));
		expect(
			recovered.runContexts.get(record.runId)?.env
				.HERDR_DIGEST_GITLAB_TOOL_HOST,
		).toBe(afterRace.prior.gitlabToolHost ?? "");
		let entered = () => {};
		const entry = new Promise<void>((resolve) => {
				entered = resolve;
			}),
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
		faux.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage([fauxText("fixture completed")]);
			},
		]);
		await host.scheduledAdmission("activate", envelope, 1);
		await Promise.race([
			entry,
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("fixture turn did not start")), 3000),
			),
		]);
		await expect(host.updateDigestSettings(update)).rejects.toThrow(
			"Unsafe admission",
		);
		expect(
			previewDigestSessionUpdate(runtimeDir, record.id, owner, settings(root))
				.expectedRevision,
		).toBe(update.expectedRevision);
		release();
	} finally {
		release();
		await host?.shutdown();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
