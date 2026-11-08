/** @jsxImportSource @opentui/solid */
// Ported from the original WorkspaceSidebar pinned-entry row. Only the
// navigation data shape is local; row height, marker, clipping and tones stay.

import { uiColors } from "../theme/colors.ts";
import { Selectable } from "./Selectable.tsx";
export function PinRow(props: {
	pin: { glyph: string; label: string; meta: string };
	selected: boolean;
	height: number;
	onActivate: () => void;
}) {
	const clip = (value: string) =>
		value.length > 26 ? `${value.slice(0, 25)}…` : value;
	return (
		<Selectable
			height={props.height}
			selected={props.selected}
			hoverBackground={uiColors.bgHover}
			onMouseUp={props.onActivate}
		>
			{props.height > 1 ? (
				<box style={{ flexDirection: "column" }}>
					<text
						fg={props.selected ? uiColors.textPrimary : uiColors.textSecondary}
					>
						<strong>{props.pin.glyph}</strong>
						{` ${clip(props.pin.label)}`}
					</text>
					<text fg={uiColors.textMuted}>{clip(props.pin.meta)}</text>
				</box>
			) : (
				<text
					fg={props.selected ? uiColors.textPrimary : uiColors.textSecondary}
				>
					{props.pin.glyph}
				</text>
			)}
		</Selectable>
	);
}
