/** @jsxImportSource @opentui/solid */

import { useRenderer } from "@opentui/solid";
import { createMemo, For } from "solid-js";
import { createSessionMermaidRenderer } from "../mermaid/renderer.ts";
import { uiColors } from "../theme/colors.ts";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import {
	type MarkdownBlockPart,
	streamingTailSource,
} from "./markdownBlocks.ts";
import { createKeyedItems } from "./utils/keyedItems.ts";

/** Original live prose holdback: presentation only. The complete supplied text
 * remains in the cache; this never alters a retained/native message. */
function holdBackTrailingLine(source: string): string {
	const lastBreak = source.lastIndexOf("\n");
	if (lastBreak <= 0) return source;
	const previousBreak = source.lastIndexOf("\n", lastBreak - 1);
	if (previousBreak < 0) return source;
	return source.slice(0, previousBreak).replace(/\s+$/, "");
}

/** Original assistant top-level markdown flow. Settled parts retain identity;
 * a growing tail updates its mounted renderer until its code/prose shape changes.
 * Mermaid fences use the vendored original terminal renderer, scoped to this
 * message's Markdown renderable. Nothing is fetched or executed: an unparsable,
 * oversized or unsupported fence stays ordinary readable source. */
export function AssistantMarkdown(props: {
	transcript: (key: string, text: string) => readonly MarkdownBlockPart[];
	partKey: string;
	text: string;
	live?: boolean;
	fg?: string;
}) {
	const parts = createMemo(() => props.transcript(props.partKey, props.text));
	const slots = createKeyedItems(parts, (part, index) =>
		JSON.stringify([props.partKey, index, part.code]),
	);
	const mermaid = createSessionMermaidRenderer(useRenderer());
	return (
		<box flexDirection="column">
			<For each={slots()}>
				{(slot, index) => {
					const part = slot.value;
					return (
						<MarkdownViewer
							renderNode={mermaid}
							content={(() => {
								if (index() !== parts().length - 1)
									return part().source.replace(/\s+$/, "");
								if (
									part().code &&
									/^ {0,3}(?:`{3,}|~{3,})[\t ]*mermaid\b/i.test(part().source)
								)
									return part().source;
								const source = streamingTailSource(part());
								return props.live === true
									? holdBackTrailingLine(source)
									: source;
							})()}
							fg={props.fg ?? uiColors.textPrimary}
							streaming={part().code ? props.live === true : true}
							{...(index() > 0 ? { marginTop: 1 } : {})}
						/>
					);
				}}
			</For>
		</box>
	);
}
