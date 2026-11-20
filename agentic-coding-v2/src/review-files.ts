/** Immutable-patch presentation and anchor index. Never reads the working tree. */
export type ReviewFile = {
	key: string;
	oldPath: string | null;
	newPath: string | null;
	status: "A" | "M" | "D" | "R";
	added: number;
	deleted: number;
	diff: string;
	binary: boolean;
	oldLines: number[];
	newLines: number[];
};
export function gitPatchPath(raw: string, prefixed = true): string | null {
	if (raw === "/dev/null") return null;
	let value = raw;
	if (value.startsWith('"')) {
		try {
			// Git uses C-style octal UTF-8 bytes, not JSON unicode escapes.
			const bytes: number[] = [];
			const inner = value.slice(1, -1);
			for (let i = 0; i < inner.length; i++) {
				if (inner[i] !== "\\") {
					const point = inner.codePointAt(i);
					bytes.push(
						...new TextEncoder().encode(String.fromCodePoint(point ?? 0)),
					);
					if (point !== undefined && point > 0xffff) i++;
					continue;
				}
				const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
				if (octal) {
					bytes.push(Number.parseInt(octal[0], 8));
					i += octal[0].length;
				} else {
					i++;
					const c = inner[i] ?? "";
					bytes.push(
						...new TextEncoder().encode(
							(
								{
									n: "\n",
									t: "\t",
									r: "\r",
									b: "\b",
									f: "\f",
									v: "\v",
								} as Record<string, string>
							)[c] ?? c,
						),
					);
				}
			}
			value = new TextDecoder().decode(new Uint8Array(bytes));
		} catch {
			return null;
		}
	}
	return prefixed ? value.replace(/^[ab]\//, "") : value;
}
export function reviewFiles(snapshot: string): ReviewFile[] {
	const chunks = snapshot
		.split(/(?=^diff --git )/m)
		.filter((chunk) => chunk.startsWith("diff --git ") || /^--- /m.test(chunk));
	return chunks.slice(0, 2000).map((diff, index) => {
		const first = diff.split("\n", 1)[0] ?? "";
		const names =
			/^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(
				first,
			);
		let oldPath = names?.[1] ? gitPatchPath(names[1]) : null;
		let newPath = names?.[2] ? gitPatchPath(names[2]) : null;
		let added = 0,
			deleted = 0,
			old = 0,
			next = 0,
			oldCount = 0,
			newCount = 0;
		const oldLines: number[] = [],
			newLines: number[] = [];
		let newFile = false,
			deletedFile = false,
			renamed = false,
			binary = false;
		for (const line of diff.split("\n")) {
			if (!oldCount && !newCount) {
				if (line.startsWith("--- ")) {
					oldPath = gitPatchPath(line.slice(4));
					continue;
				}
				if (line.startsWith("+++ ")) {
					newPath = gitPatchPath(line.slice(4));
					continue;
				}
				if (line.startsWith("new file mode ")) {
					newFile = true;
					oldPath = null;
				}
				if (line.startsWith("deleted file mode ")) {
					deletedFile = true;
					newPath = null;
				}
				if (line.startsWith("rename from ")) {
					oldPath = gitPatchPath(line.slice(12), false);
					renamed = true;
				}
				if (line.startsWith("rename to ")) {
					newPath = gitPatchPath(line.slice(10), false);
					renamed = true;
				}
				if (line === "GIT binary patch" || line.startsWith("Binary files "))
					binary = true;
			}
			const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (hunk) {
				old = Number(hunk[1]);
				next = Number(hunk[3]);
				oldCount = Number(hunk[2] ?? 1);
				newCount = Number(hunk[4] ?? 1);
				continue;
			}
			if (!oldCount && !newCount) continue;
			if ((line.startsWith(" ") || line.startsWith("-")) && oldCount) {
				oldLines.push(old++);
				oldCount--;
				if (line.startsWith("-")) deleted++;
			}
			if ((line.startsWith(" ") || line.startsWith("+")) && newCount) {
				newLines.push(next++);
				newCount--;
				if (line.startsWith("+")) added++;
			}
		}
		return {
			key: `${index}:${newPath ?? oldPath ?? "unavailable"}`,
			oldPath,
			newPath,
			status:
				newFile || !oldPath
					? ("A" as const)
					: deletedFile || !newPath
						? ("D" as const)
						: renamed || oldPath !== newPath
							? ("R" as const)
							: ("M" as const),
			added,
			deleted,
			diff,
			binary,
			oldLines,
			newLines,
		};
	});
}
export type ReviewTreeNode = {
	key: string;
	name: string;
	children: ReviewTreeNode[];
	file?: ReviewFile;
};
export function reviewFileTree(files: ReviewFile[]): ReviewTreeNode[] {
	const roots: ReviewTreeNode[] = [];
	for (const file of files) {
		const parts = (file.newPath ?? file.oldPath ?? "Unavailable path").split(
			"/",
		);
		let nodes = roots,
			key = "";
		for (let i = 0; i < parts.length; i++) {
			const name = parts[i] ?? "";
			key += `/${name}`;
			if (i === parts.length - 1)
				nodes.push({ key: file.key, name, children: [], file });
			else {
				let node = nodes.find((n) => n.key === key && !n.file);
				if (!node) {
					node = { key, name, children: [] };
					nodes.push(node);
				}
				nodes = node.children;
			}
		}
	}
	const sort = (nodes: ReviewTreeNode[]) => {
		nodes.sort(
			(a, b) =>
				Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name),
		);
		for (const n of nodes) sort(n.children);
	};
	sort(roots);
	return roots;
}
