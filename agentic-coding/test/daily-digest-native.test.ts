import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { CODEMODE_TOOL_NAME } from "../src/agent-host/codemode.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { schedulingDigest } from "../src/agent-host/scheduled-admission.ts";
import {
	type DigestCoverage,
	dailyDigestWindow,
} from "../src/scheduling/daily-digest.ts";
import { normalizeDigestSourcePage } from "../src/scheduling/digest-sources.ts";
import { buildAgentSessionView } from "../src/tui/dash/agent-session.ts";
import { fakeDigestWizMcp } from "./helpers/digest-wiz-mcp.ts";

test("native scheduled collection paginates fake MCP through codemode, stays read-only and links one visible report across restart", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "digest-native-"));
	const keys = [
		"HOME",
		"AGENTIC_CODING_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"HERDR_WIKI_DIR",
	] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	let host: DurableHost | undefined,
		wiz: Awaited<ReturnType<typeof fakeDigestWizMcp>> | undefined;
	try {
		process.env.HOME = root;
		process.env.AGENTIC_CODING_CONFIG_DIR = path.join(root, "config");
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
		fs.writeFileSync(
			path.join(root, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"] }),
		);
		const env = path.join(root, "run.env"),
			marker = path.join(root, "must-not-exist");
		fs.writeFileSync(env, "");
		const nominalDue = Date.parse("2026-03-30T07:00:00Z"),
			at = nominalDue - 1000;
		const pages = [
			{
				findings: [
					{
						id: "fake-finding",
						title: "Synthetic finding",
						url: "https://wiz.example.invalid/fake",
						createdAt: new Date(at).toISOString(),
						severity: "HIGH",
						status: "OPEN",
						exposure: "PUBLIC",
					},
				],
				pageInfo: { hasNextPage: true, endCursor: "page-2" },
			},
			{
				findings: [
					{
						id: "fake-low",
						title: "Synthetic low finding",
						url: "https://wiz.example.invalid/low",
						createdAt: new Date(at).toISOString(),
						severity: "LOW",
						status: "OPEN",
					},
				],
				pageInfo: { hasNextPage: false },
			},
		];
		wiz = await fakeDigestWizMcp(root, pages);
		const faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		const options = {
			layout: hostLayout(root),
			globalAgentDir: root,
			session: true,
			settings: { localPiTools: { enabled: true } },
			models,
		};
		host = await DurableHost.open(options);
		const run = {
			runId: "pi-durable-digest-fixture",
			name: "pi-durable-digest-fixture",
			cwd: root,
			runEnvPath: env,
			toolPolicy: "collection" as const,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		};
		const opened = await host.ensureRun(run);
		const events = pages.flatMap(
			(value) =>
				normalizeDigestSourcePage({
					source: "wiz",
					scope: "synthetic",
					window: dailyDigestWindow(nominalDue),
					value,
				}).items,
		);
		const coverage: DigestCoverage[] = [
			{
				source: "wiz",
				scope: "synthetic",
				status: "success",
				pages: 2,
				items: 2,
				truncated: false,
				missingFields: [],
				diagnostics: [],
			},
			{
				source: "jira",
				scope: "synthetic",
				status: "unavailable",
				pages: 0,
				items: 0,
				truncated: false,
				missingFields: [],
				diagnostics: ["source-query-failed-check-integration-access"],
			},
			{
				source: "gitlab",
				scope: "synthetic",
				status: "unavailable",
				pages: 0,
				items: 0,
				truncated: false,
				missingFields: [],
				diagnostics: ["no-local-projects-no-query"],
			},
		];
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `const denied = []; for (const name of ["bash", "write", "edit", "start_workflow"]) { try { await tools[name]({ path: ${JSON.stringify(marker)}, content: "unsafe", command: "touch " + ${JSON.stringify(marker)} }); } catch { denied.push(name); } } if (denied.length !== 4) throw new Error("unsafe tool reached"); return "all unsafe tools denied";`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `text(await tools.mcp__wiz__discover({})); text(await tools.mcp__wiz__execute({ tool_name: "list_issues", parameters: { created_after: "2026-03-29T07:00:00Z", created_before: "2026-03-30T07:00:00Z", first: 1 } })); text(await tools.mcp__wiz__execute({ tool_name: "list_issues", parameters: { created_after: "2026-03-29T07:00:00Z", created_before: "2026-03-30T07:00:00Z", first: 1, after: "page-2" } }));`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			...pages.map((value) =>
				fauxAssistantMessage(
					[
						fauxToolCall("normalize_digest_source_page", {
							source: "wiz",
							scope: "synthetic",
							nominalDue,
							rawJson: JSON.stringify(value),
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			fauxAssistantMessage(
				[
					fauxToolCall("render_daily_digest", {
						occurrenceId: "fake-occurrence",
						nominalDue,
						events: events.map((event) => ({ ...event })),
						coverage: coverage.map((entry) => ({
							...entry,
							missingFields: [...entry.missingFields],
							diagnostics: [...entry.diagnostics],
						})),
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "render_daily_digest",
				);
				if (result?.role !== "toolResult" || result.isError)
					throw new Error("Synthetic report render failed");
				return fauxAssistantMessage([
					fauxText(
						result.content
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("\n"),
					),
				]);
			},
		]);
		const text =
			"Synthetic daily digest occurrence only. Do not query live sources.";
		const envelope = {
			occurrenceId: "fake-occurrence",
			text,
			digest: schedulingDigest(text),
			runId: run.runId,
			expectedHostId: await host.scheduledIdentity(),
			expectedConversationId: opened.conversationId,
		};
		await host.scheduledAdmission("reserve", envelope, 1);
		await host.scheduledAdmission("activate", envelope, 1);
		let receipt = await host.scheduledAdmission("query", envelope, 1);
		for (let index = 0; index < 500 && receipt.state !== "succeeded"; index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			receipt = await host.scheduledAdmission("query", envelope, 1);
		}
		expect(receipt.state).toBe("succeeded");
		expect(receipt.submission?.answerEntryId).toBeDefined();
		expect(receipt.result).toContain("Daily task digest");
		expect(receipt.result).toContain("fake-finding");
		expect(receipt.result).toContain("fake-low");
		expect(receipt.result).toContain("observed status OPEN");
		expect(receipt.result).toContain("exposure PUBLIC");
		expect(wiz.calls.map((call) => call.tool)).toEqual([
			"discover",
			"list_issues",
			"list_issues",
		]);
		expect(wiz.calls[2]?.parameters.after).toBe("page-2");
		expect(fs.existsSync(marker)).toBe(false);
		const entries = await host.entriesForTest(envelope.runId);
		const results = entries.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"kind" in entry &&
				entry.kind === "pi.tool-result",
		);
		expect(JSON.stringify(results)).toContain("all unsafe tools denied");
		expect(JSON.stringify(results)).toContain("fake-finding:created");
		expect(JSON.stringify(results)).toContain("partial or unavailable");
		const modelCalls = faux.state.callCount;
		await host.shutdown();
		host = await DurableHost.open(options);
		expect((await host.ensureRun(run)).conversationId).toBe(
			opened.conversationId,
		);
		expect(await host.scheduledIdentity()).toBe(envelope.expectedHostId);
		await host.scheduledAdmission("activate", envelope, 1);
		expect(
			(await host.scheduledAdmission("query", envelope, 1)).submission,
		).toEqual(receipt.submission);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(
			wiz.calls.filter((call) => call.tool === "list_issues"),
		).toHaveLength(2);
		let visible = "";
		const stopWatching = await host.watchRun(envelope.runId, (value) => {
			visible = JSON.stringify(buildAgentSessionView(value));
		});
		try {
			expect(visible).toContain("Daily task digest");
			expect(visible).toContain("fake-finding");
			expect(visible).toContain("fake-low");
		} finally {
			await stopWatching();
		}
		expect(faux.state.callCount).toBe(modelCalls);
		await expect(
			host.scheduledAdmission(
				"reserve",
				{ ...envelope, expectedHostId: "foreign-store" },
				2,
			),
		).rejects.toThrow("identity mismatch");
	} finally {
		try {
			await host?.shutdown();
		} finally {
			try {
				await wiz?.close();
			} finally {
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				fs.rmSync(root, { force: true, recursive: true });
			}
		}
	}
}, 30_000);
