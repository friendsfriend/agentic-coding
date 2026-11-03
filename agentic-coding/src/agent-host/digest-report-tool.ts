import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
	type ConversationId,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import {
	dailyDigestWindow,
	renderDailyDigestReport,
} from "../scheduling/daily-digest.ts";
import { DigestCollection } from "../scheduling/digest-collection.ts";
import { digestSourceQueryPlan } from "../scheduling/digest-source-queries.ts";
import { normalizeDigestSourcePage } from "../scheduling/digest-sources.ts";
import type { ProductionCollection } from "./digest-log-sources.ts";
import type { RunContextLookup } from "./tools.ts";

const text = Type.String({ minLength: 1, maxLength: 4096 });
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const evidence = Type.Object(
	{
		source: Type.Union([
			Type.Literal("jira"),
			Type.Literal("wiz"),
			Type.Literal("gitlab"),
			Type.Literal("azure-monitor"),
			Type.Literal("new-relic"),
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
			Type.Literal("merged"),
			Type.Literal("log-error"),
			Type.Literal("review-comment"),
			Type.Literal("pipeline-failed"),
		]),
		service: Type.Optional(text),
		signature: Type.Optional(text),
		provenance: Type.Optional(text),
		count: Type.Optional(Type.Integer({ minimum: 1 })),
		countExact: Type.Optional(Type.Boolean()),
		lastAt: Type.Optional(timestamp),
		status: Type.Optional(Type.String({ maxLength: 100 })),
		exposure: Type.Optional(Type.String({ maxLength: 100 })),
		resourceScope: Type.Optional(Type.String({ maxLength: 100 })),
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
export function digestReportExtension(
	lookup: RunContextLookup,
	production?: {
		active(
			conversationId: ConversationId,
		): Promise<
			| { occurrenceId: string; nominalDue: number; settingsRevision?: string }
			| undefined
		>;
		sources?(
			conversationId: ConversationId,
			occurrence: {
				occurrenceId: string;
				nominalDue: number;
				settingsRevision?: string;
			},
		):
			| {
					events: readonly import("../scheduling/daily-digest.ts").DigestEvidence[];
					coverage: readonly import("../scheduling/daily-digest.ts").DigestCoverage[];
			  }
			| undefined;
		collect(
			api: ToolExecutionApi,
			context: Context,
			nominalDue: number,
		): Promise<ProductionCollection>;
	},
) {
	const productionCollections = new Map<
		ConversationId,
		{
			occurrenceId: string;
			nominalDue: number;
			settingsRevision?: string;
			result: Promise<ProductionCollection>;
		}
	>();
	const collections = new Map<
		ConversationId,
		{ nominalDue: number; ledger: DigestCollection }
	>();
	function collection(conversationId: ConversationId, nominalDue: number) {
		let state = collections.get(conversationId);
		if (!state || state.nominalDue !== nominalDue) {
			state = { nominalDue, ledger: new DigestCollection() };
			if (!collections.has(conversationId) && collections.size >= 32)
				throw new Error(
					"Digest collection context cap; start no additional collections on this host.",
				);
			collections.set(conversationId, state);
		}
		return state.ledger;
	}
	return defineExtension({
		name: "agentic.digest-report",
		tools: [
			defineTool({
				name: "digest_collection_plan",
				description:
					"Return compiled Jira/Wiz/GitLab read parameters for this native scheduled occurrence, exact nominal window and bounded budgets. Discovery widening is not an evidence window. Use all accessible Jira candidates and all authorized GitLab projects; actual read receipts, not model coverage claims, certify source progress.",
				replay: "safe",
				parameters: Type.Object({}),
				async execute(_args, api) {
					const occurrence = await production?.active(api.conversationId);
					if (!occurrence)
						throw new Error(
							"Compiled collection plan requires an active native scheduled occurrence.",
						);
					const plan = digestSourceQueryPlan(occurrence.nominalDue);
					return {
						output: [{ type: "text" as const, text: JSON.stringify(plan) }],
						structuredOutput: { ...plan, window: { ...plan.window } },
					};
				},
			}),
			defineTool({
				name: "collect_digest_production_logs",
				description:
					"Collect configured, operator-verified production exception/error aggregates through fixed read-only templates and private provider receipts. Uses only this native scheduled turn's trusted occurrence/window; accepts no queries, selectors, paths or model window. Cached once per occurrence. Report rendering automatically incorporates its evidence and coverage; do not copy production events into render arguments.",
				replay: "unsafe",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute(_args, api, context) {
					if (
						lookup(api.conversationId)?.toolPolicy !== "collection" ||
						!production
					)
						throw new Error(
							"Native production collection adapter unavailable.",
						);
					const active = await production.active(api.conversationId);
					if (!active)
						throw new Error(
							"Production reads require an active native scheduled occurrence with a trusted nominal window.",
						);
					let state = productionCollections.get(api.conversationId);
					if (
						!state ||
						state.occurrenceId !== active.occurrenceId ||
						state.nominalDue !== active.nominalDue ||
						state.settingsRevision !== active.settingsRevision
					) {
						if (!state && productionCollections.size >= 32)
							throw new Error("Production collection context cap.");
						state = {
							...active,
							result: production.collect(api, context, active.nominalDue),
						};
						productionCollections.set(api.conversationId, state);
					}
					const result = await state.result;
					return {
						output: [
							{
								type: "text" as const,
								text: JSON.stringify({
									...active,
									groups: result.events.length,
									coverage: result.coverage,
								}),
							},
						],
					};
				},
			}),
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
					// Model/source-provided provenance never authorizes production evidence.
					if (
						args.events.some(
							(event) =>
								event.source === "azure-monitor" ||
								event.source === "new-relic",
						)
					)
						throw new Error(
							"Production evidence is owned by collect_digest_production_logs; omit production events from render arguments.",
						);
					const active = await production?.active(api.conversationId);
					if (
						production &&
						(!active ||
							active.occurrenceId !== args.occurrenceId ||
							active.nominalDue !== args.nominalDue)
					)
						throw new Error(
							"Digest report requires this active native occurrence and trusted nominal window.",
						);
					const productionState = productionCollections.get(api.conversationId);
					const verifiedProduction =
						productionState?.occurrenceId === args.occurrenceId &&
						productionState.nominalDue === args.nominalDue &&
						productionState.settingsRevision === active?.settingsRevision
							? await productionState.result
							: undefined;
					const sourceSnapshot = production?.sources?.(
						api.conversationId,
						active ?? args,
					);
					const observed = production?.sources
						? (sourceSnapshot?.coverage ?? [])
						: collection(api.conversationId, args.nominalDue).coverage();
					const checkedCoverage = args.coverage
						.filter(
							(entry) =>
								!verifiedProduction ||
								(entry.source !== "azure-monitor" &&
									entry.source !== "new-relic"),
						)
						.map((entry) => {
							const recorded = observed.find(
								(item) =>
									item.source === entry.source && item.scope === entry.scope,
							);
							return recorded
								? {
										...entry,
										pages: recorded.pages,
										items: recorded.items,
										attempts: recorded.attempts,
										failures: recorded.failures,
										status:
											recorded.status === "unavailable" ||
											entry.status === "unavailable"
												? ("unavailable" as const)
												: entry.status === "partial" ||
														recorded.status === "partial"
													? ("partial" as const)
													: recorded.status,
										truncated: entry.truncated || recorded.truncated,
										missingFields: [
											...new Set([
												...entry.missingFields,
												...recorded.missingFields,
											]),
										],
										diagnostics: [
											...new Set([
												...entry.diagnostics,
												...recorded.diagnostics,
											]),
										],
									}
								: {
										...entry,
										pages: 0,
										items: 0,
										attempts: 0,
										failures: 0,
										truncated: false,
										status: "unavailable" as const,
										diagnostics: [
											...entry.diagnostics,
											production?.sources
												? "actual-source-read-not-observed"
												: "source-normalization-not-observed",
										],
									};
						});
					const report = renderDailyDigestReport({
						...args,
						events: [
							...(production?.sources
								? (sourceSnapshot?.events ?? [])
								: args.events),
							...(verifiedProduction?.events ?? []),
						],
						coverage: [
							...(verifiedProduction?.coverage ?? []),
							...checkedCoverage,
							...observed.filter(
								(item) =>
									!checkedCoverage.some(
										(entry) =>
											entry.source === item.source &&
											entry.scope === item.scope,
									),
							),
						],
						executedAt: Date.now(),
					});
					return {
						output: [{ type: "text" as const, text: report.text }],
						structuredOutput: {
							reportCoverage: report.coverage,
							deliveryStatus: "native-delivery-is-separate",
						},
					};
				},
			}),
			defineTool({
				name: "normalize_digest_source_page",
				description:
					"Adapt one actual Jira/Wiz/GitLab JSON, MCP envelope or recognized Jira Markdown source page into timestamp-evidenced digest events. Pass actual provider JSON, not a reconstruction; comment bodies/descriptions are not copied. Unsupported schemas, hidden fields and pagination gaps are explicit. Continue every returned next cursor through the source's advertised API. Jira history/comment pages need issue context. Wiz NEW means first-seen/created only; GitLab retains ordinary timestamped activity; Renovate highlighting requires authenticated bot metadata, never title/branch. Aggregate events/coverage across pages before rendering.",
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
						requestedCursor: Type.Optional(text),
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
					const ledger = collection(api.conversationId, args.nominalDue);
					if (!ledger.canNormalize(args.source, args.scope))
						throw new Error(
							"Cumulative digest normalization cap; report incomplete coverage.",
						);
					const value: unknown = args.rawJson;
					const page = normalizeDigestSourcePage({
						...args,
						value,
						window: dailyDigestWindow(args.nominalDue),
					});
					ledger.record(args.source, args.scope, page, args.requestedCursor);
					return {
						output: [
							{
								type: "text" as const,
								text: JSON.stringify({
									...page,
									cumulativeCoverage: ledger.coverage(),
								}),
							},
						],
					};
				},
			}),
		],
	});
}
