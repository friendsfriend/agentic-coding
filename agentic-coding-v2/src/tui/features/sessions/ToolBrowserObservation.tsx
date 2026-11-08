/** @jsxImportSource @opentui/solid */
import { For, type JSX, Show } from "solid-js";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";

/** Passive display values. Recorded refs never become actionable UI targets. */
export type SuppliedBrowserSection = {
	readonly key: "observation" | "matches";
	readonly value: unknown;
};

/** Projection and native result ownership remain with the card. No layout
 * wrapper, ref resolver, browser action or event listener is introduced. */
export function ToolBrowserObservation(props: {
	sections: readonly SuppliedBrowserSection[];
	scope: unknown;
	interactive?: boolean;
	open: (suffix: string) => boolean;
	fold: (suffix: string, label: string) => JSX.Element;
}) {
	return (
		<For each={props.sections}>
			{(section) => (
				<>
					{props.fold(
						`:${section.key}`,
						section.key === "matches" ? "Matches" : "Observation",
					)}
					<Show when={props.open(`:${section.key}`)}>
						<text fg={color("textMuted")} wrapMode="word">
							Retained browser {section.key} — refs belong to the recorded
							snapshot; this display does not resolve or activate them.
						</text>
						<Show
							when={section.value !== null && typeof section.value === "object"}
						>
							<StructuredData
								interactive={props.interactive}
								scope={props.scope}
								value={section.value}
								label={`Retained ${section.key} · bounded field summary`}
							/>
						</Show>
						<SuppliedObservation
							interactive={props.interactive}
							value={section.value}
							scope={props.scope}
							label={`Complete supplied browser ${section.key}; serialized fields are not original response bytes`}
						/>
					</Show>
				</>
			)}
		</For>
	);
}
