import { color } from "../../ui/theme/index.ts";

// Only the theme source is adapted; original semantic palette and components
// stay presentation-only and never load legacy settings or runtime services.
export function themeColor(key: string, _fallback: string): string {
	return color(key);
}
