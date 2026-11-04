import { button, element } from "./dom.js";

// A persistent, independent panel: polling must not replace the selection or report.
export function definitionDiscovery(request) {
	const panel = element("details");
	panel.append(element("summary", "Discover environment definition hints"));
	panel.append(
		element(
			"p",
			"Read-only root manifest evidence, not trusted definitions. No commands, engine probes, private .env/provider reads, edits or imports. Only package.json contents are parsed (script bodies withheld); other known root files are metadata only. Nested layouts, defaults, services, ports and readiness need explicit authoring.",
			"meta",
		),
	);
	const label = element("label", "Repository for discovery");
	const repository = element("select");
	repository.setAttribute("aria-label", "Repository for discovery");
	label.append(repository);
	const status = element(
		"p",
		"Choose an authorized repository; rescan after source edits.",
		"meta",
	);
	status.setAttribute("role", "status");
	const report = element("pre");
	report.setAttribute("aria-label", "Definition discovery report");
	const scan = button("Inspect root definition evidence", async () => {
		repository.disabled = true;
		scan.disabled = true;
		report.textContent = "";
		status.textContent = "Reading bounded manifest evidence…";
		try {
			const result = await request(
				`/api/environments/discovery?repository=${encodeURIComponent(repository.value)}`,
			);
			report.textContent = JSON.stringify(result, null, 2);
			status.textContent =
				"Observation only, not validation or promotion authority. No configuration changed. Invocations are hints, not executable target definitions. Rescan after source edits.";
		} catch (error) {
			status.textContent = `Discovery failed: ${String(error)}`;
		} finally {
			repository.disabled = false;
			scan.disabled = !repository.value;
		}
	});
	scan.disabled = true;
	repository.onchange = () => {
		report.textContent = "";
		status.textContent =
			"Selection changed; inspect this repository explicitly.";
		scan.disabled = !repository.value;
	};
	panel.append(label, scan, status, report);
	let previous = "";
	return {
		panel,
		update(repositories) {
			const signature = JSON.stringify(repositories);
			if (signature === previous) return;
			previous = signature;
			const selected = repository.value;
			repository.replaceChildren(
				...repositories.map((value) => {
					const option = element("option", value);
					option.value = value;
					return option;
				}),
			);
			if (repositories.includes(selected)) repository.value = selected;
			report.textContent = "";
			status.textContent = repositories.length
				? "Choose an authorized repository; rescan after source edits."
				: "No authorized repositories configured.";
			scan.disabled = !repository.value;
		},
	};
}
