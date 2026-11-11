// v1's wiki tree (src/workflow/wiki.ts buildWikiTree/flattenWikiTree), copied
// without the checkout bundle: v2 page ids are flat slugs, so the tree is the
// same deterministic structure with an empty directory level unless an id ever
// contains a separator. The reserved index/log files are never listed.
export type WikiTreeNode = {
	kind: "directory" | "concept";
	id: string;
	label: string;
	depth: number;
	children: WikiTreeNode[];
};

const RESERVED = new Set(["index.md", "log.md"]);

export function buildWikiTree(ids: readonly string[]): WikiTreeNode[] {
	const root: WikiTreeNode[] = [];
	const directories = new Map<string, WikiTreeNode>();
	for (const raw of ids) {
		const id = raw.replaceAll("\\", "/").replace(/\.md$/, "");
		if (!id || RESERVED.has(`${id}.md`)) continue;
		const parts = id.split("/").filter(Boolean);
		if (!parts.length || RESERVED.has(`${parts[parts.length - 1]}.md`))
			continue;
		let siblings = root;
		let prefix = "";
		for (const [index, part] of parts.entries()) {
			prefix = prefix ? `${prefix}/${part}` : part;
			if (index === parts.length - 1) {
				siblings.push({
					kind: "concept",
					id,
					label: `${part}.md`,
					depth: index,
					children: [],
				});
				continue;
			}
			let directory = directories.get(prefix);
			if (!directory) {
				directory = {
					kind: "directory",
					id: prefix,
					label: part,
					depth: index,
					children: [],
				};
				directories.set(prefix, directory);
				siblings.push(directory);
			}
			siblings = directory.children;
		}
	}
	const sort = (nodes: WikiTreeNode[]): void => {
		nodes.sort(
			(a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind),
		);
		for (const node of nodes) sort(node.children);
	};
	sort(root);
	return root;
}

export function flattenWikiTree(
	nodes: readonly WikiTreeNode[],
	expanded: ReadonlySet<string> = new Set(),
): WikiTreeNode[] {
	return nodes.flatMap((node) => [
		node,
		...(node.kind === "directory" && expanded.has(node.id)
			? flattenWikiTree(node.children, expanded)
			: []),
	]);
}

/** Rows plus the flattening, as one call the view can hold in a memo. */
export const wikiTree = (ids: readonly string[]) => {
	const tree = buildWikiTree(ids);
	return {
		tree,
		flatten: (expanded: ReadonlySet<string>) => flattenWikiTree(tree, expanded),
	};
};
