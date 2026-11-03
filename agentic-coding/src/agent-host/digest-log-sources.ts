import { createHash } from "node:crypto";
import {
	type DigestCoverage,
	type DigestEvidence,
	dailyDigestWindow,
} from "../scheduling/daily-digest.ts";
import {
	type DigestProductionSource,
	validateProductionSources,
} from "../scheduling/digest-settings.ts";
export type ProductionRead =
	| "azure-query"
	| "azure-results"
	| "new-relic-query"
	| "new-relic-results";
export type ProductionReader = (
	operation: ProductionRead,
	args: Record<string, unknown>,
) => Promise<unknown>;
export interface ProductionCollection {
	readonly events: readonly DigestEvidence[];
	readonly coverage: readonly DigestCoverage[];
}
const ROW_CAP = 1000,
	PAGE_SIZE = 200;
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
/** Only transport wrappers are unwrapped, never a provider row's message field. */
function transport(value: unknown): unknown {
	let current = value;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof current === "string") {
			if (Buffer.byteLength(current) > 256000)
				throw new Error("response-byte-cap");
			try {
				current = JSON.parse(current);
				continue;
			} catch {
				return current;
			}
		}
		const entry = record(current);
		if (entry?.structuredOutput !== undefined) {
			current = entry.structuredOutput;
			continue;
		}
		if (entry?.structuredContent !== undefined) {
			current = entry.structuredContent;
			continue;
		}
		const parts = entry?.output ?? entry?.content;
		if (
			Array.isArray(parts) &&
			parts.length === 1 &&
			record(parts[0])?.type === "text" &&
			typeof record(parts[0])?.text === "string"
		) {
			current = record(parts[0])?.text;
			continue;
		}
		return current;
	}
	throw new Error("response-envelope-cap");
}
export function compileProductionLogQuery(
	source: DigestProductionSource,
	nominalDue: number,
): Record<string, unknown> {
	const validated = validateProductionSources([source])[0];
	if (
		!validated ||
		!Number.isSafeInteger(nominalDue) ||
		nominalDue < 86400000 ||
		nominalDue > 8640000000000000
	)
		throw new Error("invalid-production-query-window");
	const window = dailyDigestWindow(nominalDue),
		start = new Date(window.start).toISOString(),
		end = new Date(window.end).toISOString();
	if (source.provider === "azure-monitor")
		return {
			duration: `P${Math.max(1, Math.ceil((Date.now() - window.start) / 86400000))}D`,
			query: `AppExceptions | where TimeGenerated >= datetime(${start}) and TimeGenerated < datetime(${end}) | where tostring(Properties[${JSON.stringify(validated.environmentField)}]) == ${JSON.stringify(validated.environmentValue)} | where AppRoleName in (${validated.services.map((value) => JSON.stringify(value)).join(", ")}) | summarize count=count(), first=min(TimeGenerated), last=max(TimeGenerated), severity=max(SeverityLevel) by service=AppRoleName, signature=ProblemId | top ${ROW_CAP + 1} by count desc`,
		};
	return {
		query: `SELECT count(*) AS 'count', earliest(timestamp) AS 'first', latest(timestamp) AS 'last' FROM TransactionError WHERE \`${validated.environmentField}\` = '${validated.environmentValue}' AND appName IN (${validated.services.map((value) => `'${value}'`).join(", ")}) FACET appName, if(\`error.class\` IS NOT NULL AND \`error.class\` != '', \`error.class\`, '__missing_signature__') SINCE '${start}' UNTIL '${end}' LIMIT MAX`,
	};
}
export function productionReceipt(
	value: unknown,
	provider: "azure-monitor" | "new-relic",
): Record<string, unknown> | undefined {
	const decoded = transport(value);
	if (typeof decoded !== "string") return record(decoded);
	const header =
		provider === "azure-monitor"
			? /^✅ Query complete — (\d+) rows written to file\./
			: /^✅ NRQL query complete — (\d+) rows written to file\./;
	const count = header.exec(decoded)?.[1],
		file = /^File:\s+(\/[^\r\n]+)$/m.exec(decoded)?.[1],
		rows = /^Rows:\s+(\d+)$/m.exec(decoded)?.[1];
	if (!count || count !== rows || !file) return undefined;
	return { filePath: file, rowCount: Number(count) };
}
function rows(
	value: unknown,
	offset: number,
	total: number,
): Record<string, unknown>[] {
	const decoded = transport(value);
	let items: unknown = Array.isArray(decoded) ? decoded : record(decoded)?.rows;
	if (typeof decoded === "string") {
		try {
			const header =
				/^\(rows (\d+)–(\d+) of (\d+) — (?:end of file|\d+ rows remaining)\)\r?\n\r?\n/.exec(
					decoded,
				);
			const body = header ? decoded.slice(header[0].length) : decoded;
			items = body
				.trim()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (
				header &&
				(Number(header[1]) !== offset ||
					Number(header[3]) !== total ||
					!Array.isArray(items) ||
					Number(header[2]) !== offset + items.length - 1)
			)
				throw new Error("result-page-custody-mismatch");
		} catch {
			throw new Error("result-page-schema-unrecognized");
		}
	}
	if (
		!Array.isArray(items) ||
		items.length > PAGE_SIZE ||
		items.some((item) => !record(item))
	)
		throw new Error("result-page-schema-unrecognized");
	return items as Record<string, unknown>[];
}
function time(value: unknown): number | undefined {
	const at =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Date.parse(value)
				: NaN;
	return Number.isSafeInteger(at) ? at : undefined;
}
function bounded(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 1000
		? value
		: undefined;
}
export async function collectProductionLogs(
	settings: unknown,
	nominalDue: number,
	invoke: ProductionReader,
): Promise<ProductionCollection> {
	const sources = validateProductionSources(settings),
		events: DigestEvidence[] = [],
		coverage: DigestCoverage[] = [],
		receipts = new Set<string>();
	for (const provider of ["azure-monitor", "new-relic"] as const) {
		const source = sources.find((item) => item.provider === provider),
			diagnostics: string[] = [];
		let attempts = 0,
			failures = 0;
		const read: ProductionReader = async (operation, args) => {
			attempts++;
			try {
				return await invoke(operation, args);
			} catch (error) {
				failures++;
				throw error;
			}
		};
		let pages = 0,
			inspected = 0,
			added = 0,
			truncated = false,
			succeeded = false;
		if (!source) {
			coverage.push({
				source: provider,
				scope: "production",
				status: "unavailable",
				pages,
				attempts,
				failures,
				items: 0,
				truncated: false,
				missingFields: [],
				diagnostics: ["verified-production-selector-unconfigured"],
			});
			continue;
		}
		try {
			const query = compileProductionLogQuery(source, nominalDue),
				operation =
					provider === "azure-monitor" ? "azure-query" : "new-relic-query",
				receipt = productionReceipt(await read(operation, query), provider);
			if (
				!receipt ||
				typeof receipt.filePath !== "string" ||
				!/^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\r\n\0]{1,4090}\.(?:ndjson|jsonl)$/.test(
					receipt.filePath,
				) ||
				!Number.isSafeInteger(receipt.rowCount) ||
				Number(receipt.rowCount) < 0 ||
				receipts.has(receipt.filePath) ||
				!(
					provider === "azure-monitor"
						? /\/mapi-azure-results\/query-\d+\.ndjson$/
						: /\/mapi-newrelic-results\/nrql-\d+\.ndjson$/
				).test(receipt.filePath)
			)
				throw new Error("query-receipt-schema-or-custody-invalid");
			receipts.add(receipt.filePath);
			const count = Number(receipt.rowCount),
				limit = Math.min(count, ROW_CAP);
			// Provider facet/default ceilings and our own ceiling are never exact counts.
			truncated = count >= ROW_CAP || receipt.truncated === true;
			if (truncated) diagnostics.push("production-aggregate-row-cap");
			const seen = new Set<string>(),
				window = dailyDigestWindow(nominalDue);
			for (let offset = 1; offset <= limit; offset += PAGE_SIZE) {
				const expected = Math.min(PAGE_SIZE, limit - offset + 1),
					page = rows(
						await read(
							provider === "azure-monitor"
								? "azure-results"
								: "new-relic-results",
							{ filePath: receipt.filePath, offset, limit: expected },
						),
						offset,
						count,
					);
				pages++;
				if (page.length !== expected)
					throw new Error("production-result-page-count-mismatch");
				inspected += page.length;
				for (const row of page) {
					const facet = Array.isArray(row.facet) ? row.facet : [],
						service = bounded(
							provider === "azure-monitor" ? row.service : facet[0],
						),
						signature = bounded(
							provider === "azure-monitor" ? row.signature : facet[1],
						),
						first = time(row.first),
						last = time(row.last),
						occurrences = row.count;
					if (
						!service ||
						!source.services.includes(service) ||
						!signature ||
						first === undefined ||
						last === undefined ||
						first < window.start ||
						last >= window.end ||
						last < first ||
						!Number.isSafeInteger(occurrences) ||
						Number(occurrences) < 1
					) {
						diagnostics.push("production-aggregate-row-invalid");
						continue;
					}
					if (
						provider === "azure-monitor" &&
						(typeof row.severity !== "number" ||
							!Number.isInteger(row.severity) ||
							row.severity < 0 ||
							row.severity > 4)
					)
						diagnostics.push("production-severity-unavailable");
					if (signature === "__missing_signature__")
						diagnostics.push("production-signature-unavailable");
					const id = createHash("sha256")
						.update(JSON.stringify([provider, service, signature]))
						.digest("hex");
					if (seen.has(id)) {
						diagnostics.push("production-aggregate-duplicate");
						continue;
					}
					seen.add(id);
					events.push({
						source: provider,
						scope: "production",
						id,
						eventId: `${id}:${nominalDue}`,
						title:
							signature === "__missing_signature__"
								? "Unclassified production error (source signature unavailable)"
								: signature,
						url:
							provider === "azure-monitor"
								? "https://portal.azure.com/"
								: "https://one.newrelic.com/",
						kind: "log-error",
						at: first,
						lastAt: last,
						service,
						signature,
						provenance: source.provenance,
						count: Number(occurrences),
						countExact: !truncated,
						...(provider === "azure-monitor" &&
						typeof row.severity === "number" &&
						Number.isInteger(row.severity) &&
						row.severity >= 0 &&
						row.severity <= 4
							? {
									severity:
										row.severity >= 4
											? ("critical" as const)
											: row.severity >= 3
												? ("high" as const)
												: row.severity >= 2
													? ("medium" as const)
													: ("informational" as const),
								}
							: {}),
					});
					added++;
				}
			}
			succeeded = true;
		} catch (error) {
			diagnostics.push(
				error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message)
					? error.message
					: "production-read-unavailable",
			);
		}
		if (added) diagnostics.push("production-deep-link-unavailable");
		coverage.push({
			source: provider,
			scope:
				provider === "azure-monitor"
					? "production:appexceptions"
					: "production:transactionerror",
			status:
				succeeded && !diagnostics.length
					? "success"
					: inspected || succeeded
						? "partial"
						: "unavailable",
			pages,
			attempts,
			failures,
			items: added,
			truncated,
			missingFields: added ? ["source-deep-link"] : [],
			diagnostics: [...new Set(diagnostics)],
		});
	}
	return { events, coverage };
}
