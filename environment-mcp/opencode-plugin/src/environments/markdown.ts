function decodeEntities(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
			String.fromCharCode(parseInt(hex, 16)),
		);
}

/** Convert the HTML fragments used by provider system notes and bodies into
 * Markdown the terminal renderer can display. Unknown tags are stripped. */
export function providerMarkdown(value: string) {
	let text = value.trim();
	if (!/<[a-z][\s\S]*>/i.test(text)) return decodeEntities(text);

	// Raw code blocks first, so their content is not treated as markup.
	text = text.replace(
		/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
		(_, inner) => `\n\`\`\`\n${decodeEntities(inner.trim())}\n\`\`\`\n`,
	);
	text = text.replace(
		/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
		(_, inner) => `\n\`\`\`\n${decodeEntities(inner.trim())}\n\`\`\`\n`,
	);
	text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return content ? `\`${decodeEntities(content)}\`` : "";
	});
	text = text.replace(
		/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
		(_, inner) => `**${inner.replace(/<[^>]+>/g, "").trim()}**`,
	);
	text = text.replace(
		/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
		(_, inner) => `_${inner.replace(/<[^>]+>/g, "").trim()}_`,
	);
	text = text.replace(
		/<del[^>]*>([\s\S]*?)<\/del>/gi,
		(_, inner) => `~~${inner.replace(/<[^>]+>/g, "").trim()}~~`,
	);
	text = text.replace(
		/<summary[^>]*>([\s\S]*?)<\/summary>/gi,
		(_, inner) => `### ${inner.replace(/<[^>]+>/g, "").trim()}\n`,
	);
	text = text.replace(
		/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi,
		(_, alt, src) => `![${decodeEntities(alt)}](${src})`,
	);
	text = text.replace(
		/<img[^>]*src="([^"]*)"[^>]*>/gi,
		(_, src) => `![](${src})`,
	);
	text = text.replace(
		/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href, inner) => {
			const label = inner.replace(/<[^>]+>/g, "").trim();
			if (href.startsWith("/") || href.startsWith("#")) return label;
			return label ? `[${label}](${href})` : href;
		},
	);
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return `- ${content}\n`;
	});
	text = text.replace(/<\/?(?:ul|ol|details)[^>]*>/gi, "\n");
	text = text.replace(/<blockquote[^>]*>/gi, "\n> ");
	text = text.replace(/<\/blockquote>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
	text = text.replace(/<\/(?:p|div|h[1-6])>/gi, "\n");
	text = text.replace(/<(?:p|div|h[1-6])[^>]*>/gi, "");
	text = text.replace(/<[^>]+>/g, "");
	text = decodeEntities(text);

	const lines = text.split("\n").map((line) => line.trimEnd());
	const result: string[] = [];
	let blank = 0;
	for (const line of lines) {
		if (!line.trim()) {
			blank++;
			if (blank <= 1) result.push("");
		} else {
			blank = 0;
			result.push(line);
		}
	}
	return result.join("\n").trim();
}
