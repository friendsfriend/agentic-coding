import { button, element } from "/dom.js";

/** Historical native records only; never construct or retry a live operation. */
export function recordedDiagnostic(root, run, api, options) {
	const { kind } = options,
		details = element("details"),
		selector = element("select"),
		output = element("div"),
		status = element("p", `No ${kind} history loaded.`),
		window = element("p", "History window not loaded."),
		exactId = element("input");
	exactId.type = "text";
	exactId.maxLength = 128;
	exactId.setAttribute(
		"aria-label",
		`Exact recorded ${kind} diagnostic ID (${run.id})`,
	);
	details.append(element("summary", options.title));
	selector.setAttribute(
		"aria-label",
		`Recorded ${kind} diagnostics (${run.id})`,
	);
	output.setAttribute(
		"aria-label",
		`Historical ${kind} diagnostic (${run.id})`,
	);
	const route = new URLSearchParams({ run: run.id });
	let nextCursor = null;
	const loadPage = async (cursor) => {
		list.disabled = true;
		older.disabled = true;
		try {
			const query = new URLSearchParams(route);
			if (cursor) query.set("cursor", cursor);
			const history = await api(`${options.route}?${query}`);
			selector.replaceChildren(
				...history.records.map((record) => {
					const option = element(
						"option",
						`${record.id} · ${record.state} · ${new Date(record.issuedAt).toISOString()}`,
					);
					option.value = record.id;
					return option;
				}),
			);
			nextCursor = history.nextCursor;
			window.textContent = `Showing ${history.returned} of ${history.total} retained native issuances for this exact run; limit ${history.limit}, omitted from list ${history.omitted}; skipped newer ${history.newer}, older remaining ${history.remainingOlder}; ${history.order}. ${history.authority}`;
			status.textContent =
				"Historical page loaded. Issued may mean pending or uncertain, never a current live outcome.";
		} finally {
			list.disabled = false;
			older.disabled = !nextCursor;
		}
	};
	const list = button(`List recorded ${kind} diagnostics`, () => loadPage()),
		older = button(`Load older recorded ${kind} diagnostics`, () => {
			if (!nextCursor)
				throw Error(
					"No older retained page is available; reload newest history",
				);
			return loadPage(nextCursor);
		});
	older.disabled = true;
	const loadRecord = async (id) => {
		if (!id)
			throw Error(
				`Choose or enter an exact recorded ${kind} diagnostic ID first`,
			);
		const query = new URLSearchParams(route);
		query.set("operation", id);
		const record = await api(`${options.route}?${query}`),
			raw = element("pre", JSON.stringify(record, null, 2));
		output.replaceChildren(element("p", record.authority));
		if (options.renderResult)
			output.append(options.renderResult(record.result));
		output.append(raw);
		status.textContent =
			record.state === "completed"
				? "Historical completed result loaded; not a current observation or new approval."
				: options.uncertain;
	};
	const load = button(`Load selected ${kind} diagnostic`, async () => {
		load.disabled = true;
		try {
			await loadRecord(selector.value);
		} finally {
			load.disabled = false;
		}
	});
	const exact = button(
		`Load exact recorded ${kind} diagnostic ID`,
		async () => {
			exact.disabled = true;
			try {
				await loadRecord(exactId.value);
			} finally {
				exact.disabled = false;
			}
		},
	);
	details.append(
		element("p", options.description),
		list,
		older,
		window,
		selector,
		load,
		element(
			"p",
			"Page older records above, reload the newest page with List, or enter an existing native diagnostic ID for this exact run. Unknown, foreign-run and foreign-owner IDs are refused; this never issues or retries an operation.",
		),
		exactId,
		exact,
		status,
		output,
	);
	root.append(details);
}
