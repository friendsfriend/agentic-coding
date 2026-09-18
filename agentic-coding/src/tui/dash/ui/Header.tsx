/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { uiColors } from "@ui";

type DashboardHeaderProps = {
	change: string;
	phase: string;
	branch: string;
	updated: string;
};
/**
 * The dashboard's own branded app header (standalone `--home` mode). The env
 * surface's generic header lives in the framework (`@ui`); this one is the
 * dashboard's chrome, so it stays with the dashboard.
 */
export function Header(props: DashboardHeaderProps) {
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: 2,
				flexDirection: "column",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
					AGENTIC
				</text>
				<text fg={uiColors.textSecondary}> {props.change}</text>
				<box style={{ flexGrow: 1 }} />
				<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
					{props.phase}
				</text>
			</box>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<text fg={uiColors.accent} attributes={TextAttributes.BOLD}>
					CODING
				</text>
				<text fg={uiColors.textMuted}> {props.branch}</text>
				<box style={{ flexGrow: 1 }} />
				<text fg={uiColors.textMuted}>updated {props.updated}</text>
			</box>
		</box>
	);
}
