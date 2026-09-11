/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { HelpModal } from "./HelpModal";
import { activeModalHelp, modalHelpOffset, modalHelpOpen } from "./modalHelp";

/**
 * The open modal's own `?` help, reused from the shared HelpModal. Rendered by
 * a surface (or an embedded modal family) above the dialog; the catalog comes
 * from the topmost mounted modal that published one.
 *
 * It lives beside GenericModal rather than inside it so the help modal and the
 * modal shell do not form a runtime import cycle.
 */
export function ModalHelpOverlay(props: { zIndex?: number }) {
	const registration = () => activeModalHelp();
	const sections = () => registration()?.sections() ?? [];
	const lines = () => registration()?.lines() ?? 5;
	return (
		<Show when={modalHelpOpen() && sections().length > 0}>
			<HelpModal
				title="Keybindings"
				offset={modalHelpOffset()}
				lines={lines()}
				sections={sections()}
				zIndex={props.zIndex}
			/>
		</Show>
	);
}
