/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Progress } from "../../../protocol/index.ts";
import { color } from "../../ui/theme/index.ts";

/** Like v1's queued notices: current native inbox only, not transcript entries.
 * Delivery removes the notice; reconnect reads the host's queue, not local drafts. */
export function QueuedInputs(props: { items: Progress["inbox"] }) {
	return (
		<Show when={props.items.length > 0}>
			<box flexDirection="column" gap={1}>
				<For each={props.items}>
					{(item) => (
						<box
							flexDirection="column"
							paddingLeft={2}
							borderStyle="single"
							border={["left"]}
							borderColor={color("warning")}
						>
							<text fg={color("warning")} wrapMode="word">
								Queued{" "}
								{item.mode === "steer"
									? "steering"
									: item.mode === "followUp"
										? "follow-up"
										: "write"}{" "}
								· #{item.id}
							</text>
							<text fg={color("textMuted")} wrapMode="word">
								{item.content ?? "Message preview unavailable"}
								{item.truncated
									? "… (preview shortened; full message remains queued)"
									: ""}
							</text>
						</box>
					)}
				</For>
			</box>
		</Show>
	);
}
