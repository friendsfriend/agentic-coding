import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { handleActionsKeys } from "./actions-keys";
import { handleAddRepositoryModalKeys } from "./add-repository-modal-keys";
import { handleConnectProviderModalKeys } from "./connect-provider-modal-keys";
import { handleDiffModalKeys } from "./diff-modal-keys";
import { handleGlobalKeys } from "./global-keys";
import { handleLogModalKeys } from "./log-modal-keys";
import { handleMiscModalKeys } from "./misc-modal-keys";
import { handleTableKeys } from "./table-keys";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

export interface ModalKeymapLayerDeps {
	stores: KeyboardStores;
	actions: KeyboardActions;
	ctx: KeyboardContext;
}

const MODAL_PRIORITY = 1_000;
const TEXT_ENTRY_PRIORITY = 1_500;

const COMMON_MODAL_KEYS = [
	"escape",
	"return",
	"enter",
	"backspace",
	"delete",
	"up",
	"down",
	"left",
	"right",
	"j",
	"k",
	"h",
	"l",
	"g",
	"G",
	"d",
	"u",
	"/",
	"?",
	"y",
	"n",
	"c",
	"q",
	"1",
	"2",
	"3",
	"4",
	"5",
	"ctrl+d",
	"ctrl+u",
	"ctrl+enter",
] as const;

const TEXT_KEYS = [
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*() \"'",
].map((key) => (key === " " ? "space" : key));

function bindingsFor(command: string) {
	return [...COMMON_MODAL_KEYS, ...TEXT_KEYS].map((key) => ({
		key,
		cmd: command,
		context: "modal",
		category: "Modal",
		discoverable: false,
	}));
}

export function registerModalKeymapLayers(
	keymap: Keymap<Renderable, KeyEvent>,
	deps: ModalKeymapLayerDeps,
): () => void {
	const runGlobalModal = (event: KeyEvent) =>
		handleGlobalKeys(event, deps.stores, deps.actions, deps.ctx);
	const runAddRepository = (event: KeyEvent) =>
		handleAddRepositoryModalKeys(event, deps.stores, deps.actions);
	const runConnectProvider = (event: KeyEvent) =>
		handleConnectProviderModalKeys(event, deps.stores, deps.actions);
	const runDiff = (event: KeyEvent) =>
		handleDiffModalKeys(event, deps.stores, deps.actions, deps.ctx);
	const runLog = (event: KeyEvent) =>
		handleLogModalKeys(event, deps.stores, deps.actions, deps.ctx);
	const runMisc = (event: KeyEvent) =>
		handleMiscModalKeys(event, deps.stores, deps.actions, deps.ctx);
	const runTable = (event: KeyEvent) =>
		handleTableKeys(event, deps.stores, deps.actions, deps.ctx);
	const runActions = async (event: KeyEvent) => {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc"
		) {
			return handleActionsKeys(
				event,
				deps.stores.actionRunStore,
				deps.stores.appStore,
				deps.actions.dockerActions,
				deps.stores.uiStore,
			);
		}
		if (await runGlobalModal(event)) return true;
		return handleActionsKeys(
			event,
			deps.stores.actionRunStore,
			deps.stores.appStore,
			deps.actions.dockerActions,
			deps.stores.uiStore,
		);
	};

	const modalLayers = [
		{
			modal: "error",
			command: "modal.error.handle",
			title: "Error dialog",
			run: runGlobalModal,
		},
		{
			modal: "confirm",
			command: "modal.confirm.handle",
			title: "Confirm dialog",
			run: runGlobalModal,
		},
		{
			modal: "markdown",
			command: "modal.markdown.handle",
			title: "Markdown modal",
			run: runGlobalModal,
		},
		{
			modal: "theme-picker",
			command: "modal.theme-picker.handle",
			title: "Theme picker",
			run: runGlobalModal,
		},
		{
			modal: "profile-picker",
			command: "modal.profile-picker.handle",
			title: "Profile picker",
			run: runGlobalModal,
		},
		{
			modal: "action-target-picker",
			command: "modal.action-target-picker.handle",
			title: "Action target picker",
			run: runGlobalModal,
		},
		{
			modal: "first-steps",
			command: "modal.first-steps.handle",
			title: "First steps",
			run: runGlobalModal,
		},
		{
			modal: "add-repository",
			command: "modal.add-repository.handle",
			title: "Add repository",
			run: runAddRepository,
		},
		{
			modal: "connect-provider",
			command: "modal.connect-provider.handle",
			title: "Connect provider",
			run: runConnectProvider,
		},
		{
			modal: "diff",
			command: "modal.diff.handle",
			title: "Diff modal",
			run: runDiff,
		},
		{
			modal: "log",
			command: "modal.log.handle",
			title: "Log modal",
			run: runLog,
		},
		{
			modal: "actions",
			command: "modal.actions.handle",
			title: "Action progress modal",
			run: runActions,
		},
		{
			modal: "editor-picker",
			command: "modal.editor-picker.handle",
			title: "Editor picker",
			run: runMisc,
		},
		{
			modal: "task-add",
			command: "modal.task-add.handle",
			title: "Task add modal",
			run: runMisc,
		},
		{
			modal: "task-args",
			command: "modal.task-args.handle",
			title: "Task args modal",
			run: runMisc,
		},
		{
			modal: "passphrase",
			command: "modal.passphrase.handle",
			title: "Passphrase modal",
			run: runMisc,
		},
		{
			modal: "branch",
			command: "modal.branch.handle",
			title: "Branch modal",
			run: runTable,
		},
	] as const;

	const disposers = modalLayers.map(({ modal, command, title, run }) =>
		keymap.registerLayer({
			name: title,
			priority:
				deps.stores.logStore.logAiPromptMode?.() ||
				deps.stores.logStore.logSearchMode?.()
					? TEXT_ENTRY_PRIORITY
					: MODAL_PRIORITY,
			shutdown: false,
			activeModal: modal,
			commands: [
				{
					name: command,
					context: "modal",
					category: "Modal",
					title,
					desc: `Handle ${title} keyboard input.`,
					discoverable: false,
					run: ({ event }) => run(event),
				},
			],
			bindings: bindingsFor(command),
		}),
	);

	return () => {
		for (const dispose of [...disposers].reverse()) dispose();
	};
}
