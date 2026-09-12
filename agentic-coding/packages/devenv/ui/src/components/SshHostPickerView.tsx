/** @jsxImportSource @opentui/solid */

import type { SshHost } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";
import { ListViewModal } from "./ListViewModal";
import { MatchedText } from "./MatchedText";

export interface SshHostPickerViewProps {
	hosts: SshHost[];
	selectedIndex: number;
	searchQuery?: string;
	filterQuery?: string;
	filterActive?: boolean;
	onFilterChange?: (query: string) => void;
}

// ─── Host row ─────────────────────────────────────────────────────────────────

function HostRow(props: {
	host: SshHost;
	isSelected: boolean;
	query?: string;
}) {
	const target = () => {
		const h = props.host;
		const user = h.user ? `${h.user}@` : "";
		const host = h.hostname || h.alias;
		const port = h.port && h.port !== 22 ? `:${h.port}` : "";
		return `${user}${host}${port}`;
	};

	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{
				width: "100%",
				height: 1,
				flexDirection: "row",
				flexShrink: 0,
				paddingLeft: 1,
			}}
		>
			<box style={{ flexShrink: 0 }}>
				<MatchedText
					text={props.host.alias}
					query={props.query}
					fg={props.isSelected ? uiColors.textPrimary : uiColors.textSecondary}
					attributes={props.isSelected ? TextAttributes.BOLD : undefined}
				/>
			</box>
			<MatchedText
				text={target()}
				query={props.query}
				fg={highlightColor("secondary")}
			/>
		</box>
	);
}

// ─── Main component ────────────────────────────────────────────────────────────

const HEIGHT_PERCENT = 0.7;
const WIDTH_PERCENT = 0.6;

export function SshHostPickerView(props: SshHostPickerViewProps) {
	const searchQuery = () => props.searchQuery ?? "";

	const filteredHosts = createMemo(() => {
		const q = searchQuery().toLowerCase();
		if (!q) return props.hosts;
		return props.hosts.filter(
			(h) =>
				h.alias.toLowerCase().includes(q) ||
				(h.hostname ?? "").toLowerCase().includes(q) ||
				(h.user ?? "").toLowerCase().includes(q),
		);
	});

	const clampedIndex = createMemo(() =>
		Math.max(0, Math.min(props.selectedIndex, filteredHosts().length - 1)),
	);

	return (
		<ListViewModal
			title="SSH Hosts"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "/", action: "Filter" },
				{ key: "Enter", action: "Connect" },
				{ key: "Esc", action: "Close" },
			])}
			widthPercent={WIDTH_PERCENT}
			heightPercent={HEIGHT_PERCENT}
			items={filteredHosts()}
			selectedIndex={clampedIndex()}
			filterPlaceholder="filter hosts..."
			scrollIndicatorLabel="hosts"
			filterQuery={props.filterQuery}
			filterActive={props.filterActive}
			onFilterChange={props.onFilterChange}
			emptyContent={
				<Show
					when={props.hosts.length === 0}
					fallback={
						<text fg={highlightColor("secondary")}>No hosts match filter</text>
					}
				>
					<text fg={highlightColor("secondary")}>
						No hosts found in ~/.ssh/config
					</text>
				</Show>
			}
			renderItem={(host, isSelected) => (
				<HostRow host={host} isSelected={isSelected()} query={searchQuery()} />
			)}
		/>
	);
}
