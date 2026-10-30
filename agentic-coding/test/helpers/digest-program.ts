import {
	fauxAssistantMessage,
	type fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonValue,
} from "@earendil-works/pi-ai";
import { CODEMODE_TOOL_NAME } from "../../src/agent-host/codemode.ts";

/** A fake model program whose report data actually flows from loopback MCP
 * through the production normalizer and renderer, not injected report text. */
export function configureDigestProgram(
	faux: ReturnType<typeof fauxProvider>,
	nominalDue: number,
): void {
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: `
 function unwrap(value, key, depth = 0) {
 if (depth > 8) throw new Error("Synthetic tool envelope too deep");
 if (typeof value === "string") return unwrap(JSON.parse(value), key, depth + 1);
 if (value && typeof value === "object" && Array.isArray(value[key])) return value;
 const candidates = Array.isArray(value) ? value : value && typeof value === "object" ? [value.structuredOutput, value.output, value.content, value.result, value.text] : [];
 for (const candidate of candidates) { if (candidate == null) continue; try { return unwrap(candidate, key, depth + 1); } catch {} }
 throw new Error("Synthetic tool result missing " + key);
 }
 await tools.mcp__wiz__discover({});
 const events = [];
 for (const after of [undefined, "page-2"]) {
 const response = await tools.mcp__wiz__execute({ tool_name: "list_issues", parameters: { first: 1, ...(after ? { after } : {}) } });
 const page = unwrap(response, "findings");
 const normalized = await tools.normalize_digest_source_page({ source: "wiz", scope: "synthetic", nominalDue: ${nominalDue}, rawJson: JSON.stringify(page) });
 events.push(...unwrap(normalized, "items").items);
 }
 text(JSON.stringify(events));`,
				}),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const result = context.messages.findLast(
				(message) =>
					message.role === "toolResult" &&
					message.toolName === CODEMODE_TOOL_NAME,
			);
			if (result?.role !== "toolResult" || result.isError)
				throw new Error(
					`Synthetic MCP/normalization failed: ${JSON.stringify(result)}`,
				);
			const block = result.content.find(
				(block) => block.type === "text" && block.text.startsWith("["),
			);
			const events = JSON.parse(
				block?.type === "text" ? block.text : "null",
			) as JsonValue[];
			if (!Array.isArray(events) || events.length !== 2)
				throw new Error("Synthetic paginated events missing");
			const occurrenceId = JSON.stringify(context.messages).match(
				/Occurrence: ([\w:-]+)/,
			)?.[1];
			if (!occurrenceId)
				throw new Error("Scheduler nominal occurrence missing");
			return fauxAssistantMessage(
				[
					fauxToolCall("render_daily_digest", {
						occurrenceId,
						nominalDue,
						events,
						coverage: [
							{
								source: "wiz",
								scope: "synthetic",
								status: "success",
								pages: 2,
								items: events.length,
								truncated: false,
								missingFields: [],
								diagnostics: [],
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const result = context.messages.findLast(
				(message) =>
					message.role === "toolResult" &&
					message.toolName === "render_daily_digest",
			);
			if (result?.role !== "toolResult" || result.isError)
				throw new Error("Synthetic render failed");
			return fauxAssistantMessage([
				fauxText(
					result.content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n"),
				),
			]);
		},
	]);
}
