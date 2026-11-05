import { button, element } from "/dom.js";

function observedSpans(root, records) {
	const spans = new Map(records.map((row) => [row.spanId, row])),
		children = new Map(),
		visited = new Set(),
		forest = element("ol");
	for (const row of records) {
		const siblings = children.get(row.parentSpanId) ?? [];
		siblings.push(row);
		children.set(row.parentSpanId, siblings);
	}
	const append = (row, parent, depth) => {
		if (visited.has(row.spanId)) {
			parent.append(
				element(
					"li",
					`Repeated/cyclic parent link to ${row.spanId}; not expanded.`,
				),
			);
			return;
		}
		visited.add(row.spanId);
		const item = element("li"),
			details = element("details");
		details.append(
			element(
				"summary",
				`${row.name} · ${row.kind} · ${row.durationMs} ms · ${row.status} · ${row.spanId}`,
			),
		);
		if (row.parentSpanId && !spans.has(row.parentSpanId))
			details.append(
				element(
					"p",
					`Parent ${row.parentSpanId} is absent from this response; not proof of a root span.`,
				),
			);
		details.append(element("pre", JSON.stringify(row, null, 2)));
		item.append(details);
		parent.append(item);
		const descendants = children.get(row.spanId) ?? [];
		if (!descendants.length) return;
		if (depth >= 12) {
			item.append(
				element(
					"p",
					"Display depth limit reached; remaining spans are shown separately below.",
				),
			);
			return;
		}
		const nested = element("ol");
		item.append(nested);
		for (const child of descendants) append(child, nested, depth + 1);
	};
	for (const row of records)
		if (!row.parentSpanId || !spans.has(row.parentSpanId))
			append(row, forest, 0);
	for (const row of records) {
		if (visited.has(row.spanId)) continue;
		forest.append(
			element(
				"li",
				"Unattached/cyclic component or display-depth remainder; no root inferred.",
			),
		);
		append(row, forest, 0);
	}
	root.append(forest);
}
/** Present only returned observations. Never infer missing spans or ownership. */
export function renderNativeTelemetry(root, observation, selectTrace) {
	root.replaceChildren();
	root.setAttribute("aria-label", "Native telemetry exploration");
	root.append(
		element(
			"p",
			"Bounded retained observations only. Filters, response limits and capture loss can hide parents/children; links below are reported span IDs, not inferred causal or ownership proof.",
		),
	);
	if (observation.representation === "trace-summaries") {
		const list = element("ul");
		for (const row of observation.records) {
			const item = element(
				"li",
				`${row.root} · ${row.rootKind} · ${row.spanCount} captured spans · ${row.errorCount} errors `,
			);
			item.append(
				button(`Inspect trace ${row.traceId}`, () =>
					selectTrace(row.traceId, "traces"),
				),
			);
			list.append(item);
		}
		root.append(list);
	} else if (observation.representation === "flat-spans-with-parent-ids") {
		root.append(element("h4", "Observed span links (partial)"));
		observedSpans(root, observation.records);
		if (observation.traceId)
			root.append(
				button("View linked logs for this trace", () =>
					selectTrace(observation.traceId, "logs"),
				),
			);
	}
	if (!observation.records.length)
		root.append(
			element(
				"p",
				`No matching returned observations. Availability: ${observation.availability ?? "not selected by trace ID"}; inspect raw response selection/loss metadata below.`,
			),
		);
}
