import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { Theme } from "../opencode-types.ts";

const cache = new WeakMap<object, Map<Theme, SyntaxStyle>>();

function createSyntaxStyle(theme: Theme, owner: object) {
	const ownerCache = cache.get(owner);
	const cached = ownerCache?.get(theme);
	if (cached) return cached;
	const create = SyntaxStyle.fromStyles as unknown as (
		styles: Record<string, unknown>,
		owner?: object,
	) => SyntaxStyle;
	const style = create(
		{
			default: { fg: theme.text.base },
			"markup.heading": { fg: theme.text.feedback.info.base, bold: true },
			"markup.heading.1": { fg: theme.text.feedback.info.base, bold: true },
			"markup.heading.2": { fg: theme.text.feedback.info.base, bold: true },
			"markup.heading.3": { fg: theme.text.feedback.info.base, bold: true },
			"markup.bold": { fg: theme.text.action.primary.base, bold: true },
			"markup.strong": { fg: theme.text.action.primary.base, bold: true },
			"markup.italic": { fg: theme.text.feedback.warning.base, italic: true },
			"markup.emph": { fg: theme.text.feedback.warning.base, italic: true },
			"markup.list": { fg: theme.text.muted },
			"markup.quote": { fg: theme.text.feedback.info.muted, italic: true },
			"markup.raw": { fg: theme.text.feedback.success.base },
			"markup.raw.inline": { fg: theme.text.feedback.success.base },
			"markup.raw.block": { fg: theme.text.feedback.success.base },
			"markup.link": { fg: theme.text.feedback.info.base, underline: true },
			"markup.link.url": { fg: theme.text.feedback.info.base, underline: true },
			"markup.link.label": {
				fg: theme.text.action.primary.base,
				underline: true,
			},
			"markup.thematic_break": { fg: theme.text.muted },
			"markup.inserted": { fg: theme.text.feedback.success.base },
			"markup.deleted": { fg: theme.text.feedback.error.base },
			"markup.changed": { fg: theme.text.feedback.warning.base },
			keyword: { fg: theme.text.feedback.info.base, bold: true },
			string: { fg: theme.text.feedback.success.base },
			comment: { fg: theme.text.muted, italic: true },
			number: { fg: theme.text.feedback.warning.base },
			constant: { fg: theme.text.feedback.warning.base },
			constructor: { fg: theme.text.action.primary.base },
			function: { fg: theme.text.feedback.info.base },
			variable: { fg: theme.text.base },
			property: { fg: theme.text.feedback.info.muted },
			operator: { fg: theme.text.muted },
			punctuation: { fg: theme.text.muted },
			conceal: { fg: theme.text.muted },
		},
		owner,
	);
	const styles = ownerCache ?? new Map<Theme, SyntaxStyle>();
	styles.set(theme, style);
	if (!ownerCache) cache.set(owner, styles);
	return style;
}

/** Resolve a renderer-owned style; a host/context mismatch falls back to the
 * renderable's own style handling instead of crashing the panel. */
export function useSyntaxStyle(theme: Theme) {
	try {
		const renderer = useRenderer();
		const owner =
			(renderer as unknown as { nativeScene?: object }).nativeScene ?? renderer;
		return createSyntaxStyle(theme, owner);
	} catch {
		return undefined as unknown as SyntaxStyle;
	}
}

export function filetypeFor(path: string) {
	const ext = path.split(".").at(-1)?.toLowerCase();
	const types: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		json: "json",
		md: "markdown",
		css: "css",
		scss: "scss",
		html: "html",
		htm: "html",
		xml: "xml",
		yml: "yaml",
		yaml: "yaml",
		sh: "bash",
		bash: "bash",
		java: "java",
		go: "go",
		rs: "rust",
		py: "python",
		rb: "ruby",
		php: "php",
		sql: "sql",
		graphql: "graphql",
		kt: "kotlin",
		kts: "kotlin",
	};
	return ext ? types[ext] : undefined;
}
