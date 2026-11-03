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
import { fakeDigestLogMcp } from "./helpers/digest-log-mcp.ts";

test("native production reads use trusted scheduled window, private receipt custody, one bounded collection and unforgeable report evidence", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "digest-production-native-")),
	);
	const keys = [
			"HOME",
			"AGENTIC_CODING_CONFIG_DIR",
			"PI_CODING_AGENT_DIR",
			"HERDR_WIKI_DIR",
		] as const,
		previous = keys.map((key) => [key, process.env[key]] as const);
	let host: DurableHost | undefined,
		mcp: Awaited<ReturnType<typeof fakeDigestLogMcp>> | undefined;
	try {
		for (const key of keys) process.env[key] = root;
		fs.writeFileSync(
			path.join(root, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"] }),
		);
		const nominalDue = Date.now() - 1000;
		mcp = await fakeDigestLogMcp(root, nominalDue);
		const faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		host = await DurableHost.open({
			layout: hostLayout(root),
			globalAgentDir: root,
			session: true,
			settings: { localPiTools: { enabled: true } },
			models,
		});
		const env = path.join(root, "run.env");
		fs.writeFileSync(
			env,
			`HERDR_DIGEST_PRODUCTION_SOURCES=${JSON.stringify([{ provider: "azure-monitor", environment: "production", environmentField: "environment", environmentValue: "production", services: ["synthetic-production"], provenance: "reviewed-config:synthetic" }])}\n`,
		);
		const run = {
			runId: "pi-durable-production-fixture",
			name: "pi-durable-production-fixture",
			cwd: root,
			runEnvPath: env,
			toolPolicy: "collection" as const,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		};
		const opened = await host.ensureRun(run);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("digest_collection_plan", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: 'let denied = 0; for (const name of ["mcp__tools_azure__azure_monitor_query", "mcp__tools_azure__read_azure_results", "bash", "write"]) { try { await tools[name]({ query: "AppTraces", filePath: "/etc/passwd", command: "false", path: "/tmp/no-write", content: "no-write" }); } catch { denied++; } } if (denied !== 4) throw new Error("unsafe production call reached"); return "generic production paths denied";',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("collect_digest_production_logs", {})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("collect_digest_production_logs", {})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("render_daily_digest", {
						occurrenceId: "foreign-occurrence",
						nominalDue,
						events: [],
						coverage: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("render_daily_digest", {
						occurrenceId: "production-fixture",
						nominalDue,
						events: [
							{
								source: "wiz",
								scope: "forged",
								id: "forged-event",
								eventId: "forged-event:created",
								title: "Unobserved model invention",
								url: "https://example.invalid/forged",
								at: nominalDue - 1,
								kind: "created",
								severity: "critical",
							},
						],
						coverage: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(
					context.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolName === "render_daily_digest" &&
							message.isError,
					),
				).toBe(true);
				const rendered = context.messages.findLast(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "render_daily_digest",
				);
				if (rendered?.role !== "toolResult" || rendered.isError)
					throw new Error("Synthetic report render failed");
				return fauxAssistantMessage([
					fauxText(
						rendered.content
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("\n"),
					),
				]);
			},
		]);
		const text =
				"Synthetic scheduled production fixture; no real source calls.",
			envelope = {
				occurrenceId: "production-fixture",
				nominalDue,
				text,
				digest: schedulingDigest(text),
				runId: run.runId,
				expectedHostId: await host.scheduledIdentity(),
				expectedConversationId: opened.conversationId,
			};
		await host.scheduledAdmission("reserve", envelope, 1);
		await host.scheduledAdmission("activate", envelope, 1);
		let receipt = await host.scheduledAdmission("query", envelope, 1);
		for (let index = 0; index < 600 && receipt.state !== "succeeded"; index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			receipt = await host.scheduledAdmission("query", envelope, 1);
		}
		expect(receipt.state).toBe("succeeded");
		expect(receipt.result).toContain("SyntheticFailure");
		expect(receipt.result).toContain("exact 9 error(s)");
		expect(receipt.result).toContain("reviewed-config:synthetic");
		expect(receipt.result).toContain("production-deep-link-unavailable");
		expect(receipt.result).not.toContain("forged-event");
		expect(receipt.result).not.toContain("mapi-azure-results");
		expect(mcp.calls.map((call) => call.name)).toEqual([
			"azure_monitor_query",
			"read_azure_results",
		]);
		expect(mcp.calls[0]?.args.query).toContain(
			new Date(nominalDue).toISOString(),
		);
		expect(mcp.calls[1]?.args.filePath).toBe(
			"/tmp/mapi-azure-results/query-123.ndjson",
		);
		expect(faux.getPendingResponseCount()).toBe(0);
		const secondRun = {
				...run,
				runId: "pi-durable-production-foreign-fixture",
				name: "pi-durable-production-foreign-fixture",
			},
			secondOpened = await host.ensureRun(secondRun);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("collect_digest_production_logs", {})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("render_daily_digest", {
						occurrenceId: "foreign-fixture",
						nominalDue,
						events: [],
						coverage: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const report = context.messages.findLast(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "render_daily_digest",
				);
				if (report?.role !== "toolResult" || report.isError)
					throw new Error("Foreign receipt report failed");
				return fauxAssistantMessage([
					fauxText(
						report.content
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("\n"),
					),
				]);
			},
		]);
		const secondText = "Synthetic cross-conversation receipt reuse fixture",
			secondEnvelope = {
				...envelope,
				runId: secondRun.runId,
				occurrenceId: "foreign-fixture",
				text: secondText,
				digest: schedulingDigest(secondText),
				expectedConversationId: secondOpened.conversationId,
			};
		await host.scheduledAdmission("reserve", secondEnvelope, 1);
		await host.scheduledAdmission("activate", secondEnvelope, 1);
		let secondReceipt = await host.scheduledAdmission(
			"query",
			secondEnvelope,
			1,
		);
		for (
			let index = 0;
			index < 600 && secondReceipt.state !== "succeeded";
			index++
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			secondReceipt = await host.scheduledAdmission("query", secondEnvelope, 1);
		}
		expect(secondReceipt.state).toBe("succeeded");
		expect(secondReceipt.result).toContain(
			"production-cross-occurrence-receipt-denied",
		);
		expect(secondReceipt.result).not.toContain("SyntheticFailure");
		expect(mcp.calls.map((call) => call.name)).toEqual([
			"azure_monitor_query",
			"read_azure_results",
			"azure_monitor_query",
		]);
		expect(faux.getPendingResponseCount()).toBe(0);
	} finally {
		try {
			await host?.shutdown();
		} finally {
			await mcp?.close();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}, 30000);
