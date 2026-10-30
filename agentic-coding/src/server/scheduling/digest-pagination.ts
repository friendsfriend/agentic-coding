import type {
	DigestCoverage,
	DigestPage,
} from "../../scheduling/daily-digest.ts";

export async function collectDigestPages<T>(
	fetch: (cursor: string | undefined) => Promise<DigestPage<T>>,
	options: {
		source: string;
		scope: string;
		maxPages: number;
		maxItems: number;
	},
): Promise<{ items: T[]; coverage: DigestCoverage }> {
	if (
		!Number.isSafeInteger(options.maxPages) ||
		options.maxPages < 1 ||
		!Number.isSafeInteger(options.maxItems) ||
		options.maxItems < 1
	)
		throw new Error("Invalid digest pagination budget.");
	const items: T[] = [],
		cursors = new Set<string>(),
		missingFields = new Set<string>(),
		diagnostics: string[] = [];
	let cursor: string | undefined,
		pages = 0,
		truncated = false,
		failed = false;
	try {
		for (;;) {
			const page = await fetch(cursor);
			pages++;
			const remaining = options.maxItems - items.length;
			items.push(...page.items.slice(0, remaining));
			for (const field of page.missingFields ?? []) missingFields.add(field);
			for (const diagnostic of page.diagnostics ?? []) {
				if (/^[a-z0-9][a-z0-9:-]{0,80}$/.test(diagnostic))
					diagnostics.push(diagnostic);
			}
			if (diagnostics.length > 100) {
				diagnostics.splice(99);
				diagnostics.push("source-diagnostic-cap");
				truncated = true;
			}
			truncated ||= page.truncated === true || page.items.length > remaining;
			if (!page.next) break;
			if (cursors.has(page.next)) {
				truncated = true;
				diagnostics.push("pagination-cursor-repeated");
				break;
			}
			cursors.add(page.next);
			if (pages >= options.maxPages || items.length >= options.maxItems) {
				truncated = true;
				diagnostics.push("pagination-budget-exhausted");
				break;
			}
			cursor = page.next;
		}
	} catch {
		failed = true;
		diagnostics.push("source-query-failed-check-integration-access");
	}
	return {
		items,
		coverage: {
			source: options.source,
			scope: options.scope,
			status: failed
				? pages
					? "partial"
					: "unavailable"
				: truncated || missingFields.size
					? "partial"
					: "success",
			pages,
			items: items.length,
			truncated,
			missingFields: [...missingFields],
			diagnostics: [...new Set(diagnostics)],
		},
	};
}
