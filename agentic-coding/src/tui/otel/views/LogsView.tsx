/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { hostBodyLines, SearchHeader, SelectableList, uiColors } from "@ui";
import { createMemo } from "solid-js";
import type { LogStore } from "../model/logStore";

const severityColor = (sev: string) => {
	if (sev === "ERROR" || sev === "FATAL") return uiColors.error;
	if (sev === "WARN") return uiColors.warning;
	if (sev === "INFO") return uiColors.success;
	return uiColors.textMuted;
};

export function LogsView(props: {
	store: LogStore;
	selectedIndex: () => number;
	onSelectIndex: (index: number) => void;
	onOpen: (index: number) => void;
}) {
	const size = useTerminalDimensions();
	const logs = createMemo(() => props.store.getLogs());
	// The view's own search header takes one row above the list.
	const listLines = () => Math.max(1, hostBodyLines(size().height) - 1);

	return (
		<box flexDirection="column" width="100%" height="100%">
			<SearchHeader>
				<text fg={uiColors.textMuted}>({props.store.filteredCount_})</text>
			</SearchHeader>
			{logs().length > 0 && (
				<SelectableList
					items={logs()}
					availableLines={listLines()}
					selectedIndex={props.selectedIndex}
					renderItem={(log) => (
						<box
							height={1}
							flexDirection="row"
							paddingLeft={1}
							paddingRight={1}
						>
							<box width={6} flexShrink={0}>
								<text
									fg={severityColor(log.severity)}
									attributes={TextAttributes.BOLD}
								>
									{log.severity.padEnd(5)}
								</text>
							</box>
							<box width={20} flexShrink={0}>
								<text fg={uiColors.textSecondary}>
									{new Date(
										Number(BigInt(log.timeUnixNano) / 1_000_000n),
									).toLocaleTimeString()}
								</text>
							</box>
							<box width={14} flexShrink={0} overflow="hidden">
								<text fg={uiColors.textMuted}>{log.serviceName}</text>
							</box>
							<box flexGrow={1} overflow="hidden">
								<text fg={uiColors.textPrimary}>{log.body.slice(0, 120)}</text>
							</box>
						</box>
					)}
					onSelect={(index) => {
						props.onSelectIndex(index);
						props.onOpen(index);
					}}
				/>
			)}
			{logs().length === 0 && (
				<box paddingLeft={1}>
					<text fg={uiColors.textMuted}>No logs loaded</text>
				</box>
			)}
		</box>
	);
}
