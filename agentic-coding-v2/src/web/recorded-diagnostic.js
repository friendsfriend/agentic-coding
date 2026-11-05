import { button, element } from "/dom.js";

/** Historical native records only; never construct or retry a live operation. */
export function recordedDiagnostic(root, run, api, options) {
	const { kind } = options,
		details = element("details"),
		selector = element("select"),
		output = element("div"),
		status = element("p", `No ${kind} history loaded.`);
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
	const list = button(`List recorded ${kind} diagnostics`, async () => {
		list.disabled = true;
		try {
			const records = await api(`${options.route}?${route}`);
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
			status.textContent = `${records.length} bounded historical issuances listed. No request/query, connection or lease was readied. Issued may mean pending or uncertain; inspect recorded outcomes, not current live state.`;
		} finally {
			list.disabled = false;
		}
	});
	const load = button(`Load selected ${kind} diagnostic`, async () => {
		if (!selector.value)
			throw Error(`List and select a recorded ${kind} diagnostic first`);
		load.disabled = true;
		try {
			const query = new URLSearchParams(route);
			query.set("operation", selector.value);
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
		} finally {
			load.disabled = false;
		}
	});
	details.append(
		element("p", options.description),
		list,
		selector,
		load,
		status,
		output,
	);
	root.append(details);
}
