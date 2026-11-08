/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createUniqueId,
	onCleanup,
	onMount,
	useContext,
} from "solid-js";
import type { StandaloneSession } from "../../../protocol/standalone.ts";
import type { RowGestureState } from "../../presentation/components/mouse/useRowMouse.ts";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { uiColors } from "../../presentation/theme/colors.ts";
import { ActionRegistry } from "../../ui/ActionHeader.tsx";

/** Original selectable row chrome, with a standalone UUID observation only.
 * Keyboard activation and primary taps share the same navigation guard. */
export function StandaloneSessionRow(props: {
	session: StandaloneSession;
	selected: boolean;
	fresh: boolean;
	interactive: boolean;
	scope: object;
	position: number;
	layout: string;
	open: () => void;
}) {
	const registry = useContext(ActionRegistry),
		id = createUniqueId();
	const gesture: RowGestureState = {};
	let node: BoxRenderable | undefined,
		disposed = false,
		unregister: (() => void) | undefined;
	const signature = createMemo(() =>
		JSON.stringify([
			props.position,
			props.layout,
			props.session.id,
			props.session.mode,
			props.session.title,
			props.session.repository,
			props.session.profile,
			props.session.revision,
			props.session.status,
			props.fresh,
			props.interactive,
		]),
	);
	const retire = () => {
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	createEffect(() => {
		props.scope;
		signature();
		retire();
	});
	const activate = () => {
		if (disposed || !props.interactive) return;
		registry?.select(id);
		props.open();
	};
	onMount(() => {
		unregister = registry?.register({ id, node: () => node, activate });
	});
	onCleanup(() => {
		disposed = true;
		retire();
		unregister?.();
	});
	return (
		<box
			ref={(value) => {
				node = value;
			}}
			flexShrink={0}
		>
			<Selectable
				height={2}
				selected={props.selected || registry?.selected() === id}
				gesture={gesture}
				onMouseUp={activate}
			>
				<text
					fg={props.selected ? uiColors.textPrimary : uiColors.textSecondary}
					wrapMode="none"
					truncate
				>
					<strong>
						{props.session.mode === "pi" ? "π" : "󱚞"} {props.session.title}
					</strong>
				</text>
				<text
					fg={
						props.fresh && props.session.status === "uncertain"
							? uiColors.warning
							: uiColors.textMuted
					}
					wrapMode="none"
					truncate
				>
					{props.fresh ? props.session.status : "cached · activity unknown"} ·
					profile: {props.session.profile}
				</text>
			</Selectable>
		</box>
	);
}
