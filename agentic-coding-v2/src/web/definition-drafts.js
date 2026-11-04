import { button, element } from "./dom.js";

export function definitionDrafts(request) {
	const panel = element("details");
	panel.append(element("summary", "Private staged environment JSON"));
	panel.append(
		element(
			"p",
			"Developer-only drafts in private native state, outside repositories. This editor neither copies live configuration nor publishes, reloads or runs targets. Do not paste credentials; use secretRefs. Schema-only checks are not runtime validation or promotion approval. Initial scope: whole environments.json, regular/absent base, no auxiliary files or symlink editing.",
			"meta",
		),
	);
	const selector = element("select");
	selector.setAttribute("aria-label", "Saved definition drafts");
	const editor = element("textarea");
	editor.setAttribute("aria-label", "Staged environment JSON");
	editor.rows = 14;
	editor.maxLength = 65536;
	const empty = '{\n  "version": 1,\n  "projects": []\n}\n';
	editor.value = empty;
	const status = element(
		"p",
		"Unsaved new draft. Live definitions are unchanged.",
		"meta",
	);
	status.setAttribute("role", "status");
	const report = element(
		"pre",
		"No metadata preflight loaded. Reports are historical; never runtime validation or approval.",
	);
	report.setAttribute("aria-label", "Historical definition preflight");
	let current = null,
		savedText = empty,
		pending = null,
		pendingPreflight = null;
	const dirty = () => editor.value !== savedText;
	const discard = () =>
		!dirty() ||
		confirm(
			"Discard unsaved draft edits? Saved native revisions remain unchanged.",
		);
	const busy = async (action) => {
		const controls = panel.querySelectorAll("button, select, textarea");
		controls.forEach((control) => {
			control.disabled = true;
		});
		try {
			await action();
		} catch (error) {
			status.textContent = `Draft operation failed: ${String(error)}. Text retained; no live definitions published.`;
		} finally {
			controls.forEach((control) => {
				control.disabled = false;
			});
		}
	};
	const describe = (draft) =>
		`${draft.id} · revision ${draft.revision} · ${draft.digest}. ${draft.schema.message} Base observation: ${draft.baseMatches === null ? "unavailable" : draft.baseMatches ? "unchanged" : "CHANGED since creation"}. No promotion authority.`;
	const refreshList = async () => {
		const drafts = await request("/api/environments/drafts");
		selector.replaceChildren(
			...drafts.map((draft) => {
				const option = element(
					"option",
					`${draft.id} · revision ${draft.revision}`,
				);
				option.value = draft.id;
				return option;
			}),
		);
		if (current && drafts.some((draft) => draft.id === current.id))
			selector.value = current.id;
	};
	const list = button("List saved drafts", () => busy(refreshList));
	const load = button("Load selected draft", () =>
		busy(async () => {
			if (!selector.value) throw Error("Choose a saved draft");
			if (!discard()) return;
			const draft = await request(
				`/api/environments/drafts?id=${encodeURIComponent(selector.value)}`,
			);
			current = draft;
			pending = null;
			editor.value = draft.content;
			savedText = editor.value;
			status.textContent = describe(draft);
			report.textContent =
				"No preflight loaded for this editor state. Load latest saved report explicitly or request a new observation.";
		}),
	);
	const fresh = button("New empty staged draft", () => {
		if (!discard()) return;
		current = null;
		pending = null;
		editor.value = empty;
		savedText = empty;
		status.textContent =
			"Unsaved new draft. No live definition content copied.";
		report.textContent = "Unsaved draft has no preflight coverage.";
	});
	const save = button("Save staged revision (no publish)", () =>
		busy(async () => {
			const body = {
				content: editor.value,
				...(current ? { id: current.id, revision: current.revision } : {}),
			};
			const fingerprint = JSON.stringify(body);
			if (!pending || pending.fingerprint !== fingerprint)
				pending = { fingerprint, requestId: crypto.randomUUID() };
			const receipt = await request("/api/environments/drafts", {
				...body,
				requestId: pending.requestId,
			});
			const draft = await request(
				`/api/environments/drafts?id=${encodeURIComponent(receipt.id)}`,
			);
			if (
				draft.revision !== receipt.revision ||
				draft.digest !== receipt.digest
			)
				throw Error(
					"Saved receipt exists, but another editor advanced the draft. Load current explicitly before retrying",
				);
			current = draft;
			savedText = editor.value;
			pending = null;
			status.textContent = describe(draft);
			await refreshList();
		}),
	);
	const preflight = button(
		"Observe saved draft defaults/paths (no execution)",
		() =>
			busy(async () => {
				if (!current || dirty())
					throw Error("Save these exact edits before metadata preflight");
				const body = {
						id: current.id,
						revision: current.revision,
						digest: current.digest,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingPreflight || pendingPreflight.fingerprint !== fingerprint)
					pendingPreflight = { fingerprint, requestId: crypto.randomUUID() };
				const observed = await request("/api/environments/drafts/preflight", {
					...body,
					requestId: pendingPreflight.requestId,
				});
				pendingPreflight = null;
				report.textContent = JSON.stringify(observed, null, 2);
				status.textContent =
					"Metadata preflight saved for the displayed revision. Historical observation only; NOT source-content validation, runtime validation or promotion approval.";
				const refreshed = await request(
					`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
				);
				current.preflightReports = refreshed.preflightReports;
			}),
	);
	const loadReport = button("Load latest saved metadata preflight", () =>
		busy(async () => {
			if (!current) throw Error("Load a saved draft first");
			const latest = await request(
					`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
				),
				id = latest.preflightReports?.at(-1)?.id;
			if (!id) throw Error("No saved preflight for this draft");
			report.textContent = JSON.stringify(
				await request(
					`/api/environments/drafts/preflight?id=${encodeURIComponent(id)}`,
				),
				null,
				2,
			);
			status.textContent =
				"Historical report loaded, possibly for a different revision/source state. Unsaved editor text was NOT checked. No runtime validation or approval.";
		}),
	);
	editor.oninput = () => {
		status.textContent =
			"Unsaved staged edits. Save for schema-only checks; nothing is published or executed.";
	};
	panel.append(
		selector,
		list,
		load,
		fresh,
		editor,
		save,
		preflight,
		loadReport,
		status,
		report,
	);
	return panel;
}
