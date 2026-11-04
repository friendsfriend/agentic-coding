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
	let current = null,
		savedText = empty,
		pending = null;
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
	editor.oninput = () => {
		status.textContent =
			"Unsaved staged edits. Save for schema-only checks; nothing is published or executed.";
	};
	panel.append(selector, list, load, fresh, editor, save, status);
	return panel;
}
