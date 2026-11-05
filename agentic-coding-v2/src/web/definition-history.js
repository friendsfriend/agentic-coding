import { button, element } from "./dom.js";

/** Read-only historical browser, independent of editor and live-file state. */
export function definitionHistory(request, busy, status, options) {
	const selector = element("select"),
		report = element("pre", "No historical record loaded.");
	selector.setAttribute("aria-label", options.selectionLabel);
	report.setAttribute("aria-label", options.reportLabel);
	const list = button(options.listLabel, () =>
		busy(async () => {
			const records = await request(options.indexRoute);
			selector.replaceChildren(
				...records.map((record) => {
					const option = element(
						"option",
						`${record.ordinal} · ${record.observedAt} · ${record.id}`,
					);
					option.value = record.id;
					return option;
				}),
			);
			status.textContent = `${records.length} historical records listed. No live-file observation, write, approval or reload; editor text unchanged.`;
		}),
	);
	const load = button(options.loadLabel, () =>
		busy(async () => {
			if (!selector.value)
				throw Error("List and select a historical record first");
			const record = await request(
				`${options.recordRoute}?id=${encodeURIComponent(selector.value)}`,
			);
			report.textContent = JSON.stringify(record, null, 2);
			status.textContent =
				"Historical record loaded, even if its draft was deleted. No live-file observation, write, approval or reload; unsaved editor text was NOT checked or changed.";
		}),
	);
	return [list, selector, load, report];
}
