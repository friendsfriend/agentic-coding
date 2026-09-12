/** @jsxImportSource @opentui/solid */

import type { ActionTarget, DependencyRef } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import { uiColors } from "../colors";
import { AnimatedStatusText } from "./AnimatedStatusText";
import { type Highlight, highlightColor } from "./Highlight";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DependencyNode {
	/** Unique key for deduplication — "app:<ident>" or "infra:<ident>" */
	key: string;
	/** Display name */
	name: string;
	/** Node kind */
	kind: "app" | "infra";
	/** Runtime label (apps only) */
	runtime?: string;
	/** Profile label (apps only) */
	profile?: string;
	/** Current status: running | stopped | failed | unknown */
	status: "running" | "stopped" | "failed" | "unknown";
	/** Whether this node has been expanded (apps with deps) */
	expanded: boolean;
	/** Children loaded? false = never fetched, true = fetched (may be empty) */
	childrenLoaded: boolean;
	/** Loading children in progress */
	loading: boolean;
	/** Child nodes (populated after expand) */
	children: DependencyNode[];
	/** Depth in tree (0 = root) */
	depth: number;
	/** True if this node was already seen at a shallower depth (dedup marker) */
	deduped: boolean;
	/** True if a cycle was detected at this node */
	cycled: boolean;
}

