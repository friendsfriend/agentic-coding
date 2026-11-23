import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	type KeyEvent,
	type Renderable,
	ScrollBoxRenderable,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} from "@opentui/core";
import type { OperatorApi, OperatorOperation } from "./client.ts";
import {
	createOperatorUiController,
	type OperatorUiController,
	type OperatorUiSnapshot,
} from "./controller.ts";

export type OperatorTuiOptions = {
	title?: string;
	mount?: Renderable;
	onQuit?: () => void;
};

const planText = (operation: OperatorOperation) => {
	try {
		return JSON.stringify(JSON.parse(operation.plan), null, 2);
	} catch {
		return operation.plan;
	}
};
const resultText = (
	operation: OperatorOperation,
	decision: string | undefined,
) => {
	let result: unknown = operation.result;
	if (typeof operation.result === "string") {
		try {
			result = JSON.parse(operation.result);
		} catch {
			/* Retain the plain result text. */
		}
	}
	return JSON.stringify(
		{
			decision,
			state: operation.state,
			revision: operation.revision,
			inspectionRequired: operation.inspectionRequired,
			result,
		},
		null,
		2,
	);
};

/** Human-only OpenTUI over the authenticated operator API. It is not mounted
 * from the agent capability registry. */
export async function mountOperatorTui(
	renderer: CliRenderer,
	api: OperatorApi,
	options: OperatorTuiOptions = {},
): Promise<OperatorUiController> {
	const controller = createOperatorUiController(api);
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
		content: options.title ?? "Environment operator",
		fg: "#ffb86b",
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
	const quit = () => done.resolve();
	const summary = (snapshot: OperatorUiSnapshot) => {
		const operation = snapshot.operation;
		if (!operation) return "";
		return `${operation.state} · revision ${operation.revision} · ${operation.id}`;
	};
	const planView = (text: string, title: string, description?: string) => {
		body.add(
			new TextRenderable(renderer, {
				content: title,
				fg: "#ffb86b",
				wrapMode: "word",
			}),
		);
		if (description)
			body.add(
				new TextRenderable(renderer, {
					content: description,
					fg: "#8b8b96",
					wrapMode: "word",
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
				content: text,
				wrapMode: "word",
				selectable: true,
			}),
		);
		body.add(scroll);
		scroll.focus();
	};
	const render = (snapshot: OperatorUiSnapshot) => {
		clearBody();
		if (snapshot.view === "loading") {
			body.add(
				new TextRenderable(renderer, {
					content: snapshot.message ?? "Loading operator operations…",
				}),
			);
			footer.content = "Ctrl+C quit";
			return;
		}
		if (snapshot.view === "list") {
			const select = new SelectRenderable(renderer, {
				flexGrow: 1,
				options: snapshot.operations.map((operation) => ({
					name: `${operation.state === "awaiting-approval" ? "approve" : operation.state}  ${operation.id.slice(0, 8)}${operation.inspectionRequired ? "  ⚠ inspect" : ""}`,
					description: `${operation.scope.slice(0, 8)} · rev ${operation.revision} · ${new Date(operation.createdAt).toISOString()}`,
					value: operation.id,
				})),
				selectedIndex: snapshot.selectedIndex,
				showDescription: true,
				showScrollIndicator: true,
			});
			select.on(SelectRenderableEvents.SELECTION_CHANGED, () =>
				controller.select(select.getSelectedIndex()),
			);
			select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
				void controller.inspectSelected();
			});
			body.add(select);
			select.focus();
			footer.content = `${snapshot.message ? `${snapshot.message} · ` : ""}↑↓ move · Enter inspect · r refresh · q quit`;
			return;
		}
		if (snapshot.view === "detail" && snapshot.operation) {
			const operation = snapshot.operation;
			planView(
				planText(operation),
				`${operation.state} · revision ${operation.revision}`,
				`${operation.id}\n${operation.inspectionRequired ? "Inspection required before acknowledgement. " : ""}Digest ${operation.digest}`,
			);
			footer.content =
				operation.state === "awaiting-approval"
					? "a approve · x reject · Esc back · q quit"
					: operation.state === "interrupted" && operation.inspectionRequired
						? "k acknowledge · Esc back · q quit"
						: "Esc back · q quit";
			return;
		}
		if (snapshot.view === "confirm" && snapshot.operation) {
			planView(
				planText(snapshot.operation),
				snapshot.message ?? "Confirm exact plan",
				summary(snapshot),
			);
			footer.content = "y confirm · n/Esc cancel";
			return;
		}
		if (snapshot.view === "running") {
			body.add(
				new TextRenderable(renderer, {
					content: snapshot.message ?? "Submitting operator request…",
					fg: "#ffd166",
				}),
			);
			footer.content = "Ctrl+C quit";
			return;
		}
		if (snapshot.view === "result" && snapshot.operation) {
			planView(
				resultText(snapshot.operation, snapshot.decision),
				`Operator ${snapshot.decision ?? "request"} recorded`,
				summary(snapshot),
			);
			footer.content = "Esc back · q quit";
			return;
		}
		body.add(
			new TextRenderable(renderer, {
				content: `Error: ${snapshot.message ?? "operator request failed"}`,
				fg: "#ff8f8f",
				wrapMode: "word",
			}),
		);
		footer.content = "Esc back · r refresh · q quit";
	};

	const keypress = (key: KeyEvent) => {
		const view = controller.getSnapshot().view;
		if (key.ctrl && key.name === "c") {
			key.preventDefault();
			quit();
			return;
		}
		if (key.name === "q" && view !== "confirm" && view !== "running") {
			key.preventDefault();
			quit();
			return;
		}
		if (key.name === "r" && (view === "list" || view === "error")) {
			key.preventDefault();
			void controller.load();
			return;
		}
		if (view === "detail" && key.name === "a") {
			key.preventDefault();
			controller.requestDecision("approved");
			return;
		}
		if (view === "detail" && key.name === "x") {
			key.preventDefault();
			controller.requestDecision("rejected");
			return;
		}
		if (view === "detail" && key.name === "k") {
			key.preventDefault();
			void controller.acknowledge();
			return;
		}
		if (view === "confirm" && key.name === "y") {
			key.preventDefault();
			void controller.confirmDecision();
			return;
		}
		if (view === "confirm" && (key.name === "n" || key.name === "escape")) {
			key.preventDefault();
			controller.cancelConfirmation();
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			controller.back();
		}
	};
	renderer.keyInput.on("keypress", keypress);
	const unsubscribe = controller.subscribe(() =>
		render(controller.getSnapshot()),
	);
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

export async function runOperatorTui(
	api: OperatorApi,
	options: OperatorTuiOptions = {},
): Promise<void> {
	process.env.FORCE_COLOR = "3";
	const renderer = await createCliRenderer({
		targetFps: 30,
		exitOnCtrlC: false,
		openConsoleOnError: false,
		exitSignals: [],
	});
	try {
		await mountOperatorTui(renderer, api, options);
	} finally {
		renderer.destroy();
	}
}
