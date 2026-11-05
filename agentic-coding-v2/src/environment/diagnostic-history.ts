import { digest } from "../config.ts";
import { decode } from "../state.ts";

type DiagnosticReceipt = {
	owner: number;
	inputDigest: string;
	approved: { run: string };
	issuedAt: number;
	state: "issued" | "completed";
	result?: { observedAt: number };
};
export type DiagnosticSelection = { operation?: string; cursor?: string };
/** Retained native observations only. Projection never returns approval payloads.
 * Exact-ID reads deliberately precede windowing, but never bypass run/owner scope. */
export function diagnosticHistory<Receipt extends DiagnosticReceipt>(
	records: Record<string, string> | undefined,
	run: { id: string; owner: number },
	{ operation, cursor }: DiagnosticSelection,
	kind: "HTTP" | "SQL",
	matches: (receipt: Receipt) => boolean,
	describe: (receipt: Receipt) => Record<string, string>,
) {
	if (
		cursor !== undefined &&
		(operation !== undefined || !/^[a-f0-9]{64}$/.test(cursor))
	)
		throw new Error(
			"Choose list cursor or exact diagnostic ID, with a valid cursor",
		);
	const authority =
			kind === "HTTP"
				? "Historical HTTP diagnostic only: no new request, connection or lease. Issued is pending or uncertain, not proof of dispatch, server-side effects or response. Never automatically resend."
				: "Historical SQL diagnostic only: no new query, connection or lease. Issued is pending or uncertain, not proof of execution, rollback or success.",
		inScope = (receipt: Receipt) =>
			receipt.owner === run.owner &&
			receipt.approved.run === run.id &&
			matches(receipt),
		summary = (id: string, receipt: Receipt) => ({
			...describe(receipt),
			id,
			owner: receipt.owner,
			run: run.id,
			state: receipt.state,
			inputDigest: receipt.inputDigest,
			issuedAt: receipt.issuedAt,
			observedAt: receipt.result?.observedAt ?? null,
			authority,
		});
	if (operation !== undefined) {
		const raw =
				records && Object.hasOwn(records, operation)
					? records[operation]
					: undefined,
			receipt = raw ? decode<Receipt>(raw) : undefined;
		if (!receipt || !inScope(receipt))
			throw new Error(`Unknown ${kind} diagnostic for this exact run`);
		return {
			...summary(operation, receipt),
			result: receipt.state === "completed" ? (receipt.result ?? null) : null,
		};
	}
	const entries = Object.entries(records ?? {})
			.map(([id, raw]) => ({ id, receipt: decode<Receipt>(raw) }))
			.filter(({ receipt }) => inScope(receipt)),
		limit = 200,
		// An opaque boundary selector, not a permission or a frozen snapshot.
		cursorFor = (id: string) =>
			digest(
				JSON.stringify(["diagnostic-history-v1", kind, run.owner, run.id, id]),
			),
		end =
			cursor === undefined
				? entries.length
				: entries.findIndex(({ id }) => cursorFor(id) === cursor);
	if (end < 0)
		throw new Error(
			"Unknown diagnostic cursor for this exact run and kind; reload newest history",
		);
	const start = Math.max(0, end - limit),
		boundary = entries[start],
		listed = entries
			.slice(start, end)
			.toReversed()
			.map(({ id, receipt }) => summary(id, receipt));
	return {
		records: listed,
		total: entries.length,
		returned: listed.length,
		limit,
		omitted: entries.length - listed.length,
		newer: entries.length - end,
		remainingOlder: start,
		nextCursor: start > 0 && boundary ? cursorFor(boundary.id) : null,
		order: "newest-issuance-first",
		scope: "exact-run",
		authority:
			"Counts cover retained native issuances for this exact run, not all service requests/queries or complete external history. Pages are boundary-based observations, not frozen snapshots: newly appended issuances are skipped by older-page cursors. Reload newest to see them. Older retained records also remain readable by exact ID. No execution authority is restored.",
	};
}
