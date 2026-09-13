// Shared diff view computation. Both the environment and workflow review
// modals render the same unified/split line model; only per-feature anchors
// (comments, source ranges, finding ids) differ and stay in the wrappers.

export interface DiffLine {
	/** Line number in the diff output. */
	lineNumber: number;
	type: "added" | "removed" | "context" | "header";
	content: string;
	/** Original line number (removed/context). */
	oldLineNum?: number;
	/** New file line number (added/context). */
	newLineNum?: number;
}

export interface SplitDiffLine {
	/** Index in the split view. */
	lineNumber: number;
	oldLine?: { lineNum?: number; content: string; type: "removed" | "context" };
	newLine?: { lineNum?: number; content: string; type: "added" | "context" };
	header?: string;
}

/**
 * Parse a unified diff into typed lines. `--- `/`+++ ` file headers and `@@`
 * hunk headers become `header` rows; `+`/`-`/` ` prefixes become
 * added/removed/context rows with old/new line numbers.
 */
export function parseDiffLines(diff: string): DiffLine[] {
	const lines: DiffLine[] = [];
	const diffLines = diff.split("\n");

	let oldLineNum = 0;
	let newLineNum = 0;
	let lineNumber = 0;

	for (const line of diffLines) {
		lineNumber++;

		// Skip diff header lines (---, +++, @@)
		if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			lines.push({ lineNumber, type: "header", content: line });
			continue;
		}

		// Hunk header (@@ -10,7 +10,7 @@)
		if (line.startsWith("@@")) {
			const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
			if (match) {
				oldLineNum = parseInt(match[1], 10) - 1;
				newLineNum = parseInt(match[2], 10) - 1;
			}
			lines.push({ lineNumber, type: "header", content: line });
			continue;
		}

		if (line.startsWith("+")) {
			newLineNum++;
			lines.push({
				lineNumber,
				type: "added",
				content: line.slice(1),
				newLineNum,
			});
		} else if (line.startsWith("-")) {
			oldLineNum++;
			lines.push({
				lineNumber,
				type: "removed",
				content: line.slice(1),
				oldLineNum,
			});
		} else if (line.startsWith(" ")) {
			oldLineNum++;
			newLineNum++;
			lines.push({
				lineNumber,
				type: "context",
				content: line.slice(1),
				oldLineNum,
				newLineNum,
			});
		} else if (line.trim()) {
			// Other lines (e.g., "\ No newline at end of file")
			lines.push({ lineNumber, type: "context", content: line });
		}
	}

	return lines;
}

/**
 * Pair parsed diff lines side by side: headers span both columns, context
 * lines appear on both sides, and runs of removed/added lines are zipped.
 */
export function buildSplitDiffLines(
	parsed: readonly DiffLine[],
): SplitDiffLine[] {
	const lines: SplitDiffLine[] = [];
	let lineNumber = 0;
	let i = 0;

	while (i < parsed.length) {
		const line = parsed[i];
		if (!line) break;

		if (line.type === "header") {
			lines.push({ lineNumber: lineNumber++, header: line.content });
			i++;
			continue;
		}

		if (line.type === "context") {
			lines.push({
				lineNumber: lineNumber++,
				oldLine: {
					lineNum: line.oldLineNum,
					content: line.content,
					type: "context",
				},
				newLine: {
					lineNum: line.newLineNum,
					content: line.content,
					type: "context",
				},
			});
			i++;
			continue;
		}

		if (line.type === "removed") {
			const removedLines: DiffLine[] = [line];
			let j = i + 1;
			while (j < parsed.length && parsed[j]?.type === "removed") {
				removedLines.push(parsed[j] as DiffLine);
				j++;
			}
			const addedLines: DiffLine[] = [];
			while (j < parsed.length && parsed[j]?.type === "added") {
				addedLines.push(parsed[j] as DiffLine);
				j++;
			}
			const maxLen = Math.max(removedLines.length, addedLines.length);
			for (let k = 0; k < maxLen; k++) {
				const removed = removedLines[k];
				const added = addedLines[k];
				lines.push({
					lineNumber: lineNumber++,
					oldLine: removed
						? {
								lineNum: removed.oldLineNum,
								content: removed.content,
								type: "removed",
							}
						: undefined,
					newLine: added
						? {
								lineNum: added.newLineNum,
								content: added.content,
								type: "added",
							}
						: undefined,
				});
			}
			i = j;
			continue;
		}

		if (line.type === "added") {
			lines.push({
				lineNumber: lineNumber++,
				newLine: {
					lineNum: line.newLineNum,
					content: line.content,
					type: "added",
				},
			});
			i++;
			continue;
		}

		i++;
	}

	return lines;
}
