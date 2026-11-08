/** @jsxImportSource @opentui/solid */
import { For, type JSX, Show } from "solid-js";
import { StructuredData } from "../../ui/StructuredData.tsx";
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
							when={typeof section.value === "string"}
							fallback={
								<StructuredData
									value={section.value}
									label={`Retained ${section.key}`}
								/>
							}
						>
							<text wrapMode="word">
								{typeof section.value === "string" ? section.value : ""}
							</text>
						</Show>
					</Show>
				</>
			)}
		</For>
	);
}
