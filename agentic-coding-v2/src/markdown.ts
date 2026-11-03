import { Marked, Renderer } from "marked";

export const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.text = function (token) {
	return "tokens" in token && token.tokens
		? this.parser.parseInline(token.tokens)
		: escapeHtml(token.text);
};
renderer.image = ({ href, text }) =>
	/^\/attachments\/[a-f0-9]{64}$/.test(href)
		? `<img loading="lazy" src="${href}" alt="${escapeHtml(text)}">`
		: `<span>[Image blocked: ${escapeHtml(text)}]</span>`;
renderer.link = function ({ href, tokens }) {
	const label = this.parser.parseInline(tokens);
	return /^https?:\/\//i.test(href)
		? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
		: label;
};
const markdown = new Marked({ renderer, gfm: true, breaks: false });
export function renderMarkdown(content: string): string {
	return markdown.parse(content, { async: false });
}
