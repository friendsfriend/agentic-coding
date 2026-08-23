/** @jsxImportSource @opentui/solid */

import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";

export function ProgressModal(props: { message: string }) {
	return (
		<GenericModal title="Creating workflow" heightLines={7} help={[]}>
			<box alignItems="center" justifyContent="center">
				<text fg={uiColors.primary}>● {props.message}</text>
			</box>
		</GenericModal>
	);
}
