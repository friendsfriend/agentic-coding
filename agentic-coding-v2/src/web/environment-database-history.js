import { button, element } from "/dom.js";

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
	const details = element("details"),
		selector = element("select"),
		output = element("div"),
		status = element("p", "No SQL history loaded.");
	details.append(element("summary", "Recorded SQL diagnostics (no query)"));
	selector.setAttribute("aria-label", `Recorded SQL diagnostics (${run.id})`);
	output.setAttribute("aria-label", `Historical SQL diagnostic (${run.id})`);
	const route = new URLSearchParams({ run: run.id });
	const list = button("List recorded SQL diagnostics", async () => {
		list.disabled = true;
		try {
			const records = await api(`/api/environments/database-history?${route}`);
			selector.replaceChildren(
				...records.map((record) => {
					const option = element(
						"option",
						`${record.id} · ${record.state} · ${new Date(record.issuedAt).toISOString()}`,
					);
					option.value = record.id;
					return option;
				}),
			);
			status.textContent = `${records.length} bounded historical issuances listed. No SQL, credentials, connection or lease was readied. Issued may mean pending or uncertain, never confirmed execution/rollback.`;
		} finally {
			list.disabled = false;
		}
	});
	const load = button("Load selected SQL diagnostic", async () => {
		if (!selector.value)
			throw Error("List and select a recorded SQL diagnostic first");
		load.disabled = true;
		try {
			const query = new URLSearchParams(route);
			query.set("operation", selector.value);
			const record = await api(`/api/environments/database-history?${query}`);
			output.replaceChildren(
				element("p", record.authority),
				resultTable(record.result),
				element("pre", JSON.stringify(record, null, 2)),
			);
			status.textContent =
				record.state === "completed"
					? "Historical completed result loaded; not a current database observation or new approval."
					: "Issued without a completed result: execution and rollback are unconfirmed. No retry or connection was attempted.";
		} finally {
			load.disabled = false;
		}
	});
	details.append(
		element(
			"p",
			"Read-only historical viewer. Live SQL still requires the owning native task’s exact human approval and held dependencies. SQL text, connection settings and credential references are not exposed here.",
		),
		list,
		selector,
		load,
		status,
		output,
	);
	root.append(details);
}
