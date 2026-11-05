import { button, element } from "/dom.js";
import { addDatabaseHistory } from "/environment-database-history.js";
import { renderNativeTelemetry } from "/environment-telemetry-view.js";

function field(parent, label, options = {}) {
	const wrapper = element("label", `${label} `),
		control = element(options.choices ? "select" : "input");
	control.setAttribute("aria-label", label);
	if (options.choices)
		for (const value of options.choices) {
			const option = element("option", value);
			option.value = value;
			control.append(option);
		}
	else {
		control.type = options.type ?? "text";
		control.maxLength = options.maxLength ?? 512;
		if (options.min) control.min = String(options.min);
		if (options.max) control.max = String(options.max);
	}
	control.value = options.value ?? "";
	wrapper.append(control);
	parent.append(wrapper);
	return control;
}
function filters(parent, title) {
	const details = element("details", null, "environment-filters");
	details.append(element("summary", title));
	parent.append(details);
	return details;
}
function pre(parent, className) {
	const output =
		parent.querySelector(`pre.${className}`) ?? element("pre", null, className);
	parent.append(output);
	return output;
}
function logReport(log, query) {
	if (!log)
		return "This exact run is outside the retained log response window. No other run’s output was substituted.";
	const metadata = {
		run: log.id,
		query: Object.fromEntries(query),
		selection: log.selection,
		sourceAvailability: log.sourceAvailability,
		sourceTruncated: log.sourceTruncated,
		timeSelection: log.timeSelection,
		framing: log.framing,
	};
	const empty = log.selection.omittedForBudget
		? "Matching lines exceed the retained-log response budget; no complete line was returned."
		: "No matching complete lines in the retained log window.";
	return `${JSON.stringify(metadata, null, 2)}\n\n${log.output || empty}`;
}
function addLogs(root, run, api) {
	const details = filters(root, "Log filters");
	const grep = field(details, "Log grep"),
		since = field(details, "Log since (ISO 8601)", { maxLength: 128 }),
		tail = field(details, "Log tail", {
			type: "number",
			min: 1,
			max: 1000,
			value: "200",
		}),
		service = field(details, "Log service", { maxLength: 128 });
	details.append(
		element(
			"p",
			"Literal grep, then newest matching tail (1–1000). Since uses host receipt time, not event time; unavailable timing/service captures return no dated/service lines, never an unfiltered fallback. Service must name an exact declared captured Compose service. Responses cover a bounded retained run window.",
			"meta",
		),
	);
	const queryButton = button("View redacted logs", async () => {
		queryButton.disabled = true;
		try {
			const query = new URLSearchParams({
				app: run.plan.app,
				tail: tail.value || "200",
			});
			if (run.plan.projectKind === "infrastructure")
				query.set("kind", "infrastructure");
			if (grep.value) query.set("grep", grep.value);
			if (since.value.trim()) query.set("since", since.value.trim());
			if (service.value) query.set("service", service.value);
			const logs = await api(`/api/environments/logs?${query}`),
				log = logs.find((item) => item.id === run.id),
				output = pre(root, "environment-logs");
			output.textContent = logReport(log, query);
		} finally {
			queryButton.disabled = false;
		}
	});
	root.append(queryButton);
}
function addTelemetry(root, run, api) {
	const panel = element("div", null, "environment-native-telemetry"),
		details = filters(panel, "Native telemetry filters");
	root.append(panel);
	const mode = field(details, "Telemetry mode", {
			choices: ["traces", "logs"],
			value: "traces",
		}),
		trace = field(details, "Telemetry trace ID", { maxLength: 32 }),
		limit = field(details, "Telemetry limit", {
			type: "number",
			min: 1,
			max: 200,
			value: "20",
		}),
		since = field(details, "Telemetry since (ISO 8601)", { maxLength: 128 }),
		status = field(details, "Telemetry status", {
			choices: ["all", "error", "success"],
			value: "all",
		}),
		name = field(details, "Telemetry span or root name"),
		severity = field(details, "Telemetry severity", { maxLength: 64 }),
		text = field(details, "Telemetry text");
	details.append(
		element(
			"p",
			"Native ephemeral capture only: exact held run, bounded observations, host receipt time. Trace ID returns spans with parent IDs; logs use severity/text, traces use status/name. Availability is independent of these filters. No provider event-time, live-runtime compatibility or complete history is implied.",
			"meta",
		),
	);
	const exploration = element("div", null, "environment-telemetry-exploration");
	const queryButton = button("View native trace summaries", async () => {
		queryButton.disabled = true;
		queryButton.dataset.pending = "true";
		try {
			const query = new URLSearchParams({
				app: run.plan.app,
				run: run.id,
				mode: mode.value,
				limit: limit.value || "20",
			});
			if (trace.value.trim()) query.set("traceId", trace.value.trim());
			if (since.value.trim()) query.set("since", since.value.trim());
			if (mode.value === "traces") {
				query.set("status", status.value);
				if (name.value) query.set("name", name.value);
			} else {
				if (severity.value) query.set("severity", severity.value);
				if (text.value) query.set("text", text.value);
			}
			const observation = await api(`/api/environments/telemetry?${query}`);
			renderNativeTelemetry(
				exploration,
				observation,
				(traceId, selectedMode) => {
					if (
						root.dataset.nativeReady !== "true" ||
						queryButton.dataset.pending === "true"
					)
						return;
					trace.value = traceId;
					mode.value = selectedMode;
					update();
					queryButton.click();
				},
			);
			for (const control of exploration.querySelectorAll("button"))
				control.disabled = root.dataset.nativeReady !== "true";
			pre(panel, "environment-telemetry").textContent = JSON.stringify(
				{ query: Object.fromEntries(query), observation },
				null,
				2,
			);
		} finally {
			delete queryButton.dataset.pending;
			queryButton.disabled = root.dataset.nativeReady !== "true";
		}
	});
	queryButton.dataset.nativeQuery = "true";
	const update = () => {
		const logs = mode.value === "logs";
		status.disabled = logs;
		name.disabled = logs;
		severity.disabled = !logs;
		text.disabled = !logs;
		queryButton.textContent = logs
			? "View native telemetry logs"
			: trace.value.trim()
				? "View native trace spans"
				: "View native trace summaries";
	};
	mode.onchange = update;
	trace.oninput = update;
	update();
	panel.append(queryButton, exploration);
}
/** Retain the actual form and output nodes across live run revisions. */
export function environmentDiagnostics(run, api, existing) {
	const root = existing ?? element("div", null, "environment-diagnostics");
	if (!existing) {
		root.setAttribute("aria-label", `${run.plan.app} diagnostics (${run.id})`);
		addLogs(root, run, api);
		if (run.plan.telemetry) addTelemetry(root, run, api);
		if (run.plan.projectKind === "infrastructure" && run.plan.queryConnection)
			addDatabaseHistory(root, run, api);
	}
	root.dataset.nativeReady = String(
		run.state === "running" && run.ready === true,
	);
	for (const button of root.querySelectorAll(
		"button[data-native-query], .environment-telemetry-exploration button",
	))
		button.disabled =
			root.dataset.nativeReady !== "true" || button.dataset.pending === "true";
	return root;
}
