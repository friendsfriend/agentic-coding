import theme from "./catppuccin.json";

// Original theme asset, resolved locally; no legacy settings/runtime imports.
const definitions: Partial<Record<string, string>> = theme.defs;
const tokens: Partial<
	Record<string, string | { dark: string; light: string }>
> = theme.theme;
export function color(
	key: string,
	light = false,
	seen = new Set<string>(),
): string {
	if (key.startsWith("#")) return key;
	if (seen.has(key)) return light ? "#4c4f69" : "#cdd6f4";
	seen.add(key);
	const token = definitions[key] ?? tokens[key];
	return token === undefined
		? color("text", light, seen)
		: color(
				typeof token === "string" ? token : light ? token.light : token.dark,
				light,
				seen,
			);
}
