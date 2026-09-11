/** @jsxImportSource @opentui/solid */

import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { ScrollableContent } from "./ScrollableContent";

export function ErrorDialog(props: {
	title: string;
	message: string;
	onClose: () => void;
	onScrollBoxReady?: (scrollBox: { scrollBy(dy: number): void }) => void;
	/** Advertise and register the dialog's own `?` help catalog. Surfaces that
	 * render the dialog globally (no local modal-help overlay) opt out. */
	showHelp?: boolean;
	/** Portal z-index; defaults to the dashboard's legacy `1`. */
	zIndex?: number;
}) {
	return (
		<GenericModal
			title={`✗ ${props.title}`}
			titleColor={uiColors.error}
			help={[
				{ key: "j/k", action: "Scroll" },
				{ key: "Esc", action: "Close" },
			]}
			helpSections={props.showHelp === false ? false : undefined}
			widthPercent={0.7}
			heightPercent={0.55}
			zIndex={props.zIndex ?? 1}
			onBackdropClick={props.onClose}
		>
			<box
				width="100%"
				flexGrow={1}
				flexDirection="column"
				paddingTop={1}
				paddingBottom={1}
			>
				<ScrollableContent onScrollBoxReady={props.onScrollBoxReady}>
					<text fg={uiColors.textPrimary}>{props.message}</text>
				</ScrollableContent>
			</box>
		</GenericModal>
	);
}
