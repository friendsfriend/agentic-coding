/** @jsxImportSource @opentui/solid */

import type { ProviderType } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { PropertiesList, propertyBadges } from "./PropertiesList";

export type ConnectProviderStep =
	| "selectProvider"
	| "name"
	| "username"
	| "token";

export interface ConnectProviderModalProps {
	step: ConnectProviderStep;
	provider: ProviderType | null;
	selectedProviderIndex: number;
	nameText: string;
	usernameText: string;
	tokenText: string;
	error: string | null;
	success: string | null;
	editMode: boolean;
}

export function ConnectProviderModal(props: ConnectProviderModalProps) {
	const masked = () => "*".repeat(props.tokenText.length);
	const hasName = () => props.nameText.length > 0;
	const hasUsername = () => props.usernameText.length > 0;
	const hasToken = () => props.tokenText.length > 0;

	const providerLabel = () => {
		if (props.provider === "github") return "GitHub";
		if (props.provider === "gitlab") return "GitLab";
		return "";
	};

	const title = () => {
		const prefix = props.editMode ? "Edit Provider" : "Add Provider";
		if (props.step === "selectProvider") return prefix;
		if (props.step === "name") return `${prefix} — Name`;
		if (props.step === "username") return `${prefix} — Username`;
		return `${prefix} — Token`;
	};

	const helpText = () => {
		if (props.step === "selectProvider") {
			return formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Cancel" },
			]);
		}
		if (props.step === "name") {
			return formatHelpText([
				{ key: "Enter", action: "Next" },
				{ key: "Esc", action: "Back" },
			]);
		}
		if (props.step === "username") {
			return formatHelpText([
				{ key: "Enter", action: "Next" },
				{ key: "Esc", action: "Back" },
			]);
		}
		return formatHelpText([
			{ key: "Enter", action: "Save" },
			{ key: "Esc", action: "Back" },
		]);
	};

	const providers: ProviderType[] = ["github", "gitlab"];

	return (
		<GenericModal
			title={title()}
			helpText={helpText()}
			widthPercent={0.4}
			heightPercent={0.45}
		>
			{/* Step 1: Select provider type */}
			<Show when={props.step === "selectProvider"}>
				<box style={{ width: "100%", flexDirection: "column" }}>
					<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
						<text fg={uiColors.textMuted}>Select a git provider:</text>
					</box>
					<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

					{providers.map((p, idx) => {
						const isSelected = () => props.selectedProviderIndex === idx;
						const label = p === "github" ? "GitHub" : "GitLab";

						return (
							<box
								style={{
									width: "100%",
									height: 1,
									flexDirection: "row",
									flexShrink: 0,
								}}
							>
								<text
									fg={isSelected() ? uiColors.primary : uiColors.textMuted}
								></text>
								<text
									fg={isSelected() ? uiColors.primary : uiColors.textPrimary}
									attributes={isSelected() ? TextAttributes.BOLD : undefined}
								>
									{label}
								</text>
							</box>
						);
					})}
				</box>
			</Show>

			{/* Step 2: Provider name */}
			<Show when={props.step === "name"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{ label: providerLabel(), highlight: "highlight" },
							]),
						},
					]}
				/>

				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
						marginBottom: 1,
					}}
				>
					<text fg={uiColors.textMuted}>{"Name:     "}</text>
					<text
						fg={hasName() ? uiColors.textPrimary : uiColors.textMuted}
						attributes={hasName() ? TextAttributes.BOLD : undefined}
					>
						{hasName() ? props.nameText : "e.g. my-gitlab-work"}
					</text>
					{hasName() && <text fg={uiColors.primary}>{"█"}</text>}
				</box>
			</Show>

			{/* Step 3: Username input */}
			<Show when={props.step === "username"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{ label: providerLabel(), highlight: "highlight" },
							]),
						},
						{
							label: "Name",
							value: props.nameText,
							valueHighlight: "secondary",
						},
					]}
				/>

				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
						marginBottom: 1,
					}}
				>
					<text fg={uiColors.textMuted}>{"Username: "}</text>
					<text
						fg={hasUsername() ? uiColors.textPrimary : uiColors.textMuted}
						attributes={hasUsername() ? TextAttributes.BOLD : undefined}
					>
						{hasUsername() ? props.usernameText : "enter username..."}
					</text>
					{hasUsername() && <text fg={uiColors.primary}>{"█"}</text>}
				</box>
			</Show>

			{/* Step 4: Token input (masked) */}
			<Show when={props.step === "token"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{ label: providerLabel(), highlight: "highlight" },
							]),
						},
						{
							label: "Name",
							value: props.nameText,
							valueHighlight: "secondary",
						},
						{
							label: "Username",
							value: props.usernameText,
							valueHighlight: "secondary",
						},
					]}
				/>

				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
						marginBottom: 1,
					}}
				>
					<text fg={uiColors.textMuted}>{"Token:    "}</text>
					<text
						fg={hasToken() ? uiColors.textPrimary : uiColors.textMuted}
						attributes={hasToken() ? TextAttributes.BOLD : undefined}
					>
						{hasToken()
							? masked()
							: props.editMode
								? "leave empty to keep current"
								: "enter private token..."}
					</text>
					{hasToken() && <text fg={uiColors.primary}>{"█"}</text>}
				</box>
			</Show>

			<Show when={props.error}>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
					<text fg={uiColors.error}>{props.error ?? ""}</text>
				</box>
			</Show>

			<Show when={props.success}>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
					<text fg={uiColors.success}>{props.success ?? ""}</text>
				</box>
			</Show>
		</GenericModal>
	);
}
