/** @jsxImportSource @opentui/solid */

import type { ActionTarget } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface ActionTargetPickerProps {
	title?: string;
	targets: ActionTarget[];
	selectedIndex: number;
	loading?: boolean;
}

function targetBadge(target: ActionTarget): string {
	if (target.runtime === "shell" && target.launchMode === "tmux")
		return "[tmux]";
	return `[${target.runtime}]`;
}

export function formatActionTargetLabel(target: ActionTarget): string {
	const profile = target.profile ? ` (${target.profile})` : "";
	return `${targetBadge(target)} ${target.label}${profile}`;
}

function targetDetails(target: ActionTarget): string {
	if (target.runtime !== "kubernetes" || !target.kubernetes) return "";
	const k = target.kubernetes;
	const chart = k.chartPath.split(/[\\/]/).slice(-2).join("/");
	const parts = [`chart ${chart}`, `release ${k.release}`, `ns ${k.namespace}`];
	if (k.image?.repository)
		parts.push(`image ${k.image.repository}:${k.image.tag || "dev"}`);
	if (k.secrets?.length)
		parts.push(`secrets ${k.secrets.map((s) => s.name).join(",")}`);
	if (k.ports?.length)
		parts.push(
			`ports ${k.ports.map((p) => `${p.localPort}:${p.remotePort}`).join(",")}`,
		);
	if (target.requires?.length) parts.push(`deps ${target.requires.length}`);
	return parts.join(" · ");
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function ActionTargetRow(props: { target: ActionTarget; isSelected: boolean }) {
	const details = () => targetDetails(props.target);
	const text = () =>
		details()
			? `${formatActionTargetLabel(props.target)} — ${details()}`
			: formatActionTargetLabel(props.target);

	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}
		>
			<text
				fg={uiColors.textPrimary}
				attributes={props.isSelected ? TextAttributes.BOLD : undefined}
			>
				{truncate(text(), 120)}
			</text>
		</box>
	);
}

export function ActionTargetPickerView(props: ActionTargetPickerProps) {
	return (
		<ListViewModal
			title={props.title || "Select Target"}
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.72}
			heightPercent={0.45}
			items={props.targets}
			selectedIndex={props.selectedIndex}
			loading={props.loading}
			scrollIndicatorLabel="targets"
			emptyContent={
				<text fg={uiColors.textSecondary}>No targets available</text>
			}
			renderItem={(target, isSelected) => (
				<ActionTargetRow target={target} isSelected={isSelected()} />
			)}
		/>
	);
}
