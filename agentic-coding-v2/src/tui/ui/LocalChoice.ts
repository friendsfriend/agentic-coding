import { createContext } from "solid-js";
import type { ReadOnlyChoiceRow } from "../presentation/components/ReadOnlyChoicePicker.tsx";
/** Ephemeral read-only picker request. Callbacks may navigate or edit local drafts;
 * they never submit a boundary, grant authority or populate an approval. */
export const LocalChoiceContext = createContext<{
	choose: (choice: LocalChoice) => void;
	interactive: () => boolean;
	scope: () => unknown;
}>();
export type LocalChoice = {
	title: string;
	rows: readonly ReadOnlyChoiceRow[];
	initialKey?: string;
	note: string;
	valid: () => boolean;
	choose: (key: string) => boolean;
};
