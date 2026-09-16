/** @jsxImportSource @opentui/solid */
// Environments feature of the unified shell (compose-unified-feature-shell,
// task 2.3). The imported devenv environment content is mounted in `embedded`
// mode: it shares the shell's single renderer and keymap provider, and does not
// own the terminal dimensions, header/footer, exit guard or shutdown sequence.

import { publishHostChrome } from "@devenv/ui";
import { createEffect, onCleanup } from "solid-js";
import { TUIApp } from "../../../packages/devenv/cli/src/tui/app-opentui";

/**
 * Chrome the page shell renders around this body: the logo bar and the
 * breadcrumb row in `otel/app/App.tsx`. The shell owns both, so the embedded
 * feature reserves exactly these rows and suppresses the identity rows the
 * breadcrumb already names.
 */
const SHELL_CHROME_LINES = 2;

export interface EnvironmentsFeatureProps {
	serverUrl: string;
	/** Shell route authority: the destination the page shell is showing, and the
	 * report of the feature's own destination changes (task 2.2). Structural
	 * typing keeps the shell layer free of an environment package import. */
	destination?: () =>
		| {
				category?: string;
				view?: string;
				onChange?: (destination: {
					category: string;
					view: string;
					resourceId?: string;
				}) => void;
		  }
		| undefined;
	/** Embedded mode publishes the environment's live command registrations so
	 * the shell footer/help project the real keymap metadata (task 3.6). */
	onKeybindCatalog?: (
		sections: Array<{
			title: string;
			keybinds: Array<{ key: string; action: string }>;
		}>,
	) => void;
	/** Contextual workflow launch: the shell owns form and start boundary, so the
	 * resource page only reports the configured identity it renders. */
	onStartWorkflow?: (target: {
		ident: string;
		name: string;
		repository: string;
	}) => void;
	active?: () => boolean;
	onModalChange?: (open: boolean) => void;
}

export function EnvironmentsFeature(props: EnvironmentsFeatureProps) {
	// Publish the surrounding chrome once: the ui-package views read it for their
	// identity rows and their line budget, and clearing it on cleanup restores
	// standalone behavior for any later mount.
	createEffect(() => {
		publishHostChrome({ lines: SHELL_CHROME_LINES, namesPage: true });
		onCleanup(() => publishHostChrome(undefined));
	});
	return (
		<TUIApp
			serverUrl={props.serverUrl}
			embedded
			chromeLines={SHELL_CHROME_LINES}
			onKeybindCatalog={props.onKeybindCatalog}
			active={props.active}
			onModalChange={props.onModalChange}
			destination={props.destination?.()}
			{...(props.onStartWorkflow
				? { onStartWorkflow: props.onStartWorkflow }
				: {})}
		/>
	);
}
