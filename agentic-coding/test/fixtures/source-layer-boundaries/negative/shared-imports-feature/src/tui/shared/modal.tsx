// Negative fixture: a shared TUI primitive depends on a dashboard feature
// implementation; the reversed edge must fail.
import { MarkdownView } from "../dash/ui/feature.ts";

export function SharedModal(): unknown {
	return MarkdownView;
}