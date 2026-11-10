/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { GenericModal } from "../components/GenericModal";
import { formatHelpText } from "../components/HelpText.tsx";
import { useHover } from "../components/mouse/useHover.ts";
import { useKeyDispatch } from "../components/mouse/useKeybindChips.ts";
import { useRowMouse } from "../components/mouse/useRowMouse.ts";
import { uiColors } from "../theme/colors";
import type { ScriptParameter } from "../types";

export interface TaskArgsModalProps {
	taskName: string;
	parameters: ScriptParameter[];
	values: Record<string, string>;
	selectedIndex: number;
	selectedValueIndex: number;
	focusedPane: "parameter" | "value";
	editing: boolean;
	historyIndex: number;
	historyTotal: number;
	error: string | null;
	/** Pointer: a tap selects a parameter row (the keyboard's `j`/`k`). */
	onSelectParameter?: (index: number) => void;
	/** Pointer: a tap selects a value row. */
	onSelectValue?: (index: number) => void;
	/**
	 * Pointer: a tap in a pane focuses it, so `j`/`k` afterwards moves the list the
	 * developer clicked (the dialog's keys branch on the focused pane).
	 */
	onFocusPane?: (pane: "parameter" | "value") => void;
}

export function TaskArgsModal(props: TaskArgsModalProps) {
	const dispatch = useKeyDispatch();
	const selectedParameterIndex = () =>
		Math.max(
			0,
			Math.min(props.selectedIndex, Math.max(0, props.parameters.length - 1)),
		);
	const selectedParameter = () => props.parameters[selectedParameterIndex()];
	const selectionBg = (pane: "parameter" | "value") =>
		props.focusedPane === pane ? uiColors.bgSurface2 : uiColors.bgMantle;

	const valueFor = (param: ScriptParameter) => {
		const raw = props.values[param.name] ?? param.defaultValue ?? "";
		if (param.type === "bool") return raw === "true" ? "true" : "false";
		return raw;
	};

	const valueOptionsFor = (param?: ScriptParameter) => {
		if (!param) return [];
		if (param.type === "bool") return ["false", "true"];
		if (param.type === "enum" && param.choices?.length) return param.choices;
		return [valueFor(param)];
	};

	const metaFor = (param?: ScriptParameter) => {
		if (!param) return "";
		const required = param.required ? "required" : "optional";
		const flag = param.flag ? ` • ${param.flag}` : "";
		return `${param.type} • ${required}${flag}`;
	};

	return (
		<GenericModal
			title="Run Task"
			helpText={formatHelpText([
				{ key: "h/l", action: "Focus" },
				{ key: "j/k", action: "Move" },
				{ key: "i/Space", action: "Edit/Select" },
				{ key: "Enter", action: props.editing ? "Save Edit" : "Run" },
				{ key: "Esc", action: props.editing ? "Cancel Edit" : "Cancel" },
			])}
			widthPercent={0.82}
			heightPercent={0.85}
		>
			<box
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					marginBottom: 1,
					flexShrink: 0,
				}}
			>
				<text fg={uiColors.textMuted}>task </text>
				<text fg={uiColors.textPrimary}>{props.taskName}</text>
				<text fg={uiColors.textMuted}> • history </text>
				<text fg={uiColors.textSecondary}>
					{props.historyTotal === 0
						? "none"
						: `${props.historyIndex + 1}/${props.historyTotal}`}
				</text>
			</box>

			{props.parameters.length === 0 ? (
				<text fg={uiColors.textMuted}>
					No parameter metadata found for this task.
				</text>
			) : (
				<box
					style={{
						width: "100%",
						flexGrow: 1,
						minHeight: 0,
						flexDirection: "row",
						gap: 2,
					}}
				>
					<box style={{ width: "35%", flexDirection: "column" }}>
						<text
							fg={
								props.focusedPane === "parameter"
									? uiColors.primary
									: uiColors.textPrimary
							}
							attributes={TextAttributes.BOLD}
						>
							Parameter
						</text>
						<For each={props.parameters}>
							{(param, index) => {
								const selected = () => index() === selectedParameterIndex();
								const value = () => valueFor(param);
								const mouse = useRowMouse({
									index,
									selectedIndex: () => selectedParameterIndex(),
									activatable: () => props.onSelectParameter !== undefined,
									onSelect: (row) => {
										props.onFocusPane?.("parameter");
										props.onSelectParameter?.(row);
									},
									// A tap on the selected row runs the dialog's own `Enter`
									// (focus the value pane / run the task), never a no-op.
									onActivate: (row) => {
										props.onSelectParameter?.(row);
										dispatch("Enter");
									},
								});
								const hover = useHover(mouse.onMouseOut);
								const interactive = () => props.onSelectParameter !== undefined;
								return (
									<box
										{...mouse}
										{...hover}
										backgroundColor={
											interactive() && hover.hovered()
												? uiColors.bgHover
												: selected()
													? selectionBg("parameter")
													: undefined
										}
										style={{
											height: 2,
											paddingLeft: 1,
											flexDirection: "column",
											flexShrink: 0,
										}}
									>
										<text
											fg={
												selected() || (interactive() && hover.hovered())
													? uiColors.primary
													: uiColors.textSecondary
											}
										>
											{param.name}
										</text>
										<text fg={uiColors.textMuted}>{value() || "<empty>"}</text>
									</box>
								);
							}}
						</For>
					</box>

					<box style={{ width: "65%", flexDirection: "column" }}>
						<text
							fg={
								props.focusedPane === "value"
									? uiColors.primary
									: uiColors.textPrimary
							}
							attributes={TextAttributes.BOLD}
						>
							{selectedParameter()?.name ?? "Value"}
						</text>
						<text fg={uiColors.textMuted}>{metaFor(selectedParameter())}</text>
						<text fg={uiColors.textTertiary}>
							{selectedParameter()?.description || " "}
						</text>
						<box style={{ height: 1 }} />
						<For each={valueOptionsFor(selectedParameter())}>
							{(option, index) => {
								const valueMouse = useRowMouse({
									index,
									selectedIndex: () => props.selectedValueIndex,
									activatable: () => props.onSelectValue !== undefined,
									onSelect: (row) => {
										props.onFocusPane?.("value");
										props.onSelectValue?.(row);
									},
									onActivate: (row) => {
										props.onSelectValue?.(row);
										dispatch("Enter");
									},
								});
								const hover = useHover(valueMouse.onMouseOut);
								const interactive = () => props.onSelectValue !== undefined;
								const param = () => selectedParameter();
								const selected = () => index() === props.selectedValueIndex;
								const active = () => {
									const p = param();
									return p ? valueFor(p) === option : false;
								};
								const editableScalar = () =>
									param()?.type !== "bool" && param()?.type !== "enum";
								const label = () => {
									const display = option || "<empty>";
									return props.editing && editableScalar()
										? `${display}▌`
										: display;
								};
								return (
									<box
										{...valueMouse}
										{...hover}
										backgroundColor={
											interactive() && hover.hovered()
												? uiColors.bgHover
												: selected()
													? selectionBg("value")
													: undefined
										}
										style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}
									>
										<text fg={active() ? uiColors.success : uiColors.textMuted}>
											{active() ? "● " : "○ "}
										</text>
										<text
											fg={
												selected() || (interactive() && hover.hovered())
													? uiColors.textPrimary
													: uiColors.textSecondary
											}
										>
											{label()}
										</text>
									</box>
								);
							}}
						</For>
					</box>
				</box>
			)}

			{props.error && (
				<box style={{ width: "100%", height: 1, flexShrink: 0, marginTop: 1 }}>
					<text fg={uiColors.error}>{props.error}</text>
				</box>
			)}
		</GenericModal>
	);
}
