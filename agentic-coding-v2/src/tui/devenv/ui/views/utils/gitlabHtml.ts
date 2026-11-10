/**
 * Converts GitLab system-note HTML bodies to Markdown for terminal rendering.
 *
 * GitLab system notes arrive as HTML, for example:
 *
 *   added 2 commits
 *   <ul>
 *     <li>5c5e6c6c...16c5b29e - 2 commits from branch <code>develop</code></li>
 *     <li>aeaec37b - 37504 Other feed in actor</li>
 *   </ul>
 *   <a href="...">Compare with previous version</a>
 *
 * This converter handles the known GitLab HTML patterns and produces clean
 * Markdown that the OpenTUI <code filetype="markdown"> renderer can display.
 */

/** Decode common HTML entities. */
function decodeEntities(html: string): string {
	return html
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

/**
 * Convert GitLab system-note HTML to Markdown.
 *
 * Handles:
 *  - <ul><li>…</li></ul>  →  markdown bullet list
 *  - <code>…</code>       →  `backtick` inline code
 *  - <a href="…">text</a> →  [text](url)  (link dropped if url is relative/internal)
 *  - <strong>/<b>         →  **bold**
 *  - <em>/<i>             →  _italic_
 *  - <br>                 →  newline
 *  - HTML entities        →  decoded
 *  - Everything else      →  stripped
 */
export function gitlabHtmlToMarkdown(html: string): string {
	let text = html.trim();

	// Decode entities first so subsequent regexes work on clean text
	text = decodeEntities(text);

	// <code>…</code> → `…`
	text = text.replace(/<code>([\s\S]*?)<\/code>/gi, (_, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return `\`${content}\``;
	});

	// <strong>/<b> → **…**
	text = text.replace(
		/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi,
		(_, inner) => {
			const content = inner.replace(/<[^>]+>/g, "").trim();
			return `**${content}**`;
		},
	);

	// <em>/<i> → _…_
	text = text.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, (_, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return `_${content}_`;
	});

	// <a href="…">text</a> → [text](url) but drop GitLab-internal compare links
	// (they are not useful in a terminal)
	text = text.replace(
		/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href, inner) => {
			const linkText = inner.replace(/<[^>]+>/g, "").trim();
			// Drop the link entirely if it is a relative GitLab URL
			if (href.startsWith("/") || href.startsWith("#")) {
				return linkText ? `_${linkText}_` : "";
			}
			return linkText ? `[${linkText}](${href})` : href;
		},
	);

	// <li>…</li> → markdown bullet, preserving inline markup already converted
	text = text.replace(/<li>([\s\S]*?)<\/li>/gi, (_, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return `- ${content}\n`;
	});

	// <ul>/<ol> wrappers — just strip the tags
	text = text.replace(/<\/?(?:ul|ol)[^>]*>/gi, "\n");

	// <br> → newline
	text = text.replace(/<br\s*\/?>/gi, "\n");

	// <p>/<div> → newline around content
	text = text.replace(/<\/(?:p|div)>/gi, "\n");
	text = text.replace(/<(?:p|div)[^>]*>/gi, "");

	// Strip any remaining tags
	text = text.replace(/<[^>]+>/g, "");

	// Re-decode entities that might have been introduced by replacements
	text = decodeEntities(text);

	// Normalise whitespace: trim each line, collapse >2 consecutive blank lines
	const lines = text.split("\n").map((l) => l.trimEnd());
	const result: string[] = [];
	let blankRun = 0;
	for (const line of lines) {
		if (line.trim() === "") {
			blankRun++;
			if (blankRun <= 1) result.push("");
		} else {
			blankRun = 0;
			result.push(line);
		}
	}

	return result.join("\n").trim();
}

/** Returns true if the string contains HTML tags. */
export function containsHtml(text: string): boolean {
	return /<[a-z][\s\S]*>/i.test(text);
}
