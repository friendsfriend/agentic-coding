import type { BoxRenderable } from "@opentui/core";
import { createContext } from "solid-js";

/** Local rendered reading anchors only. No native identity, history access,
 * task adoption, viewport mutation or persisted renderer references. */
export const TranscriptRowsContext = createContext<{
	selectable: (key: string) => boolean;
	activate: (key: string, suffix?: string) => void;
	register: (key: string, node: BoxRenderable) => () => void;
	reveal: (key: string, node: BoxRenderable) => void;
}>();
