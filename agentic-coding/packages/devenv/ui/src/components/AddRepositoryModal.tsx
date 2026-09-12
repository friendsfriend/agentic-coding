/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { MatchedText } from "./MatchedText";
import { PropertiesList, propertyBadges } from "./PropertiesList";

export type AddRepositoryStep =
	| "selectProvider"
	| "selectDestination"
	| "findRepo"
	| "repositoryName"
	| "selectBranch"
	| "confirm";
export type FindRepoMode = "selectMode" | "search" | "url";

export interface AddRepositoryModalProps {
	step: AddRepositoryStep;
	providers: Array<{ name: string; type: string }>;
	selectedProviderIndex: number;
	destinationType: "APP" | "LIB";
	destinationTypeIndex: number;
	searchQuery: string;
	searchResults: Array<{
		name: string;
		fullPath: string;
		url: string;
		defaultBranch: string;
	}>;
	selectedResultIndex: number;
	manualUrl: string;
	findRepoMode: FindRepoMode;
	findRepoModeIndex: number;
	repositoryName: string;
	branches: string[];
	selectedBranchIndex: number;
	branchFilterQuery: string;
	loading: boolean;
	error: string | null;
}

export function AddRepositoryModal(props: AddRepositoryModalProps) {
	const selectedProvider = () => props.providers[props.selectedProviderIndex];
	const selectedRepo = () => props.searchResults[props.selectedResultIndex];
	const repoUrl = () =>
		props.findRepoMode === "url"
			? props.manualUrl
			: (selectedRepo()?.url ?? "");
	const filteredBranches = () =>
		props.branches.filter((b) =>
			b.toLowerCase().includes(props.branchFilterQuery.toLowerCase()),
		);
	const hasSearchQuery = () => props.searchQuery.length > 0;
	const hasManualUrl = () => props.manualUrl.length > 0;
	const hasRepositoryName = () => props.repositoryName.length > 0;
	const hasBranchFilter = () => props.branchFilterQuery.length > 0;
	const destinationLabel = () =>
		props.destinationType === "APP" ? "Applications" : "Libraries";
	const itemLabel = () =>
		props.destinationType === "APP" ? "Application" : "Library";
	const selectedBranch = () =>
		filteredBranches()[props.selectedBranchIndex] ?? "";

	const title = () => {
		if (props.step === "selectProvider") return "Add Repository";
		if (props.step === "selectDestination")
			return "Add Repository — Destination";
		if (props.step === "findRepo") return "Add Repository — Source";
		if (props.step === "repositoryName") return "Add Repository — Name";
		if (props.step === "selectBranch") return "Add Repository — Branch";
		return "Add Repository — Confirm";
	};

	const helpText = () => {
		if (props.step === "selectProvider") {
			return formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Cancel" },
			]);
		}
		if (props.step === "selectDestination") {
			return formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Back" },
			]);
		}
		if (props.step === "findRepo") {
			if (props.findRepoMode === "selectMode") {
				return formatHelpText([
					{ key: "j/k", action: "Navigate" },
					{ key: "Enter", action: "Select" },
					{ key: "Esc", action: "Back" },
				]);
			}
			if (props.findRepoMode === "search") {
				return formatHelpText([
					{ key: "j/k", action: "Navigate Results" },
					{ key: "Enter", action: "Search/Select" },
					{ key: "Esc", action: "Back" },
				]);
			}
			return formatHelpText([
				{ key: "Enter", action: "Next" },
				{ key: "Esc", action: "Back" },
			]);
		}
		if (props.step === "repositoryName") {
			return formatHelpText([
				{ key: "Type", action: "Edit Name" },
				{ key: "Enter", action: "Next" },
				{ key: "Esc", action: "Back" },
			]);
		}
		if (props.step === "selectBranch") {
			return formatHelpText([
				{ key: "Type", action: "Filter Branches" },
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Next" },
				{ key: "Esc", action: "Back" },
			]);
		}
		return formatHelpText([
			{ key: "Enter", action: "Create" },
			{ key: "Esc", action: "Back" },
		]);
	};

	return (
		<GenericModal
			title={title()}
			helpText={helpText()}
			widthPercent={0.5}
			heightPercent={0.6}
		>
			<Show when={props.step === "selectProvider"}>
				<box
					style={{ width: "100%", height: 1, flexShrink: 0, marginBottom: 1 }}
				>
					<text fg={uiColors.textMuted}>Select a provider:</text>
				</box>

				{props.providers.map((provider, idx) => {
					const isSelected = () => props.selectedProviderIndex === idx;
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
								{provider.name} ({provider.type})
							</text>
						</box>
					);
				})}
			</Show>

			<Show when={props.step === "selectDestination"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{
									label: selectedProvider()?.name ?? "",
									highlight: "highlight",
								},
							]),
						},
					]}
				/>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				<box
					style={{ width: "100%", height: 1, flexShrink: 0, marginBottom: 1 }}
				>
					<text fg={uiColors.textMuted}>Select destination:</text>
				</box>

				{(["Application", "Library"] as const).map((label, idx) => {
					const isSelected = () => props.destinationTypeIndex === idx;
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
			</Show>

			<Show when={props.step === "findRepo"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{
									label: selectedProvider()?.name ?? "",
									highlight: "highlight",
								},
							]),
						},
					]}
				/>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				<Show when={props.findRepoMode === "selectMode"}>
					<box
						style={{ width: "100%", height: 1, flexShrink: 0, marginBottom: 1 }}
					>
						<text fg={uiColors.textMuted}>Select a source:</text>
					</box>

					{(["Repository Search", "URL"] as const).map((label, idx) => {
						const isSelected = () => props.findRepoModeIndex === idx;
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
				</Show>

				<Show when={props.findRepoMode === "search"}>
					<box
						style={{
							width: "100%",
							height: 1,
							flexDirection: "row",
							flexShrink: 0,
							marginBottom: 1,
						}}
					>
						<text fg={uiColors.textMuted}>{"Search: "}</text>
						<text
							fg={hasSearchQuery() ? uiColors.textPrimary : uiColors.textMuted}
							attributes={hasSearchQuery() ? TextAttributes.BOLD : undefined}
						>
							{hasSearchQuery()
								? props.searchQuery
								: "enter repository query..."}
						</text>
						{hasSearchQuery() && <text fg={uiColors.primary}>{"█"}</text>}
					</box>

					{props.searchResults.map((result, idx) => {
						const isSelected = () => props.selectedResultIndex === idx;
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
								<MatchedText
									text={result.fullPath}
									query={props.searchQuery}
									fg={isSelected() ? uiColors.primary : uiColors.textSecondary}
									attributes={isSelected() ? TextAttributes.BOLD : undefined}
								/>
							</box>
						);
					})}
				</Show>

				<Show when={props.findRepoMode === "url"}>
					<box
						style={{
							width: "100%",
							height: 1,
							flexDirection: "row",
							flexShrink: 0,
							marginBottom: 1,
						}}
					>
						<text fg={uiColors.textMuted}>{"URL:    "}</text>
						<text
							fg={hasManualUrl() ? uiColors.textPrimary : uiColors.textMuted}
							attributes={hasManualUrl() ? TextAttributes.BOLD : undefined}
						>
							{hasManualUrl() ? props.manualUrl : "enter repository url..."}
						</text>
						{hasManualUrl() && <text fg={uiColors.primary}>{"█"}</text>}
					</box>
				</Show>
			</Show>

			<Show when={props.step === "repositoryName"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{
									label: selectedProvider()?.name ?? "",
									highlight: "highlight",
								},
							]),
						},
						{ label: "Repo", value: repoUrl(), valueHighlight: "secondary" },
					]}
				/>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
						marginBottom: 1,
					}}
				>
					<text fg={uiColors.textMuted}>{"Name: "}</text>
					<text
						fg={hasRepositoryName() ? uiColors.textPrimary : uiColors.textMuted}
						attributes={hasRepositoryName() ? TextAttributes.BOLD : undefined}
					>
						{hasRepositoryName()
							? props.repositoryName
							: "enter repository name..."}
					</text>
					{hasRepositoryName() && <text fg={uiColors.primary}>{"█"}</text>}
				</box>
			</Show>

			<Show when={props.step === "selectBranch"}>
				<PropertiesList
					labelWidth={10}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{
									label: selectedProvider()?.name ?? "",
									highlight: "highlight",
								},
							]),
						},
						{ label: "Repo", value: repoUrl(), valueHighlight: "secondary" },
						{ label: "Name", value: props.repositoryName },
					]}
				/>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
						marginBottom: 1,
					}}
				>
					<text fg={uiColors.textMuted}>{"Filter: "}</text>
					<text
						fg={hasBranchFilter() ? uiColors.textPrimary : uiColors.textMuted}
						attributes={hasBranchFilter() ? TextAttributes.BOLD : undefined}
					>
						{hasBranchFilter()
							? props.branchFilterQuery
							: "type to filter branches..."}
					</text>
					{hasBranchFilter() && <text fg={uiColors.primary}>{"█"}</text>}
				</box>

				{filteredBranches().map((branch, idx) => {
					const isSelected = () => props.selectedBranchIndex === idx;
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
							<MatchedText
								text={branch}
								query={props.branchFilterQuery}
								fg={isSelected() ? uiColors.primary : uiColors.textPrimary}
								attributes={isSelected() ? TextAttributes.BOLD : undefined}
							/>
						</box>
					);
				})}
			</Show>

			<Show when={props.step === "confirm"}>
				<PropertiesList
					labelWidth={12}
					rows={[
						{
							label: "Provider",
							value: propertyBadges([
								{
									label: selectedProvider()?.name ?? "",
									highlight: "highlight",
								},
							]),
						},
						{
							label: "Destination",
							value: propertyBadges([
								{ label: destinationLabel(), highlight: "highlight" },
							]),
						},
						{
							label: "Repository",
							value: repoUrl(),
							valueHighlight: "secondary",
						},
						{ label: `${itemLabel()} Name`, value: props.repositoryName },
						{ label: "Branch", value: selectedBranch() },
					]}
				/>

				<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
					<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
						Press Enter to create repository entry
					</text>
				</box>
			</Show>

			<Show when={props.loading}>
				<box style={{ width: "100%", height: 1, flexShrink: 0, marginTop: 1 }}>
					<text fg={uiColors.primary}>Loading...</text>
				</box>
			</Show>

			<Show when={props.error}>
				<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
					<text fg={uiColors.error}>{props.error ?? ""}</text>
				</box>
			</Show>
		</GenericModal>
	);
}
