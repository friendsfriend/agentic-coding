/** @jsxImportSource @opentui/solid */
// Environments feature of the unified shell (compose-unified-feature-shell,
// task 2.3). The imported devenv environment content is mounted in `embedded`
// mode: it shares the shell's single renderer and keymap provider, and does not
// own the terminal dimensions, header/footer, exit guard or shutdown sequence.
import { TUIApp } from "../../../packages/devenv/cli/src/tui/app-opentui";

export interface EnvironmentsFeatureProps {
	serverUrl: string;
	/** Embedded mode publishes the environment's live command registrations so
	 * the shell footer/help project the real keymap metadata (task 3.6). */
	onKeybindCatalog?: (
		sections: Array<{
			title: string;
			keybinds: Array<{ key: string; action: string }>;
		}>,
	) => void;
	active?: () => boolean;
	onModalChange?: (open: boolean) => void;
}

export function EnvironmentsFeature(props: EnvironmentsFeatureProps) {
	return (
		<TUIApp
			serverUrl={props.serverUrl}
			embedded
			onKeybindCatalog={props.onKeybindCatalog}
			active={props.active}
			onModalChange={props.onModalChange}
		/>
	);
}
