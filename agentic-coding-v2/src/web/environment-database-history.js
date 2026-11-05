import { element } from "/dom.js";
import { recordedDiagnostic } from "/recorded-diagnostic.js";

function resultTable(result) {
	const container = element("div"),
		rows = result?.rows;
	if (!Array.isArray(rows) || !rows.length) return container;
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))],
		shown = columns.slice(0, 24),
		table = element("table"),
		header = element("tr");
	container.append(
		element(
			"p",
			"Historical returned rows only; numeric values remain strings. Up to 24 columns are shown here; the raw record retains all returned fields and omission metadata.",
		),
	);
	for (const column of shown) header.append(element("th", column));
	const head = element("thead"),
		body = element("tbody");
	head.append(header);
	table.append(head, body);
	for (const row of rows) {
		const tr = element("tr");
		for (const column of shown) {
			const value = row[column];
			tr.append(
				element(
					"td",
					!Object.hasOwn(row, column)
						? "[not present]"
						: typeof value === "string"
							? value
							: JSON.stringify(value),
				),
			);
		}
		body.append(tr);
	}
	container.append(table);
	return container;
}
/** Explicit historical reads survive cleanup; they can never issue SQL. */
export function addDatabaseHistory(root, run, api) {
	recordedDiagnostic(root, run, api, {
		kind: "SQL",
		title: "Recorded SQL diagnostics (no query)",
		route: "/api/environments/database-history",
		renderResult: resultTable,
		description:
			"Read-only historical viewer. Live SQL still requires the owning native task’s exact human approval and held dependencies. SQL text, connection settings and credential references are not exposed here.",
		uncertain:
			"Issued without a completed result: execution and rollback are unconfirmed. No retry or connection was attempted.",
	});
}
