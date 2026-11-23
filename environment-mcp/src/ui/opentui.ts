import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	type Renderable,
	ScrollBoxRenderable,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} from "@opentui/core";
import type { UiCapabilityApi } from "./capability-api.ts";
import {
	createEnvironmentUiController,
	type EnvironmentUiController,
	type EnvironmentUiSnapshot,
} from "./controller.ts";

export type EnvironmentTuiOptions = {
	title?: string;
	/** Mount under an existing root (OpenCode plugin); defaults to renderer.root. */
	mount?: Renderable;
	/** Called when the user quits; the external host keeps ownership of its renderer. */
	onQuit?: () => void;
};

/** Server-independent OpenTUI view. The controller owns all state and talks only
 * to `UiCapabilityApi`; this module owns rendering and key focus. `mount` can be
 * embedded in another OpenTUI root; `runEnvironmentTui` is the standalone host. */
export async function mountEnvironmentTui(
	renderer: CliRenderer,
	api: UiCapabilityApi,
	options: EnvironmentTuiOptions = {},
): Promise<EnvironmentUiController> {
	const controller = createEnvironmentUiController(api);
	const done = Promise.withResolvers<void>();
	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: "100%",
		height: "100%",
		padding: 1,
		gap: 1,
		backgroundColor: "#101014",
	});
	const header = new TextRenderable(renderer, {
		content: options.title ?? "Environment MCP",
		fg: "#8ab4f8",
	});
	const body = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		border: true,
		borderStyle: "rounded",
		borderColor: "#3c3c46",
		padding: 1,
		gap: 1,
	});
	const footer = new TextRenderable(renderer, { content: "", fg: "#8b8b96" });
	root.add(header);
	root.add(body);
	root.add(footer);
	(options.mount ?? renderer.root).add(root);

	const clearBody = () => {
		for (const child of body.getChildren()) {
			body.remove(child);
			child.destroy();
		}
	};
	const quit = () => {
		done.resolve();
	};
	const setFooter = (text: string) => {
		footer.content = text;
	};
	const focusFirst = (inputs: readonly InputRenderable[]) => {
		inputs[0]?.focus();
	};

	const render = (snapshot: EnvironmentUiSnapshot) => {
		clearBody();
		const view = snapshot.view;
		if (view === "loading") {
			body.add(
				new TextRenderable(renderer, { content: "Loading capabilities…" }),
			);
			setFooter("q quit");
			return;
		}
		if (view === "list") {
			const select = new SelectRenderable(renderer, {
				flexGrow: 1,
				options: snapshot.actions.map((action) => ({
					name: `${action.label}  ${action.name}`,
					description: action.description,
					value: action.name,
				})),
				selectedIndex: snapshot.selectedIndex,
				showDescription: true,
				showScrollIndicator: true,
			});
			select.on(SelectRenderableEvents.SELECTION_CHANGED, () =>
				controller.select(select.getSelectedIndex()),
			);
			select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
				controller.openSelected();
			});
			body.add(select);
			select.focus();
			setFooter(
				snapshot.message
					? `${snapshot.message} · ↑↓ move · Enter open · r refresh · q quit`
					: "↑↓ move · Enter open · r refresh · q quit",
			);
			return;
		}
		if (view === "form" && snapshot.action) {
			body.add(
				new TextRenderable(renderer, {
					content: `${snapshot.action.label} (${snapshot.action.name})`,
					fg: "#c9d1d9",
				}),
			);
			body.add(
				new TextRenderable(renderer, {
					content: snapshot.action.description,
					fg: "#8b8b96",
					wrapMode: "word",
				}),
			);
			const inputs: InputRenderable[] = [];
			const submit = () => {
				void controller.submit();
			};
			for (const field of snapshot.fields) {
				const description = field.description ? ` — ${field.description}` : "";
				body.add(
					new TextRenderable(renderer, {
						content: `${field.name} (${field.kind})${field.required ? " *" : ""}${description}`,
						fg: "#8ab4f8",
						wrapMode: "word",
					}),
				);
				if (field.kind === "boolean" || field.enumValues) {
					const values = field.enumValues ?? ["false", "true"];
					const select = new SelectRenderable(renderer, {
						options: values.map((value) => ({
							name: value,
							description: `Set ${field.name} to ${value}`,
							value,
						})),
						selectedIndex: Math.max(
							0,
							values.indexOf(snapshot.values[field.name] ?? ""),
						),
						showDescription: false,
						height: Math.min(6, values.length + 2),
					});
					select.on(SelectRenderableEvents.SELECTION_CHANGED, () =>
						controller.setValue(
							field.name,
							values[select.getSelectedIndex()] ?? "",
						),
					);
					body.add(select);
				} else {
					const input = new InputRenderable(renderer, {
						value: snapshot.values[field.name] ?? "",
						placeholder: field.required ? "required" : "optional",
						width: "100%",
					});
					input.on(InputRenderableEvents.INPUT, () =>
						controller.setValue(field.name, input.value),
					);
					input.on(InputRenderableEvents.ENTER, () => {
						const index = inputs.indexOf(input);
						const next = inputs[index + 1];
						if (next) next.focus();
						else submit();
					});
					inputs.push(input);
					body.add(input);
				}
			}
			if (snapshot.fields.length === 0) {
				const run = new SelectRenderable(renderer, {
					options: [
						{ name: "Run", description: "Execute this action", value: "run" },
					],
					showDescription: true,
					height: 3,
				});
				run.on(SelectRenderableEvents.ITEM_SELECTED, submit);
				body.add(run);
				run.focus();
			} else {
				focusFirst(inputs);
				if (inputs.length === 0) {
					const selects = body
						.getChildren()
						.filter(
							(child): child is SelectRenderable =>
								child instanceof SelectRenderable,
						);
					selects[0]?.focus();
				}
			}
			body.add(
				new TextRenderable(renderer, {
					content: snapshot.message ?? "",
					fg: "#ff8f8f",
				}),
			);
			setFooter("Tab/↑↓ fields · Enter next · Ctrl+Enter run · Esc cancel");
			return;
		}
		if (view === "running" && snapshot.action) {
			body.add(
				new TextRenderable(renderer, {
					content: `Running ${snapshot.action.label}…`,
					fg: "#ffd166",
				}),
			);
			setFooter("Esc cancel");
			return;
		}
		if (view === "traces" && snapshot.action) {
			body.add(
				new TextRenderable(renderer, {
					content: `${snapshot.action.label} traces`,
					fg: "#8ab4f8",
				}),
			);
			if (snapshot.result)
				body.add(
					new TextRenderable(renderer, {
						content: snapshot.result,
						fg: "#8b8b96",
						wrapMode: "word",
					}),
				);
			const select = new SelectRenderable(renderer, {
				flexGrow: 1,
				options: (snapshot.traces ?? []).map((trace) => ({
					name: `${trace.traceId.slice(0, 12)}  ${trace.root}  ${trace.spanCount} spans  ${trace.errors} errors`,
					description: trace.traceId,
					value: trace.traceId,
				})),
				selectedIndex: snapshot.traceIndex,
				showDescription: true,
				showScrollIndicator: true,
			});
			select.on(SelectRenderableEvents.SELECTION_CHANGED, () =>
				controller.selectTrace(select.getSelectedIndex()),
			);
			select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
				void controller.openTrace();
			});
			body.add(select);
			select.focus();
			setFooter("↑↓ trace · Enter open · Esc back · q quit");
			return;
		}
		if (view === "result" && snapshot.action) {
			body.add(
				new TextRenderable(renderer, {
					content: `${snapshot.action.label} result`,
					fg: "#8ab4f8",
				}),
			);
			const scroll = new ScrollBoxRenderable(renderer, {
				flexGrow: 1,
				scrollY: true,
				scrollX: false,
				border: false,
			});
			scroll.add(
				new TextRenderable(renderer, {
					content: snapshot.result ?? "",
					wrapMode: "word",
					selectable: true,
				}),
			);
			body.add(scroll);
			scroll.focus();
			setFooter("↑↓ scroll · Esc back · q quit");
			return;
		}
		if (view === "error") {
			body.add(
				new TextRenderable(renderer, {
					content: `Error: ${snapshot.message ?? "request failed"}`,
					fg: "#ff8f8f",
					wrapMode: "word",
				}),
			);
			setFooter("Esc back · r refresh · q quit");
			return;
		}
	};

	const keypress = (key: KeyEvent) => {
		const view = controller.getSnapshot().view;
		if (
			key.name === "q" &&
			(view === "list" ||
				view === "traces" ||
				view === "result" ||
				view === "error")
		) {
			key.preventDefault();
			quit();
			return;
		}
		if (key.name === "r" && (view === "list" || view === "error")) {
			key.preventDefault();
			void controller.load();
			return;
		}
		if (
			view === "form" &&
			key.ctrl &&
			(key.name === "return" || key.name === "enter")
		) {
			key.preventDefault();
			void controller.submit();
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			if (view === "running") controller.cancel();
			else controller.back();
		}
	};
	renderer.keyInput.on("keypress", keypress);
	const unsubscribe = controller.subscribe(() => {
		render(controller.getSnapshot());
	});
	render(controller.getSnapshot());
	void controller.load();
	try {
		await done.promise;
	} finally {
		unsubscribe();
		renderer.keyInput.off("keypress", keypress);
		root.destroy();
		options.onQuit?.();
	}
	return controller;
}

/** Standalone host: owns the terminal renderer and closes it after quit. */
export async function runEnvironmentTui(
	api: UiCapabilityApi,
	options: EnvironmentTuiOptions = {},
): Promise<void> {
	process.env.FORCE_COLOR = "3";
	const renderer = await createCliRenderer({
		targetFps: 30,
		exitOnCtrlC: false,
		openConsoleOnError: false,
		exitSignals: [],
	});
	try {
		await mountEnvironmentTui(renderer, api, options);
	} finally {
		renderer.destroy();
	}
}
