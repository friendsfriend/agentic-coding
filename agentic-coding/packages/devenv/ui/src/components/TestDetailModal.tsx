/** @jsxImportSource @opentui/solid */

import type { TestCase } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import { Badge } from "./Badge";
import { GenericModal } from "./GenericModal";
import { HelpText } from "./HelpText";
import { PropertiesList, type PropertyRow } from "./PropertiesList";
import { SearchHeader } from "./SearchHeader";

interface TestDetailModalProps {
	test: TestCase & { suiteName?: string };
	onClose: () => void;
	/** Called when the user presses 'c' — parent handles clipboard write */
	onCopy?: () => void;
	/** Optional copy feedback text shown transiently (e.g. "Copied!") */
	copyStatus?: string | null;
}

/**
 * TestDetailModal - Overlay showing full detail for a single test case
 *
 * Displays:
 * - Test name, class name, suite name
 * - Status with icon and color
 * - Execution time
 * - system_output (stdout/stderr captured during test run)
 * - stack_trace (failure/error stack trace)
 *
 * Follows the same overlay pattern as DiffViewModal:
 * - Rendered as position:absolute overlay in app-opentui.tsx via <Show>
 * - Keyboard events handled in parent (OpenTUI limitation: one useKeyboard hook)
 * - ESC to close (parent handles the key and sets signal to false)
 */
export function TestDetailModal(props: TestDetailModalProps) {
	const getStatusDisplay = (status: string) => {
		switch (status.toLowerCase()) {
			case "success":
				return { icon: "✓", color: uiColors.success, label: "PASSED" };
			case "failed":
				return { icon: "✗", color: uiColors.error, label: "FAILED" };
			case "error":
				return { icon: "⚠", color: uiColors.error, label: "ERROR" };
			case "skipped":
				return { icon: "○", color: uiColors.textMuted, label: "SKIPPED" };
			default:
				return {
					icon: "?",
					color: uiColors.textSecondary,
					label: status.toUpperCase(),
				};
		}
	};

	const formatTime = (seconds: number) => {
		if (seconds < 1) {
			return `${Math.round(seconds * 1000)}ms`;
		}
		return `${seconds.toFixed(3)}s`;
	};

	const display = () => getStatusDisplay(props.test.status);
	const statusHighlight = () => {
		switch (props.test.status.toLowerCase()) {
			case "success":
				return "positive" as const;
			case "failed":
			case "error":
				return "negative" as const;
			case "skipped":
				return "secondary" as const;
			default:
				return "secondary" as const;
		}
	};
	const isFailed = () =>
		props.test.status === "failed" || props.test.status === "error";

	// The text that would be copied — same logic as what's rendered in the output sections
	const copyableText = createMemo(() => {
		if (isFailed())
			return props.test.stack_trace || props.test.system_output || null;
		return props.test.system_output || null;
	});

	const customHeader = () => (
		<SearchHeader>
			<box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				style={{ width: "100%" }}
			>
				<text fg={uiColors.borderHighlight} attributes={TextAttributes.BOLD}>
					Test Detail
				</text>
				<box flexDirection="row" gap={2} alignItems="center">
					<Show when={props.copyStatus}>
						<text fg={uiColors.success} attributes={TextAttributes.BOLD}>
							{props.copyStatus}
						</text>
					</Show>
					<Badge text={display().label} highlight={statusHighlight()} />
				</box>
			</box>
		</SearchHeader>
	);

	const customFooter = () => (
		<box paddingTop={1} flexShrink={0}>
			<HelpText
				entries={[
					...(copyableText() && props.onCopy
						? [{ key: "c", action: "Copy Output" }]
						: []),
					{ key: "Esc", action: "Close" },
				]}
			/>
		</box>
	);

	const detailRows = (): PropertyRow[] => {
		const rows: PropertyRow[] = [
			{ label: "Test", value: props.test.name, valueHighlight: "primary" },
			{
				label: "Duration",
				value: formatTime(props.test.execution_time),
				valueHighlight: "secondary",
			},
		];
		if (props.test.suiteName)
			rows.push({
				label: "Suite",
				value: props.test.suiteName,
				valueHighlight: "secondary",
			});
		rows.push({
			label: "Class",
			value: props.test.classname,
			valueHighlight: "secondary",
		});
		return rows;
	};

	return (
		<GenericModal
			title=""
			helpText=""
			widthPercent={0.75}
			heightPercent={0.9}
			customHeader={customHeader()}
			customFooter={customFooter()}
			onBackdropClick={props.onClose}
		>
			<box
				style={{
					width: "100%",
					flexDirection: "column",
					flexGrow: 1,
					flexShrink: 1,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				{/* Test Identity Section — compact single-line fields, no border */}
				<box
					style={{
						width: "100%",
						flexDirection: "column",
						flexShrink: 0,
						paddingBottom: 1,
					}}
				>
					<PropertiesList labelWidth={10} rows={detailRows()} />
				</box>

				{/* Stack Trace / Failure Message */}
				<Show
					when={
						isFailed() && (props.test.stack_trace || props.test.system_output)
					}
				>
					<box
						backgroundColor={uiColors.bgMantle}
						style={{
							width: "100%",
							flexDirection: "column",
							flexGrow: 1,
							flexShrink: 1,
							minHeight: 0,
							overflow: "hidden",
							paddingTop: 1,
							paddingBottom: 1,
							paddingLeft: 2,
							paddingRight: 2,
						}}
					>
						<text
							fg={uiColors.error}
							attributes={TextAttributes.BOLD}
							marginBottom={1}
						>
							Failure Details
						</text>
						<box
							style={{
								width: "100%",
								flexGrow: 1,
								flexShrink: 1,
								minHeight: 0,
								overflow: "hidden",
							}}
						>
							<text fg={uiColors.textSecondary}>
								{props.test.stack_trace || props.test.system_output || ""}
							</text>
						</box>
					</box>
				</Show>

				{/* System Output (for non-failure cases) */}
				<Show when={!isFailed() && props.test.system_output}>
					<box
						backgroundColor={uiColors.bgMantle}
						style={{
							width: "100%",
							flexDirection: "column",
							flexGrow: 1,
							flexShrink: 1,
							minHeight: 0,
							overflow: "hidden",
							paddingTop: 1,
							paddingBottom: 1,
							paddingLeft: 2,
							paddingRight: 2,
						}}
					>
						<text
							fg={uiColors.textPrimary}
							attributes={TextAttributes.BOLD}
							marginBottom={1}
						>
							Output
						</text>
						<box
							style={{
								width: "100%",
								flexGrow: 1,
								flexShrink: 1,
								minHeight: 0,
								overflow: "hidden",
							}}
						>
							<text fg={uiColors.textSecondary}>
								{props.test.system_output}
							</text>
						</box>
					</box>
				</Show>

				{/* No extra detail available */}
				<Show when={!props.test.stack_trace && !props.test.system_output}>
					<box style={{ width: "100%", height: 1 }}>
						<text fg={uiColors.textMuted}>
							No additional output available for this test.
						</text>
					</box>
				</Show>
			</box>
		</GenericModal>
	);
}
