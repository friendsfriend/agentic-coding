/** @jsxImportSource @opentui/solid */
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";

export interface TaskAddModalProps {
	mode: "create" | "link";
	targetPath: string;
	sourcePath: string;
	selectedField: number;
	error: string | null;
}

export function TaskAddModal(props: TaskAddModalProps) {
	const modeLabel = () =>
		props.mode === "create" ? "Create new task" : "Use existing task file";

	const row = (label: string, value: string, selected: boolean) => (
		<box
			style={{
				width: "100%",
				height: 2,
				flexDirection: "column",
				marginBottom: 1,
				paddingLeft: 1,
			}}
			backgroundColor={selected ? uiColors.bgSurface0 : undefined}
		>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<text fg={selected ? uiColors.primary : uiColors.textMuted}>
					{selected ? "▶ " : "  "}
				</text>
				<text fg={uiColors.textMuted}>{label}</text>
			</box>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<text fg={value.trim() ? uiColors.textPrimary : uiColors.textTertiary}>
					{value.trim() ? value : "<empty>"}
				</text>
			</box>
		</box>
	);

	return (
		<GenericModal
			title="Add Task"
			helpText={formatHelpText([
				{ key: "Enter", action: "Create/Link" },
				{ key: "j/k or Tab", action: "Select Field" },
				{ key: "←/→/Space", action: "Toggle Mode" },
				{ key: "Type/Bksp", action: "Edit Field" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.78}
			heightPercent={0.5}
		>
			<box
				style={{
					width: "100%",
					height: 2,
					flexDirection: "column",
					marginBottom: 1,
					flexShrink: 0,
				}}
			>
				<text fg={uiColors.textMuted}>
					Use target name/path as relative path under tasks directory
					(`$DEVENV_HOME/scripts/`) (e.g. folder/subfolder/task or task)
				</text>
				<text fg={uiColors.textMuted}>
					If extension is omitted, .sh is used (or source extension for linked
					task files).
				</text>
			</box>

			{row("Mode", modeLabel(), props.selectedField === 0)}
			{row("Target name/path", props.targetPath, props.selectedField === 1)}
			{props.mode === "link" &&
				row(
					"Source task file path",
					props.sourcePath,
					props.selectedField === 2,
				)}

			{props.error && (
				<box style={{ width: "100%", height: 1, flexShrink: 0, marginTop: 1 }}>
					<text fg={uiColors.error}>{props.error}</text>
				</box>
			)}
		</GenericModal>
	);
}
