/** @jsxImportSource @opentui/solid */

import type { ScriptParameter } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";

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
}

export function TaskArgsModal(props: TaskArgsModalProps) {
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
								return (
									<box
										backgroundColor={
											selected() ? selectionBg("parameter") : undefined
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
												selected() ? uiColors.primary : uiColors.textSecondary
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
										backgroundColor={
											selected() ? selectionBg("value") : undefined
										}
										style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}
									>
										<text fg={active() ? uiColors.success : uiColors.textMuted}>
											{active() ? "● " : "○ "}
										</text>
										<text
											fg={
												selected()
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
