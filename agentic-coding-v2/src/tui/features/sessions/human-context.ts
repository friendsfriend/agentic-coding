import type { BoxRenderable } from "@opentui/core";
import { createContext } from "solid-js";
import type { Review } from "../../../state.ts";
import type { ClientConnection } from "../../client/connection.ts";
import type { Keybind } from "../../ui/keybinds.ts";
export const HumanContext = createContext<{
	requests: () => Review[];
	client: ClientConnection;
	fresh: () => boolean;
	active: () => string | null;
	focus: (id: string | null) => void;
	register: (id: string, node: BoxRenderable) => () => void;
	reveal?: (node: BoxRenderable) => void;
	catalog: (catalog: Keybind[]) => void;
}>();
