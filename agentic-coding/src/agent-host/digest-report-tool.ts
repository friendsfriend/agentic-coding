import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	dailyDigestWindow,
	renderDailyDigest,
} from "../scheduling/daily-digest.ts";
import { normalizeDigestSourcePage } from "../scheduling/digest-sources.ts";
import type { RunContextLookup } from "./tools.ts";

const text = Type.String({ minLength: 1, maxLength: 4096 });
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const evidence = Type.Object(
	{
		source: Type.Union([
			Type.Literal("jira"),
			Type.Literal("wiz"),
			Type.Literal("gitlab"),
		]),
		scope: text,
		id: text,
		eventId: text,
		title: text,
		url: text,
		at: timestamp,
		kind: Type.Union([
			Type.Literal("created"),
			Type.Literal("updated-unverified"),
			Type.Literal("status"),
			Type.Literal("assignee"),
			Type.Literal("priority"),
			Type.Literal("resolution"),
			Type.Literal("sprint"),
			Type.Literal("due-date"),
			Type.Literal("comment"),
		]),
		status: Type.Optional(Type.String({ maxLength: 100 })),
		exposure: Type.Optional(Type.String({ maxLength: 100 })),
		severity: Type.Optional(
			Type.Union([
				Type.Literal("critical"),
				Type.Literal("high"),
				Type.Literal("medium"),
				Type.Literal("low"),
				Type.Literal("informational"),
			]),
		),
		urgency: Type.Optional(
			Type.Union([Type.Literal("highest"), Type.Literal("critical")]),
		),
		blockingMovement: Type.Optional(Type.Boolean()),
		securityEvidence: Type.Optional(Type.Boolean()),
		verifiedRenovate: Type.Optional(Type.Boolean()),
		updateType: Type.Optional(
			Type.Union([
				Type.Literal("major"),
				Type.Literal("minor"),
				Type.Literal("patch"),
			]),
		),
	},
	{ additionalProperties: false },
);
const coverage = Type.Object(
	{
		source: text,
		scope: text,
		status: Type.Union([
			Type.Literal("success"),
			Type.Literal("partial"),
			Type.Literal("unavailable"),
		]),
		pages: Type.Integer({ minimum: 0, maximum: 10000 }),
		items: Type.Integer({ minimum: 0 }),
		truncated: Type.Boolean(),
		missingFields: Type.Array(text, { maxItems: 100 }),
		diagnostics: Type.Array(
			Type.String({ pattern: "^[a-z0-9][a-z0-9:-]{0,80}$" }),
			{ maxItems: 100 },
		),
	},
	{ additionalProperties: false },
);
export function digestReportExtension(lookup: RunContextLookup) {
	return defineExtension({
		name: "agentic.digest-report",
		tools: [
			defineTool({
				name: "render_daily_digest",
				description:
					"Render normalized timestamp-evidenced source events and explicit coverage into a sanitized, deterministic daily digest. Does not collect sources or infer absent evidence. Use the scheduler envelope's exact occurrence ID/nominal due. Copies no transcript and performs no filesystem/network writes. Include the returned report as the final native assistant response.",
				replay: "safe",
				parameters: Type.Object(
					{
						occurrenceId: text,
						nominalDue: timestamp,
						events: Type.Array(evidence, { maxItems: 2000 }),
						coverage: Type.Array(coverage, { maxItems: 1000 }),
					},
					{ additionalProperties: false },
				),
				async execute(args, api) {
					if (lookup(api.conversationId)?.toolPolicy !== "collection")
						throw new Error("Collection session required.");
					return {
						output: [
							{
								type: "text" as const,
								text: renderDailyDigest({ ...args, executedAt: Date.now() }),
							},
						],
					};
				},
			}),
			defineTool({
				name: "normalize_digest_source_page",
				description:
					"Adapt one actual Jira/Wiz/GitLab JSON source page into timestamp-evidenced digest events. Pass actual provider JSON, not a reconstruction; comment bodies/descriptions are not copied. Unsupported schemas, hidden fields and pagination gaps are explicit. Continue every returned next cursor through the source's advertised API. Jira history/comment pages need issue context. Wiz NEW means first-seen/created only; GitLab requires authenticated Renovate bot metadata, never title/branch. Aggregate events/coverage across pages before rendering.",
				replay: "safe",
				parameters: Type.Object(
					{
						source: Type.Union([
							Type.Literal("jira"),
							Type.Literal("wiz"),
							Type.Literal("gitlab"),
						]),
						scope: text,
						nominalDue: timestamp,
						rawJson: Type.String({ minLength: 1, maxLength: 256000 }),
						context: Type.Optional(
							Type.Object(
								{ id: text, title: text, url: text },
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
				async execute(args, api) {
					if (lookup(api.conversationId)?.toolPolicy !== "collection")
						throw new Error("Collection session required.");
					let value: unknown;
					try {
						value = JSON.parse(args.rawJson);
					} catch {
						throw new Error(
							"Source response is not a JSON page; record an unavailable/partial schema diagnostic, not an empty result.",
						);
					}
					const page = normalizeDigestSourcePage({
						...args,
						value,
						window: dailyDigestWindow(args.nominalDue),
					});
					return {
						output: [{ type: "text" as const, text: JSON.stringify(page) }],
					};
				},
			}),
		],
	});
}
