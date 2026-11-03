// Decode reviewed connector transport shapes only. Source text is data, never authority.
export interface JiraCandidate {
	readonly id: string;
	readonly title: string;
}
export interface DecodedDigestSource {
	readonly value: unknown;
	readonly candidates: readonly JiraCandidate[];
	readonly diagnostics: readonly string[];
}
export function decodeDigestSource(
	value: unknown,
	source: string,
): DecodedDigestSource {
	let current = value;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof current === "string") {
			if (
				current.length > 256000 ||
				new TextEncoder().encode(current).byteLength > 256000
			)
				return {
					value: {},
					candidates: [],
					diagnostics: ["source-response-byte-cap"],
				};
			try {
				current = JSON.parse(current);
				continue;
			} catch {
				/* Reviewed Markdown below. */
			}
			if (source === "jira") return decodeJiraMarkdown(current as string);
			return {
				value: {},
				candidates: [],
				diagnostics: ["source-text-schema-unrecognized"],
			};
		}
		if (current && typeof current === "object" && !Array.isArray(current)) {
			const envelope = current as Record<string, unknown>;
			if (envelope.structuredContent !== undefined) {
				current = envelope.structuredContent;
				continue;
			}
			if (Array.isArray(envelope.content) && envelope.content.length === 1) {
				const part = envelope.content[0];
				if (
					part &&
					typeof part === "object" &&
					part.type === "text" &&
					typeof part.text === "string"
				) {
					current = part.text;
					continue;
				}
			}
		}
		return { value: current, candidates: [], diagnostics: [] };
	}
	return {
		value: {},
		candidates: [],
		diagnostics: ["source-envelope-depth-cap"],
	};
}
function decodeJiraMarkdown(text: string): DecodedDigestSource {
	const candidates: JiraCandidate[] = [];
	const lines = text.split(/\r?\n/);
	const header =
		/^Found (\d+) issue\(s\) on this page(?: \((more available)\))?:$/.exec(
			lines[0] ?? "",
		);
	if (header) {
		for (const line of lines) {
			const match = /^- \*\*([A-Z][A-Z0-9_]*-\d+)\*\*: (.+)$/.exec(line);
			if (match?.[1] && match[2])
				candidates.push({ id: match[1], title: match[2].slice(0, 300) });
		}
		const token = lines
			.find((line) => line.startsWith("Next page token: "))
			?.slice(17)
			.trim();
		if (Number(header[1]) !== candidates.length)
			return {
				value: {},
				candidates,
				diagnostics: ["jira-markdown-candidate-count-mismatch"],
			};
		return {
			value: {
				issues: [],
				isLast: !header[2],
				...(token ? { nextPageToken: token } : {}),
			},
			candidates,
			diagnostics: candidates.length
				? [
						"jira-candidate-detail-required",
						"jira-history-capability-unavailable",
					]
				: [],
		};
	}
	const detail = /^\*\*([A-Z][A-Z0-9_]*-\d+): (.+)\*\*$/.exec(lines[0] ?? "");
	if (detail?.[1] && detail[2])
		return {
			value: { key: detail[1], fields: { summary: detail[2] } },
			candidates: [{ id: detail[1], title: detail[2].slice(0, 300) }],
			diagnostics: [
				"jira-detail-timestamps-unavailable",
				"jira-history-capability-unavailable",
				"jira-source-link-unavailable",
			],
		};
	const commentsHeader =
		/^(\d+) comment\(s\) on ([A-Z][A-Z0-9_]*-\d+) \(showing (\d+)–(\d+)\):$/.exec(
			lines[0] ?? "",
		);
	if (commentsHeader && Number(commentsHeader[1]) > 0) {
		const total = Number(commentsHeader[1]),
			issueKey = commentsHeader[2],
			start = Number(commentsHeader[3]),
			end = Number(commentsHeader[4]);
		const sections = [
			...text.matchAll(/^--- Comment (\d+) ---\r?\n([^\r\n]*)/gm),
		];
		const comments: { id: string; created: string }[] = [];
		let valid =
			!!issueKey &&
			Number.isSafeInteger(total) &&
			start >= 1 &&
			end >= start &&
			end <= total &&
			end - start < 1000 &&
			sections.length === end - start + 1;
		for (const [index, section] of sections.entries()) {
			const metadata =
				/^\[id:(\d+)\] [^\r\n]{1,200} @ (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})):$/.exec(
					section[2] ?? "",
				);
			if (
				Number(section[1]) !== start + index ||
				!metadata?.[1] ||
				!metadata[2] ||
				!Number.isFinite(Date.parse(metadata[2]))
			) {
				valid = false;
				continue;
			}
			comments.push({ id: metadata[1], created: metadata[2] });
		}
		if (!valid)
			return {
				value: {},
				candidates: [],
				diagnostics: ["jira-markdown-comments-schema-ambiguous"],
			};
		return {
			value: {
				issues: [
					{ key: issueKey, title: issueKey, comments, commentPage: true },
				],
				isLast: end === total,
				...(end < total ? { nextPageToken: String(end) } : {}),
			},
			candidates: [],
			diagnostics: [],
		};
	}
	if (
		/^0 comment\(s\) on [A-Z][A-Z0-9_]*-\d+ \(showing 1–0\):$/.test(
			lines[0] ?? "",
		)
	)
		return {
			value: { comments: [], isLast: true },
			candidates: [],
			diagnostics: [],
		};
	return {
		value: {},
		candidates: [],
		diagnostics: ["jira-markdown-schema-unrecognized"],
	};
}
