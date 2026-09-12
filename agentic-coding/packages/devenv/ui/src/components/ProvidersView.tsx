/** @jsxImportSource @opentui/solid */

import type { Provider } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import { uiColors } from "../colors";
import { CenteredState } from "./CenteredState";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";

interface ProvidersViewProps {
	providers: Provider[];
	loading?: boolean;
	error?: string;
	onClose: () => void;
	selectedProviderIndex?: number;
}

export function ProvidersView(props: ProvidersViewProps) {
	const renderSecret = (provider: Provider): string => {
		if (provider.invalid) return "Blocked";
		return provider.has_token ? "••••••••" : "Not configured";
	};

	const getSecretColor = (provider: Provider) => {
		if (provider.invalid) return uiColors.warning;
		return provider.has_token ? uiColors.success : uiColors.error;
	};

	return (
		<GenericModal
			title="Providers"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "a", action: "Add" },
				{ key: "e", action: "Edit" },
				{ key: "d", action: "Delete" },
				{ key: "Esc", action: "Close" },
			])}
			widthPercent={0.65}
			heightPercent={0.55}
			onBackdropClick={props.onClose}
		>
			<Show when={props.loading}>
				<CenteredState
					message="Loading providers..."
					color={uiColors.primary}
				/>
			</Show>

			<Show when={!props.loading && props.error}>
				<CenteredState message={props.error ?? ""} color={uiColors.error} />
			</Show>

			<Show when={!props.loading && !props.error}>
				<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
					<Show when={props.providers.length === 0}>
						<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
							<text fg={uiColors.textMuted}>
								No providers configured. Press 'a' to add one.
							</text>
						</box>
					</Show>

					<Show when={props.providers.some((p) => p.invalid)}>
						<box
							style={{
								width: "100%",
								flexDirection: "column",
								flexShrink: 0,
								marginBottom: 1,
							}}
						>
							<text fg={uiColors.warning} attributes={TextAttributes.BOLD}>
								Provider credentials need migration
							</text>
							<text fg={uiColors.textMuted}>
								Clear-text credentials in provider JSON are blocked. Move
								username/token to .env and use ${"{...}"} placeholders, or edit
								provider here to save secure placeholders.
							</text>
						</box>
					</Show>

					<For each={props.providers}>
						{(provider: Provider, idx) => {
							const isSelected = () =>
								(props.selectedProviderIndex ?? -1) === idx();
							const typeIcon = provider.type === "github" ? "" : "";

							return (
								<box
									style={{
										width: "100%",
										flexDirection: "row",
										height: 1,
										flexShrink: 0,
									}}
									backgroundColor={
										isSelected() ? uiColors.bgSurface2 : undefined
									}
								>
									<text
										fg={isSelected() ? uiColors.primary : uiColors.textMuted}
									></text>
									<text
										fg={isSelected() ? uiColors.primary : uiColors.textPrimary}
										attributes={isSelected() ? TextAttributes.BOLD : undefined}
									>
										{provider.name}
									</text>
									<text fg={uiColors.textMuted}> {typeIcon}</text>
									<text
										fg={
											provider.invalid ? uiColors.warning : uiColors.textMuted
										}
									>
										{" "}
										{provider.invalid
											? "Invalid"
											: provider.username || "(no user)"}
									</text>
									<Show when={provider.invalid}>
										<text fg={uiColors.textMuted}> (blocked)</text>
									</Show>
									<box style={{ marginLeft: "auto" }}>
										<text
											fg={getSecretColor(provider)}
											attributes={TextAttributes.BOLD}
										>
											{renderSecret(provider)}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</box>
			</Show>
		</GenericModal>
	);
}
