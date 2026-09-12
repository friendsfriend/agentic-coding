import { Badge, formatHelpText, GenericModal, uiColors } from "@devenv/ui";
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import type { AppStore, ProviderStore } from "../stores";

export function FirstStepsView(props: {
	appStore: AppStore;
	providerStore: ProviderStore;
}) {
	const hasProvider = () =>
		props.providerStore.providers().some((p) => !p.invalid);
	const hasResources = () =>
		props.appStore.apps().length > 0 ||
		props.appStore.infraServices().length > 0 ||
		props.appStore.scriptVisibleRows().length > 0;
	const selected = (idx: number) =>
		props.appStore.firstStepsSelectedIndex() === idx;
	const rowBg = (idx: number) =>
		selected(idx) ? uiColors.bgSurface2 : undefined;

	return (
		<GenericModal
			title="Welcome to DevEnv"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Close" },
			])}
			widthPercent={0.65}
			heightPercent={0.6}
		>
			<text fg={uiColors.textPrimary}>Thank you for using DevEnv.</text>
			<text fg={uiColors.textSecondary}>
				Complete these steps to get started.
			</text>

			<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

			{/* Step 1: Connect Provider */}
			<box
				backgroundColor={rowBg(0)}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				<Show
					when={hasProvider()}
					fallback={<text fg={uiColors.textMuted}>1.</text>}
				>
					<Badge text="✓" highlight="positive" />
				</Show>
				<box style={{ width: 2, flexShrink: 0 }} />
				<text
					fg={
						selected(0)
							? uiColors.textPrimary
							: hasProvider()
								? uiColors.success
								: uiColors.textPrimary
					}
					attributes={TextAttributes.BOLD}
				>
					Connect a git provider
				</text>
				<Show when={hasProvider()}>
					<text fg={uiColors.textMuted}> done</text>
				</Show>
			</box>

			{/* Step 2: Add repository or alternatives */}
			<box
				backgroundColor={rowBg(1)}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				<Show
					when={hasResources()}
					fallback={
						<text
							fg={!hasProvider() ? uiColors.textSecondary : uiColors.textMuted}
						>
							2.
						</text>
					}
				>
					<Badge text="✓" highlight="positive" />
				</Show>
				<box style={{ width: 2, flexShrink: 0 }} />
				<text
					fg={
						!hasProvider()
							? uiColors.textSecondary
							: selected(1)
								? uiColors.textPrimary
								: uiColors.textPrimary
					}
					attributes={selected(1) ? TextAttributes.BOLD : undefined}
				>
					Add repository
				</text>
			</box>

			{/* Step 2a: Load examples */}
			<box
				backgroundColor={rowBg(2)}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 4,
					paddingRight: 1,
				}}
			>
				<text fg={uiColors.textMuted}>— or —</text>
				<box style={{ width: 1, flexShrink: 0 }} />
				<text
					fg={
						!hasProvider()
							? uiColors.textTertiary
							: selected(2)
								? uiColors.textPrimary
								: uiColors.textSecondary
					}
					attributes={selected(2) ? TextAttributes.BOLD : undefined}
				>
					Load examples
				</text>
			</box>

			{/* Step 2b: Config repo guide */}
			<box
				backgroundColor={rowBg(3)}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 4,
					paddingRight: 1,
				}}
			>
				<text fg={uiColors.textMuted}>— or —</text>
				<box style={{ width: 1, flexShrink: 0 }} />
				<text
					fg={
						!hasProvider()
							? uiColors.textTertiary
							: selected(3)
								? uiColors.textPrimary
								: uiColors.textSecondary
					}
					attributes={selected(3) ? TextAttributes.BOLD : undefined}
				>
					View config repo guide
				</text>
			</box>

			<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

			{/* Step 3: Help */}
			<box
				backgroundColor={rowBg(4)}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				<text fg={uiColors.textMuted}>?</text>
				<box style={{ width: 2, flexShrink: 0 }} />
				<text
					fg={selected(4) ? uiColors.textPrimary : uiColors.textSecondary}
					attributes={selected(4) ? TextAttributes.BOLD : undefined}
				>
					Help
				</text>
			</box>

			<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

			{/* Status messages */}
			<Show when={props.appStore.exampleConfigMessage()}>
				<text
					fg={
						props.appStore.exampleConfigLoading()
							? uiColors.warning
							: uiColors.textSecondary
					}
				>
					{props.appStore.exampleConfigMessage()}
				</text>
			</Show>
			<Show when={props.providerStore.providersError()}>
				<text fg={uiColors.error}>{props.providerStore.providersError()}</text>
			</Show>
			<Show
				when={
					!props.providerStore.providersError() &&
					props.providerStore.providers().some((p) => p.invalid)
				}
			>
				<text fg={uiColors.warning}>
					Provider(s) blocked: clear-text credentials in provider JSON. Press c
					to open Providers and edit.
				</text>
			</Show>
		</GenericModal>
	);
}
