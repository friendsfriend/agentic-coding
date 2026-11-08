/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ImageView } from "../../ui/ImageView.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

/** Passive retained part carriers. Display ordinals never become tool, task,
 * evidence or browser identities. No concatenation, decoding or dispatch here. */
export function ToolContentParts(props: {
	parts: readonly Data[];
	scope: unknown;
	interactive?: boolean;
	imagesOnly?: boolean;
}) {
	const rows = createMemo(() =>
		props.parts
			.map((part, index) => ({ part, index }))
			.filter(({ part }) => !props.imagesOnly || part.type === "image"),
	);
	return (
		<Show when={rows().length > 0}>
			<SuppliedRecordWindow
				interactive={props.interactive}
				rows={rows()}
				scope={props.scope}
				label={
					props.imagesOnly
						? "retained image previews"
						: "retained native content parts"
				}
				title={({ part, index }) =>
					`Part ${index + 1} · ${String(part.type ?? "type not supplied")}`
				}
				search={({ part }) => JSON.stringify(part)}
			>
				{({ part, index }) => (
					<box flexDirection="column" gap={1}>
						<text fg={color("textMuted")}>
							Retained part {index + 1} ·{" "}
							{Array.from(
								String(part.type ?? "type not supplied").replace(/\s+/g, " "),
							)
								.slice(0, 80)
								.join("")}{" "}
							· display carrier only
						</text>
						<Show
							when={props.imagesOnly}
							fallback={
								<>
									<Show
										when={part.type === "text" && typeof part.text === "string"}
									>
										<SuppliedObservation
											interactive={props.interactive}
											value={part.text}
											scope={props.scope}
											label="Exact supplied text part; no inserted separator or inferred completion"
										/>
									</Show>
									<SuppliedObservation
										interactive={props.interactive}
										value={part}
										scope={props.scope}
										label="Complete supplied part fields; serialized JSON, not original bytes or authority"
									/>
								</>
							}
						>
							<ImageView
								content={part.data}
								mediaType={part.mimeType}
								caption="Retained native tool image"
							/>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
		</Show>
	);
}
