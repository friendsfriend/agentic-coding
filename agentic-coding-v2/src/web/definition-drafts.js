import { definitionHistory } from "./definition-history.js";
import { button, element } from "./dom.js";

export function definitionDrafts(request) {
	const panel = element("details");
	panel.append(element("summary", "Private staged environment JSON"));
	panel.append(
		element(
			"p",
			"Developer-only drafts in private native state, outside repositories. Editing never copies live configuration, publishes, reloads or runs targets; the separate exact-digest-confirmed promotion action writes only the configuration document. Do not paste credentials; use secretRefs. Schema-only checks are not runtime validation or promotion approval. Initial scope: whole environments.json, regular/absent base, no auxiliary files or symlink editing.",
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
		"No preflight loaded. Reports are historical; never runtime validation or approval.",
	);
	report.setAttribute("aria-label", "Historical definition preflight");
	const sourceApp = element("input");
	sourceApp.setAttribute("aria-label", "Compose source app ID");
	sourceApp.maxLength = 128;
	const sourceTarget = element("input");
	sourceTarget.setAttribute("aria-label", "Compose source target ID");
	sourceTarget.maxLength = 128;
	const sourcePermission = element("input");
	sourcePermission.type = "checkbox";
	sourcePermission.setAttribute(
		"aria-label",
		"Allow selected public Compose source read",
	);
	const sourceLabel = element(
		"label",
		"Allow one bounded public Compose file read (no .env/providers, links, source publication or execution)",
	);
	sourceLabel.prepend(sourcePermission);
	const sourceEditor = element("textarea");
	sourceEditor.setAttribute("aria-label", "Private staged Compose YAML");
	sourceEditor.rows = 12;
	sourceEditor.maxLength = 65536;
	const acceptBase = element("input");
	acceptBase.type = "checkbox";
	acceptBase.setAttribute(
		"aria-label",
		"Accept current file as base, not original staging-time base",
	);
	const acceptBaseLabel = element(
		"label",
		"Accept CURRENT file/absence as the base now (not its original staging-time state; no promotion approval)",
	);
	acceptBaseLabel.prepend(acceptBase);
	let pendingCandidate = null;
	let pendingPromotion = null;
	let pendingSourceRemoval = null;
	let pendingDraftRemoval = null;
	let pendingBaseSave = null,
		pendingBaseCheck = null;
	let sourceSavedText = "",
		sourceMarker = "",
		pendingSourceSave = null,
		pendingStagedCheck = null;
	const sourceSelection = () =>
		JSON.stringify([
			current?.id,
			current?.digest,
			sourceApp.value,
			sourceTarget.value,
		]);
	const selectedSource = () => {
		const project = JSON.parse(current.content).projects.find(
				(project) => project.id === sourceApp.value,
			),
			target = project?.targets.find(
				(target) => target.id === sourceTarget.value,
			);
		if (!target?.compose)
			throw Error("Choose an exact saved Compose app/target");
		const file = target.compose.file
			.split("/")
			.filter((part) => part !== ".")
			.join("/");
		return current.sources?.find(
			(source) =>
				source.repository === project.repository && source.file === file,
		);
	};
	let pendingSource = null;
	let current = null,
		savedText = empty,
		pending = null,
		pendingPreflight = null;
	const jsonDirty = () => editor.value !== savedText;
	const dirty = () => jsonDirty() || sourceEditor.value !== sourceSavedText;
	const discard = () =>
		!dirty() ||
		confirm(
			"Discard unsaved draft edits? Saved native revisions remain unchanged.",
		);
	const busy = async (action) => {
		const controls = panel.querySelectorAll("button, select, textarea, input");
		controls.forEach((control) => {
			control.disabled = true;
		});
		try {
			await action();
		} catch (error) {
			status.textContent = `Draft operation failed: ${String(error)}. Text retained. If promotion was attempted, a write may already have occurred; inspect the live destination and retry the same request to resolve its receipt.`;
		} finally {
			controls.forEach((control) => {
				control.disabled = false;
			});
		}
	};
	const describe = (draft) =>
		`${draft.id} · revision ${draft.revision} · ${draft.digest}. ${draft.schema.message} Base observation: ${draft.baseMatches === null ? "unavailable" : draft.baseMatches ? "unchanged" : "CHANGED since creation"}. Live destination: ${draft.destination?.state === "unavailable" ? "unavailable" : draft.destination?.state === "absent" ? "absent" : `regular ${draft.destination?.digest ?? ""}`}. Promotion writes only this exact staged configuration text.`;
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
			sourceEditor.value = "";
			sourceSavedText = "";
			sourceMarker = "";
			sourcePermission.checked = false;
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
		sourceEditor.value = "";
		sourceSavedText = "";
		sourceMarker = "";
		sourcePermission.checked = false;
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
			sourcePermission.checked = false;
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
	const sourceCheck = button(
		"Check selected Compose source (no execution)",
		() =>
			busy(async () => {
				const permitted = sourcePermission.checked;
				sourcePermission.checked = false;
				if (!current || dirty() || !permitted)
					throw Error(
						"Save exact edits and explicitly allow the selected public source read first",
					);
				const body = {
						id: current.id,
						revision: current.revision,
						digest: current.digest,
						readComposeSource: true,
						app: sourceApp.value,
						target: sourceTarget.value,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingSource || pendingSource.fingerprint !== fingerprint)
					pendingSource = { fingerprint, requestId: crypto.randomUUID() };
				try {
					const observed = await request("/api/environments/drafts/preflight", {
						...body,
						requestId: pendingSource.requestId,
					});
					pendingSource = null;
					report.textContent = JSON.stringify(observed, null, 2);
					status.textContent =
						"Historical selected-source report saved (accepted or refused). Source text/values withheld; NOT full-source/runtime validation or promotion approval.";
				} finally {
					sourcePermission.checked = false;
				}
			}),
	);
	const loadSource = button(
		"Load private staged source / new blank buffer",
		() =>
			busy(async () => {
				if (!current || jsonDirty())
					throw Error("Save/load the exact JSON draft first");
				if (
					sourceEditor.value !== sourceSavedText &&
					!confirm("Discard unsaved Compose YAML?")
				)
					return;
				const source = selectedSource();
				sourcePermission.checked = false;
				acceptBase.checked = false;
				sourceEditor.value = source?.content ?? "";
				sourceSavedText = sourceEditor.value;
				sourceMarker = sourceSelection();
				status.textContent = `Private staged source buffer loaded (or new blank). No repository source contents read. ${source?.base && source.base !== "unobserved" ? "Explicit current base established (NOT original staging-time state)." : "Base unobserved."} No promotion authority.`;
			}),
	);
	const saveSource = button(
		"Save selected Compose YAML privately (no publish)",
		() =>
			busy(async () => {
				if (!current || jsonDirty() || sourceMarker !== sourceSelection())
					throw Error(
						"Load the selected source buffer for these exact saved JSON/app/target bindings first",
					);
				const body = {
						id: current.id,
						revision: current.revision,
						app: sourceApp.value,
						target: sourceTarget.value,
						content: sourceEditor.value,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingSourceSave || pendingSourceSave.fingerprint !== fingerprint)
					pendingSourceSave = { fingerprint, requestId: crypto.randomUUID() };
				const receipt = await request("/api/environments/drafts/source", {
						...body,
						requestId: pendingSourceSave.requestId,
					}),
					draft = await request(
						`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
					);
				if (
					draft.revision !== receipt.revision ||
					draft.digest !== receipt.digest
				)
					throw Error(
						"Source receipt exists but draft advanced; load explicitly. Text retained.",
					);
				current = draft;
				sourceSavedText = sourceEditor.value;
				pendingSourceSave = null;
				sourcePermission.checked = false;
				status.textContent = `Private source saved; draft revision ${current.revision}. Source base retained as saved; no execution or promotion.`;
				await refreshList();
			}),
	);
	const removeSavedSource = (selection) =>
		busy(async () => {
			if (!current || dirty())
				throw Error(
					"Save or discard editor text before removing a staged source",
				);
			if (
				!confirm(
					"Remove only this private staged source revision? Repository files, live configuration and historical reports are untouched.",
				)
			)
				return;
			const body = {
					id: current.id,
					revision: current.revision,
					...selection,
				},
				fingerprint = JSON.stringify(body);
			if (
				!pendingSourceRemoval ||
				pendingSourceRemoval.fingerprint !== fingerprint
			)
				pendingSourceRemoval = {
					fingerprint,
					requestId: crypto.randomUUID(),
				};
			const receipt = await request("/api/environments/drafts/source/remove", {
					...body,
					requestId: pendingSourceRemoval.requestId,
				}),
				draft = await request(
					`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
				);
			pendingSourceRemoval = null;
			if (receipt.revision && draft.revision < receipt.revision)
				throw Error("Source removal receipt is behind the current draft");
			current = draft;
			sourceEditor.value = "";
			sourceSavedText = "";
			sourceMarker = sourceSelection();
			status.textContent = `Private staged source removed; draft revision ${current.revision}. No repository, live configuration or report change; no promotion authority.`;
			await refreshList();
		});
	const removeStaged = button(
		"Remove staged source for selected target (private only)",
		() =>
			removeSavedSource({ app: sourceApp.value, target: sourceTarget.value }),
	);
	const bindingSelector = element("select");
	bindingSelector.setAttribute("aria-label", "Saved staged source bindings");
	let listedBindingRevision = "";
	const bindingRevision = () =>
		JSON.stringify([current?.id, current?.revision]);
	const listBindings = button(
		"List saved source bindings (including orphans)",
		() =>
			busy(async () => {
				if (!current || dirty())
					throw Error("Save or discard edits before listing saved bindings");
				const draft = await request(
					`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
				);
				if (
					draft.revision !== current.revision ||
					draft.digest !== current.digest
				)
					throw Error(
						"Draft advanced; load current before selecting a saved binding",
					);
				bindingSelector.replaceChildren(
					...draft.sourceBindings.map((binding) => {
						const option = element(
							"option",
							`${binding.file} · ${binding.repository} · ${binding.bindingDigest}`,
						);
						option.value = binding.bindingDigest;
						return option;
					}),
				);
				listedBindingRevision = bindingRevision();
				status.textContent = `${draft.sourceBindings.length} saved source bindings listed. Removal affects private staged text only, not repository files or historical reports.`;
			}),
	);
	const removeBinding = button(
		"Remove selected saved binding (private only)",
		() => {
			if (
				!bindingSelector.value ||
				listedBindingRevision !== bindingRevision()
			) {
				status.textContent =
					"List saved bindings for the current draft revision before removing one.";
				return;
			}
			return removeSavedSource({ bindingDigest: bindingSelector.value });
		},
	);
	const removeStagedDraft = button("Delete private staged draft", () =>
		busy(async () => {
			if (!current || dirty()) throw Error("Save or discard editor text first");
			if (
				!confirm(
					"Delete only this private staged draft document? Historical preflight reports and receipts remain, and no repository or live configuration changes.",
				)
			)
				return;
			const body = { id: current.id, revision: current.revision },
				fingerprint = JSON.stringify(body);
			if (
				!pendingDraftRemoval ||
				pendingDraftRemoval.fingerprint !== fingerprint
			)
				pendingDraftRemoval = { fingerprint, requestId: crypto.randomUUID() };
			await request("/api/environments/drafts/remove", {
				...body,
				requestId: pendingDraftRemoval.requestId,
			});
			pendingDraftRemoval = null;
			current = null;
			savedText = empty;
			editor.value = empty;
			sourceEditor.value = "";
			sourceSavedText = "";
			report.textContent =
				"No preflight loaded. Reports are historical; never runtime validation or approval.";
			status.textContent =
				"Private staged draft deleted. Historical reports/receipts remain and grant no authority; no repository or live configuration change.";
			await refreshList();
		}),
	);
	const checkStaged = button(
		"Check saved staged Compose YAML (no repository source read)",
		() =>
			busy(async () => {
				if (!current || dirty() || sourceMarker !== sourceSelection())
					throw Error("Save the exact selected source/JSON edits first");
				const body = {
						id: current.id,
						revision: current.revision,
						digest: current.digest,
						app: sourceApp.value,
						target: sourceTarget.value,
						useStagedSource: true,
					},
					fingerprint = JSON.stringify(body);
				if (
					!pendingStagedCheck ||
					pendingStagedCheck.fingerprint !== fingerprint
				)
					pendingStagedCheck = { fingerprint, requestId: crypto.randomUUID() };
				const observed = await request("/api/environments/drafts/preflight", {
					...body,
					requestId: pendingStagedCheck.requestId,
				});
				pendingStagedCheck = null;
				report.textContent = JSON.stringify(observed, null, 2);
				status.textContent =
					"Historical staged-source parser report saved. Repository source contents were NOT read; bind metadata may be checked. No runtime, base fence or promotion authority.";
			}),
	);
	const captureBase = button(
		"Establish current source base (no promotion)",
		() =>
			busy(async () => {
				const allowed = sourcePermission.checked,
					accepted = acceptBase.checked;
				sourcePermission.checked = false;
				acceptBase.checked = false;
				if (
					!current ||
					dirty() ||
					sourceMarker !== sourceSelection() ||
					!allowed ||
					!accepted
				)
					throw Error(
						"Save/load exact selected source, allow its read and explicitly accept current-not-staging-time base first",
					);
				const source = selectedSource();
				if (!source) throw Error("Save selected source first");
				const body = {
						id: current.id,
						revision: current.revision,
						app: sourceApp.value,
						target: sourceTarget.value,
						sourceDigest: source.digest,
						readBase: true,
						acceptCurrentBase: true,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingBaseSave || pendingBaseSave.fingerprint !== fingerprint)
					pendingBaseSave = { fingerprint, requestId: crypto.randomUUID() };
				const receipt = await request("/api/environments/drafts/source/base", {
						...body,
						requestId: pendingBaseSave.requestId,
					}),
					draft = await request(
						`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
					);
				if (
					draft.revision !== receipt.revision ||
					draft.digest !== receipt.digest
				)
					throw Error(
						"Base receipt exists but draft advanced; load explicitly",
					);
				current = draft;
				pendingBaseSave = null;
				status.textContent = `Explicit current source base saved; draft revision ${current.revision}. Not original staging-time state or promotion authority.`;
				await refreshList();
			}),
	);
	const compareBase = button(
		"Compare established source base (read only)",
		() =>
			busy(async () => {
				const allowed = sourcePermission.checked;
				sourcePermission.checked = false;
				if (
					!current ||
					dirty() ||
					sourceMarker !== sourceSelection() ||
					!allowed
				)
					throw Error(
						"Save/load exact source and allow a fresh repository source read first",
					);
				const body = {
						id: current.id,
						revision: current.revision,
						digest: current.digest,
						app: sourceApp.value,
						target: sourceTarget.value,
						compareSourceBase: true,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingBaseCheck || pendingBaseCheck.fingerprint !== fingerprint)
					pendingBaseCheck = { fingerprint, requestId: crypto.randomUUID() };
				const observed = await request("/api/environments/drafts/preflight", {
					...body,
					requestId: pendingBaseCheck.requestId,
				});
				pendingBaseCheck = null;
				report.textContent = JSON.stringify(observed, null, 2);
				status.textContent =
					"Historical live-vs-established-base comparison saved. Does NOT compare staged text with live content, guarantee atomic publication or grant promotion approval.";
			}),
	);
	const savedCheck = (mode, note) =>
		busy(async () => {
			sourcePermission.checked = false;
			acceptBase.checked = false;
			if (!current || dirty())
				throw Error(
					"Save all exact JSON/source edits before checking saved text",
				);
			const body = {
					id: current.id,
					revision: current.revision,
					digest: current.digest,
					[mode]: true,
				},
				fingerprint = JSON.stringify(body);
			if (
				!pendingCandidate ||
				pendingCandidate.fingerprint !== fingerprint ||
				pendingCandidate.mode !== mode
			)
				pendingCandidate = {
					fingerprint,
					mode,
					requestId: crypto.randomUUID(),
				};
			const observed = await request("/api/environments/drafts/preflight", {
				...body,
				requestId: pendingCandidate.requestId,
			});
			pendingCandidate = null;
			report.textContent = JSON.stringify(observed, null, 2);
			status.textContent = note;
		});
	const candidateCheck = button(
		"Check saved Compose candidate (offline; no publish)",
		() =>
			savedCheck(
				"validateStagedCandidate",
				"Historical saved-input candidate manifest/Compose-subset report. NOT isolated-tree validation, fresh base comparison, runtime readiness, review or promotion approval.",
			),
	);
	const treeCheck = button(
		"Assemble isolated staged tree (verify then discard)",
		() =>
			savedCheck(
				"materializeStagedTree",
				"Ephemeral tree assembled from saved text only, verified and discarded. NOT a retained staged tree, runtime/readiness validation, review or promotion approval.",
			),
	);
	const promote = button(
		"Promote exact staged config to live environments.json",
		() =>
			busy(async () => {
				if (!current)
					throw Error("Load and save the staged draft to promote first");
				if (dirty()) throw Error("Save the exact staged text before promoting");
				if (
					!confirm(
						`Write this exact staged content (${current.digest}) to the live environments.json? This changes live configuration; running processes, containers and repositories are untouched.`,
					)
				)
					return;
				const body = {
						id: current.id,
						revision: current.revision,
						digest: current.digest,
						approve: current.digest,
					},
					fingerprint = JSON.stringify(body);
				if (!pendingPromotion || pendingPromotion.fingerprint !== fingerprint)
					pendingPromotion = { fingerprint, requestId: crypto.randomUUID() };
				const record = await request("/api/environments/drafts/promote", {
					...body,
					requestId: pendingPromotion.requestId,
				});
				pendingPromotion = null;
				report.textContent = JSON.stringify(record, null, 2);
				const draft = await request(
					`/api/environments/drafts?id=${encodeURIComponent(current.id)}`,
				);
				current = draft;
				status.textContent = `Historical promotion ${record.outcome} recorded. A retry may replay an earlier outcome without writing or observing the live file. The separately loaded destination below is only a fresh observation, not readiness or reload authority. ${describe(draft)}`;
				await refreshList();
			}),
	);
	const promotionHistory = definitionHistory(request, busy, status, {
		selectionLabel: "Historical configuration promotions",
		reportLabel: "Historical configuration promotion",
		listLabel: "List historical configuration promotions",
		loadLabel: "Load selected historical promotion",
		indexRoute: "/api/environments/drafts/promotions",
		recordRoute: "/api/environments/drafts/promotion",
	});
	const preflightHistory = definitionHistory(request, busy, status, {
		selectionLabel: "Historical saved preflights",
		reportLabel: "Historical saved preflight",
		listLabel: "List historical saved preflights",
		loadLabel: "Load selected historical preflight",
		indexRoute: "/api/environments/drafts/preflights",
		recordRoute: "/api/environments/drafts/preflight",
	});
	const loadReport = button("Load latest saved preflight", () =>
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
		element(
			"p",
			"Optional offline source check: enter the exact saved Compose app/target IDs. Only conventional compose[.profile].yml/yaml or docker-compose[.profile].yml/yaml files in non-private directories are eligible.",
			"meta",
		),
		sourceApp,
		sourceTarget,
		sourceLabel,
		sourceCheck,
		element(
			"p",
			"Alternatively stage Compose YAML privately. Load/new buffer, edit, save separately, then check saved staged bytes. No live-file imports/writes; base unobserved and promotion unsupported.",
			"meta",
		),
		loadSource,
		sourceEditor,
		saveSource,
		checkStaged,
		removeStaged,
		listBindings,
		bindingSelector,
		removeBinding,
		acceptBaseLabel,
		captureBase,
		compareBase,
		candidateCheck,
		treeCheck,
		promote,
		loadReport,
		removeStagedDraft,
		...promotionHistory,
		...preflightHistory,
		status,
		report,
	);
	return panel;
}