export interface DependencyTreeViewProps {
	/** Root nodes to render (the current app's direct requires) */
	nodes: DependencyNode[];
	/** Currently selected visible node index */
	selectedIndex: number;
	/** Whether this tree is focused (for keyboard navigation) */
	focused: boolean;
	/** Called when a tree node is clicked (mouse) */
	onNodeClick?: (node: DependencyNode, flatIndex: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusHighlight(status: DependencyNode["status"]): Highlight {
	switch (status) {
		case "running":
			return "positive";
		case "stopped":
			return "negative";
		case "failed":
			return "negative";
		case "unknown":
			return "warning";
	}
}

function statusLabel(status: DependencyNode["status"]): string {
	switch (status) {
		case "running":
			return "running";
		case "stopped":
			return "stopped";
		case "failed":
			return "failed";
		case "unknown":
			return "?";
	}
}

function nodeIcon(kind: DependencyNode["kind"]): string {
	return kind === "app" ? "" : "";
}

/**
 * Flatten a tree of DependencyNodes into visible rows for virtual scrolling.
 * Each row carries its depth and a reference to the original node.
 */
function flattenVisible(
	nodes: DependencyNode[],
): Array<{ node: DependencyNode; depth: number }> {
	const result: Array<{ node: DependencyNode; depth: number }> = [];

	function walk(list: DependencyNode[]) {
		for (const node of list) {
			result.push({ node, depth: node.depth });
			if (node.expanded && node.children.length > 0) {
				walk(node.children);
			}
		}
	}

	walk(nodes);
	return result;
}

/**
 * Compute tree connector lines for a given row.
 * Returns prefix characters for indentation.
 */
function treePrefix(
	depth: number,
	isLast: boolean,
	ancestorsLast: boolean[],
): string {
	if (depth === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < depth - 1; i++) {
		parts.push(ancestorsLast[i] ? "  " : "│ ");
	}
	parts.push(isLast ? "└─" : "├─");
	return parts.join("");
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DependencyTreeView(props: DependencyTreeViewProps) {
	const flatRows = createMemo(() => flattenVisible(props.nodes));

	/** Compute `isLast` and `ancestorsLast` for connector lines */
	const rowsWithConnectors = createMemo(() => {
		const _flat = flatRows();
		const result: Array<{
			node: DependencyNode;
			depth: number;
			isLast: boolean;
			ancestorsLast: boolean[];
		}> = [];

		// Track the last-child status at each depth
		const lastAtDepth: boolean[] = [];
		function walkList(list: DependencyNode[], depth: number) {
			for (let idx = 0; idx < list.length; idx++) {
				const node = list[idx];
				const isLast = idx === list.length - 1;
				const ancestorsLast = [...lastAtDepth];

				// Update lastAtDepth for this depth
				lastAtDepth[depth] = isLast;

				result.push({ node, depth, isLast, ancestorsLast });

				if (node.expanded && node.children.length > 0) {
					walkList(node.children, depth + 1);
				}
			}
		}

		walkList(props.nodes, 0);
		return result;
	});

	/** Currently selected row index within flatRows */
	const selectedIndex = () =>
		Math.min(props.selectedIndex, Math.max(0, flatRows().length - 1));

	return (
		<box
			style={{
				width: "100%",
				flexGrow: 1,
				flexDirection: "column",
				overflow: "hidden",
			}}
		>
			<Show
				when={flatRows().length > 0}
				fallback={
					<box style={{ paddingLeft: 1, paddingRight: 1 }}>
						<text fg={uiColors.textMuted}>No dependencies</text>
					</box>
				}
			>
				<For each={rowsWithConnectors()}>
					{(row, idx) => {
						const isSelected = () => idx() === selectedIndex();
						const hasChildren = () =>
							row.node.kind === "app" && !row.node.deduped;
						const prefix = treePrefix(row.depth, row.isLast, row.ancestorsLast);

						const rowHighlight = createMemo(() => {
							if (isSelected() && props.focused)
								return highlightColor("highlight") as string;
							return undefined;
						});

						const rowBg = createMemo(() => {
							if (isSelected() && props.focused) return uiColors.bgSurface0;
							return undefined;
						});

						return (
							<box
								backgroundColor={rowBg()}
								onMouseUp={() => {
									console.error(
										`[TREE CLICK] node=${row.node.key}, idx=${idx()}`,
									);
									props.onNodeClick?.(row.node, idx());
								}}
								style={{
									width: "100%",
									height: 1,
									flexDirection: "row",
								}}
							>
								<box
									backgroundColor={rowHighlight()}
									style={{ width: 1, height: "100%", flexShrink: 0 }}
								/>
								<box
									style={{
										flexGrow: 1,
										flexDirection: "row",
										paddingLeft: 1,
										paddingRight: 1,
										minWidth: 0,
									}}
								>
									{/* Tree connector prefix */}
									<text fg={uiColors.textMuted}>{prefix}</text>

									{/* Expand/collapse indicator */}
									<Show when={hasChildren()}>
										<text
											fg={
												row.node.expanded
													? uiColors.textSecondary
													: uiColors.textMuted
											}
										>
											{row.node.expanded ? "▾ " : "▸ "}
										</text>
									</Show>
									<Show when={!hasChildren()}>
										<text>{"  "}</text>
									</Show>

									{/* Node icon */}
									<text>{nodeIcon(row.node.kind)} </text>

									{/* Node name */}
									<text
										fg={
											isSelected() && props.focused
												? (highlightColor("highlight") as string)
												: uiColors.textPrimary
										}
										attributes={
											isSelected() && props.focused
												? TextAttributes.BOLD
												: undefined
										}
									>
										{row.node.name}
									</text>

									{/* Runtime/profile badge (apps only) */}
									<Show when={row.node.runtime}>
										<text fg={uiColors.textMuted}>
											{` (${row.node.runtime}${row.node.profile ? `/${row.node.profile}` : ""})`}
										</text>
									</Show>

									{/* Deduped indicator */}
									<Show when={row.node.deduped}>
										<text fg={uiColors.textMuted}> ↻</text>
									</Show>

									{/* Cycle indicator */}
									<Show when={row.node.cycled}>
										<text fg={uiColors.warning}> ⚠ cycle</text>
									</Show>

									<Show when={row.node.loading}>
										<text> </text>
										<AnimatedStatusText
											text="loading"
											intent="load"
											backgroundColor={uiColors.bgMantle}
										/>
									</Show>

									{/* Status badge */}
									<text fg={highlightColor(statusHighlight(row.node.status))}>
										{" "}
										{statusLabel(row.node.status)}
									</text>
								</box>
							</box>
						);
					}}
				</For>
			</Show>
		</box>
	);
}

// ─── Tree builder utility ────────────────────────────────────────────────────

/**
 * Build initial DependencyNode tree from ActionTarget.requires.
 * Deduplicates shared dependencies across the tree.
 *
 * @param targets - ActionTargets for the root app
 * @param appStatusMap - Map from app ident to running status
 * @param infraStatusMap - Map from infra ident to running status
 */
export function buildDependencyTree(
	targets: ActionTarget[],
	appStatusMap: Map<string, string>,
	infraStatusMap: Map<string, string>,
): DependencyNode[] {
	const seen = new Set<string>();

	function makeNode(ref: DependencyRef, depth: number): DependencyNode | null {
		if (ref.app) {
			const key = `app:${ref.app}`;
			const deduped = seen.has(key);
			seen.add(key);
			const status = normalizeStatus(appStatusMap.get(ref.app));
			return {
				key,
				name: ref.app,
				kind: "app",
				runtime: ref.runtime,
				profile: ref.profile,
				status,
				expanded: false,
				childrenLoaded: false,
				loading: false,
				children: [],
				depth,
				deduped,
				cycled: false,
			};
		}
		if (ref.infra) {
			const key = `infra:${ref.infra}`;
			const deduped = seen.has(key);
			seen.add(key);
			const status = normalizeStatus(infraStatusMap.get(ref.infra));
			return {
				key,
				name: ref.infra,
				kind: "infra",
				status,
				expanded: false,
				childrenLoaded: false,
				loading: false,
				children: [],
				depth,
				deduped,
				cycled: false,
			};
		}
		return null;
	}

	const requires = targets.flatMap((t) => t.requires ?? []);
	const nodes: DependencyNode[] = [];
	for (const ref of requires) {
		const node = makeNode(ref, 0);
		if (node) nodes.push(node);
	}
	return nodes;
}

/**
 * Expand a node in-place, populating its children from an ActionTarget list.
 * Handles cycle detection and deduplication within the expanded subtree.
 */
export function expandNode(
	nodes: DependencyNode[],
	targetKey: string,
	childTargets: ActionTarget[],
	appStatusMap: Map<string, string>,
	infraStatusMap: Map<string, string>,
	ancestorKeys: Set<string> = new Set(),
): void {
	for (const node of nodes) {
		if (node.key === targetKey) {
			node.expanded = true;
			node.childrenLoaded = true;
			node.loading = false;

			const requires = childTargets.flatMap((t) => t.requires ?? []);
			const children: DependencyNode[] = [];

			for (const ref of requires) {
				if (ref.app) {
					const key = `app:${ref.app}`;
					const cycled = ancestorKeys.has(key);
					const deduped = ancestorKeys.has(key);
					const status = normalizeStatus(appStatusMap.get(ref.app));
					children.push({
						key,
						name: ref.app,
						kind: "app",
						runtime: ref.runtime,
						profile: ref.profile,
						status,
						expanded: false,
						childrenLoaded: false,
						loading: false,
						children: [],
						depth: node.depth + 1,
						deduped,
						cycled,
					});
				} else if (ref.infra) {
					const key = `infra:${ref.infra}`;
					const deduped = ancestorKeys.has(key);
					const status = normalizeStatus(infraStatusMap.get(ref.infra));
					children.push({
						key,
						name: ref.infra,
						kind: "infra",
						status,
						expanded: false,
						childrenLoaded: false,
						loading: false,
						children: [],
						depth: node.depth + 1,
						deduped,
						cycled: false,
					});
				}
			}

			node.children = children;
			return;
		}

		if (node.expanded && node.children.length > 0) {
			const nextAncestors = new Set(ancestorKeys);
			nextAncestors.add(node.key);
			expandNode(
				node.children,
				targetKey,
				childTargets,
				appStatusMap,
				infraStatusMap,
				nextAncestors,
			);
		}
	}
}

function normalizeStatus(raw: string | undefined): DependencyNode["status"] {
	if (!raw) return "unknown";
	const lower = raw.toLowerCase();
	if (lower.includes("running") || lower.includes("healthy") || lower === "up")
		return "running";
	if (lower.includes("stopped") || lower.includes("exited") || lower === "down")
		return "stopped";
	if (
		lower.includes("failed") ||
		lower.includes("dead") ||
		lower.includes("error")
	)
		return "failed";
	return "unknown";
}
