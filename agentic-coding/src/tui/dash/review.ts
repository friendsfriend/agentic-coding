/** Dashboard review feature: plan, developer, and wiki review state, drafts,
 * and submission. Owns its signals, in-flight observation controllers, and the
 * review submission payload construction. Explicit typed inputs only — no
 * global store, no root context. The root component wires the returned signals
 * into keymaps and rendering; action availability and revision authority stay
 * with the displayed engine action (`requiredUserAction`) and `data().state`.
 * Solid ownership: the factory runs under the App owner, and `dispose()` is
 * wired into App's unmount cleanup. */
import type { KeyEvent } from "@opentui/core";
import { createMemo, createSignal, type Setter } from "solid-js";
import type { Discussion } from "./devenv-ui/types";
import { notify } from "./notifications";
import {
	loadDeveloperReviewFindings,
	loadLocalChangesAsync,
	loadLocalDiffAsync,
	loadWikiSnapshotChangesAsync,
	loadWikiSnapshotDiffAsync,
	openSpecArtifactAsync,
	runWorkflow,
	saveDeveloperReview,
	savePlanReview,
	saveWikiReview,
} from "./observations";
import type {
	DashboardData,
	DeveloperReviewComment,
	DeveloperReviewFinding,
	LocalChange,
	RequiredUserAction,
} from "./types";

/** Build the engine `review-comments` payload from draft comments. Plan and
 * wiki reviews carry file/line/range; developer reviews additionally carry the
 * verifier finding identity so the worker can resolve it. Pure (data in,
 * payload out) so the submission payload is testable without I/O. */
export function reviewCommentsForEngine(
	comments: DeveloperReviewComment[],
	includeFindingId = false,
): Array<Record<string, string | number | undefined>> {
	return comments.map((comment) => ({
		comment: comment.body,
		...(comment.filePath ? { file: comment.filePath } : {}),
		...(comment.line ? { line: comment.line } : {}),
		...(comment.startLine ? { startLine: comment.startLine } : {}),
		...(comment.endLine ? { endLine: comment.endLine } : {}),
		...(includeFindingId && comment.findingId
			? { findingId: comment.findingId }
			: {}),
	}));
}

export interface ReviewFeatureContext {
	repo: string;
	workflowId: string;
	profile?: "test";
	/** Modal-layer switch on the App keymap (the feature owns review modal
	 * activation but never the keymap itself). */
	setModalActive: (modal: string) => void;
	setMessage: (message: string) => void;
	setBusy: (busy: boolean) => void;
	busy: () => boolean;
	setReviewFinishing: (finishing: boolean) => void;
	setReviewFinishingMessage: (message: string) => void;
	refresh: () => void;
	data: () => DashboardData;
	/** Displayed engine user action; the submission targets its action IDs. */
	requiredUserAction: () => RequiredUserAction | undefined;
	artifacts: () => string[];
	dimensions: () => { width: number; height: number };
	setDemoIndex: (update: (index: number) => number) => void;
	demoPhases: readonly string[];
}

export interface ReviewFeature {
	reviewOpen: () => boolean;
	setReviewOpen: Setter<boolean>;
	reviewKind: () => "developer" | "plan" | "wiki";
	setReviewKind: Setter<"developer" | "plan" | "wiki">;
	reviewView: () => "files" | "diff";
	setReviewView: Setter<"files" | "diff">;
	reviewLoading: () => boolean;
	setReviewLoading: Setter<boolean>;
	reviewChanges: () => LocalChange[];
	setReviewChanges: Setter<LocalChange[]>;
	reviewChangeIndex: () => number;
	setReviewChangeIndex: Setter<number>;
	reviewLine: () => number;
	setReviewLine: Setter<number>;
	reviewDiff: () => string;
	setReviewDiff: Setter<string>;
	reviewComments: () => DeveloperReviewComment[];
	setReviewComments: Setter<DeveloperReviewComment[]>;
	reviewFindings: () => DeveloperReviewFinding[];
	setReviewFindings: Setter<DeveloperReviewFinding[]>;
	selectedReviewFindingIds: () => Set<string>;
	setSelectedReviewFindingIds: Setter<Set<string>>;
	reviewCommentMode: () => boolean;
	setReviewCommentMode: Setter<boolean>;
	reviewCommentText: () => string;
	setReviewCommentText: Setter<string>;
	reviewVisualMode: () => boolean;
	setReviewVisualMode: Setter<boolean>;
	reviewVisualStart: () => number;
	setReviewVisualStart: Setter<number>;
	reviewSourceRange: () => { start?: number; end?: number };
	setReviewSourceRange: Setter<{ start?: number; end?: number }>;
	reviewDiscussionLineIndices: () => number[];
	setReviewDiscussionLineIndices: Setter<number[]>;
	reviewSelectableLineCount: () => number;
	setReviewSelectableLineCount: Setter<number>;
	reviewSelectedLineFindingIds: () => string[];
	setReviewSelectedLineFindingIds: Setter<string[]>;
	reviewSearchMode: () => boolean;
	setReviewSearchMode: Setter<boolean>;
	reviewSearchQuery: () => string;
	setReviewSearchQuery: Setter<string>;
	reviewSplitView: () => boolean | null;
	setReviewSplitView: Setter<boolean | null>;
	planRejectionReasons: string[];
	planRejectionOpen: () => boolean;
	setPlanRejectionOpen: Setter<boolean>;
	planRejectionSelection: () => number;
	setPlanRejectionSelection: Setter<number>;
	reviewVisibleChanges: () => LocalChange[];
	reviewFile: () => LocalChange | undefined;
	reviewChangeForView: (
		change: LocalChange,
		diff?: string,
	) => ReviewChangeForView;
	reviewChangesForView: () => ReviewChangeForView[];
	reviewFilesAvailableLines: () => number;
	reviewDiffFile: () => ReviewChangeForView | undefined;
	reviewDiscussions: () => Discussion[];
	currentReviewDiscussions: () => Discussion[];
	cycleReviewComments: (direction: 1 | -1) => void;
	developerReviewPhase: () => boolean;
	openDeveloperReview: () => Promise<void>;
	openReviewDiff: () => Promise<void>;
	finishDeveloperReview: () => Promise<void>;
	openPlanReview: () => Promise<void>;
	openPlanMarkdown: () => Promise<void>;
	/** Developer/wiki review diff navigation across files. */
	navigateReviewFile: (direction: 1 | -1) => Promise<void>;
	/** Plan markdown review navigation (used by the MarkdownViewModal). */
	navigatePlanMarkdownFile: (direction: 1 | -1) => Promise<void>;
	finishPlanReview: () => Promise<void>;
	openPlanRejection: () => void;
	rejectPlan: (reason: string) => Promise<void>;
	handleReviewKey: (event: KeyEvent) => boolean;
	/** In-flight diff observation signal for the root's artifact verdict path. */
	reviewDiffSignal: () => AbortSignal | undefined;
	/** Abort in-flight review observations and bump the generation on unmount. */
	dispose: () => void;
}

/** The file row shape fed to the embedded changed-files and diff viewers. */
export interface ReviewChangeForView {
	old_path: string;
	new_path: string;
	a_mode: string;
	b_mode: string;
	new_file: boolean;
	renamed_file: boolean;
	deleted_file: boolean;
	diff: string;
	lines_added: number;
	lines_deleted: number;
	review_finding_count: number;
}

export function createReviewFeature(
	context: ReviewFeatureContext,
): ReviewFeature {
	const {
		repo,
		workflowId,
		profile,
		setModalActive,
		setMessage,
		setBusy,
		busy,
		setReviewFinishing,
		setReviewFinishingMessage,
		refresh,
		data,
		requiredUserAction,
		artifacts,
		dimensions,
		setDemoIndex,
		demoPhases,
	} = context;

	let reviewController: AbortController | undefined;
	let reviewDiffController: AbortController | undefined;
	let reviewGeneration = 0;
	const [reviewLoading, setReviewLoading] = createSignal(false);
	const planRejectionReasons = [
		"Needs more detail",
		"Scope is not approved",
		"Requires design changes",
		"Reject proposal",
	];
	const [planRejectionOpen, setPlanRejectionOpen] = createSignal(false);
	const [planRejectionSelection, setPlanRejectionSelection] = createSignal(0);

	const [reviewOpen, setReviewOpen] = createSignal(false);
	const [reviewKind, setReviewKind] = createSignal<
		"developer" | "plan" | "wiki"
	>("developer");
	const [reviewView, setReviewView] = createSignal<"files" | "diff">("files");
	const [reviewChanges, setReviewChanges] = createSignal<LocalChange[]>([]);
	const [reviewChangeIndex, setReviewChangeIndex] = createSignal(0);
	const [reviewLine, setReviewLine] = createSignal(0);
	const [reviewDiff, setReviewDiff] = createSignal("");
	const [reviewComments, setReviewComments] = createSignal<
		DeveloperReviewComment[]
	>([]);
	const [reviewFindings, setReviewFindings] = createSignal<
		DeveloperReviewFinding[]
	>([]);
	const [selectedReviewFindingIds, setSelectedReviewFindingIds] = createSignal<
		Set<string>
	>(new Set());
	const [reviewCommentMode, setReviewCommentMode] = createSignal(false);
	const [reviewCommentText, setReviewCommentText] = createSignal("");
	const [reviewVisualMode, setReviewVisualMode] = createSignal(false);
	const [reviewVisualStart, setReviewVisualStart] = createSignal(0);
	const [reviewSourceRange, setReviewSourceRange] = createSignal<{
		start?: number;
		end?: number;
	}>({});
	const [reviewDiscussionLineIndices, setReviewDiscussionLineIndices] =
		createSignal<number[]>([]);
	const [reviewSelectableLineCount, setReviewSelectableLineCount] =
		createSignal(0);
	const [reviewSelectedLineFindingIds, setReviewSelectedLineFindingIds] =
		createSignal<string[]>([]);
	const [reviewSearchMode, setReviewSearchMode] = createSignal(false);
	const [reviewSearchQuery, setReviewSearchQuery] = createSignal("");
	const [reviewSplitView, setReviewSplitView] = createSignal<boolean | null>(
		null,
	);
	const reviewVisibleChanges = createMemo(() => {
		const query = reviewSearchQuery().toLowerCase();
		if (!query) return reviewChanges();
		return reviewChanges().filter((change) =>
			[change.newPath, change.oldPath].some((path) =>
				path?.toLowerCase().includes(query),
			),
		);
	});
	const reviewFile = () => reviewVisibleChanges()[reviewChangeIndex()];
	const reviewChangeForView = (change: LocalChange, diff = "") => ({
		old_path: change.oldPath ?? change.newPath,
		new_path: change.newPath,
		a_mode: "100644",
		b_mode: "100644",
		new_file: change.newFile,
		renamed_file: change.renamedFile,
		deleted_file: change.deletedFile,
		diff,
		lines_added: change.linesAdded,
		lines_deleted: change.linesDeleted,
		review_finding_count: reviewFindings().filter(
			(finding) =>
				finding.path === change.newPath || finding.path === change.oldPath,
		).length,
	});
	const reviewChangesForView = createMemo(() =>
		reviewVisibleChanges().map((change) => reviewChangeForView(change)),
	);
	// Lines available to the embedded ChangedFilesView list inside the popup:
	// GenericModal chrome (padding top/bottom + title + help footer) = 4,
	// ChangedFilesView chrome (stats header 2 + table header 1) = 3.
	// Mirrors GenericModal's own height calc (Math.floor(height * 0.75)).
	const reviewFilesAvailableLines = () =>
		Math.max(
			1,
			Math.min(dimensions().height, Math.floor(dimensions().height * 0.75)) -
				4 -
				3,
		);
	const reviewDiffFile = createMemo(() => {
		const file = reviewFile();
		return file ? reviewChangeForView(file, reviewDiff()) : undefined;
	});
	const reviewDiscussions = createMemo<Discussion[]>(() => [
		...reviewComments().map((comment, index) => {
			const position = {
				base_sha: "",
				start_sha: "",
				head_sha: "",
				old_path: comment.filePath,
				new_path: comment.filePath,
				position_type: "text",
				new_line: comment.line,
			};
			const note = {
				id: index + 1,
				type: "DiffNote",
				body: comment.body,
				author: {
					id: 0,
					username: "developer",
					name: "Developer",
					avatar_url: "",
				},
				created_at: new Date().toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
				position,
			};
			return {
				id: `local-${index}`,
				individual_note: true,
				notes: [note],
				position,
			};
		}),
		...reviewFindings()
			.filter((finding) => finding.path)
			.map((finding) => {
				const position = {
					base_sha: "",
					start_sha: "",
					head_sha: "",
					old_path: finding.path ?? "",
					new_path: finding.path ?? "",
					position_type: "text",
					new_line: finding.line ?? 1, // legacy artifacts may lack a line
				};
				const note = {
					id: 10000 + reviewFindings().indexOf(finding),
					type: "DiffNote",
					body: `${finding.detail}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
					author: {
						id: 0,
						username: "verifier",
						name: "Verifier",
						avatar_url: "",
					},
					created_at: new Date().toISOString(),
					updated_at: "",
					system: false,
					resolvable: false,
					resolved: selectedReviewFindingIds().has(finding.id),
					position,
				};
				return {
					id: `finding-${finding.id}`,
					individual_note: true,
					notes: [note],
					position,
					findingId: finding.originalId,
					findingSeverity: finding.severity,
				};
			}),
	]);
	const currentReviewDiscussions = createMemo(() => {
		const file = reviewFile()?.newPath;
		if (!file) return [];
		return reviewDiscussions().filter((discussion) => {
			const position = discussion.position ?? discussion.notes?.[0]?.position;
			return (
				!position || position.new_path === file || position.old_path === file
			);
		});
	});
	const cycleReviewComments = (direction: 1 | -1) => {
		const lines = reviewDiscussionLineIndices();
		if (!lines.length) return;
		const current = reviewLine();
		const next =
			direction > 0
				? (lines.find((line) => line > current) ?? lines[0])
				: ([...lines].reverse().find((line) => line < current) ?? lines.at(-1));
		if (next !== undefined) setReviewLine(next);
	};
	const openDeveloperReview = async () => {
		if (reviewLoading()) return;
		setReviewLoading(true);
		setMessage("Loading developer review…");
		const generation = ++reviewGeneration;
		reviewController?.abort();
		reviewController = new AbortController();
		try {
			const changes =
				profile === "test"
					? [
							{
								newPath: "src/example.ts",
								linesAdded: 3,
								linesDeleted: 1,
								newFile: false,
								deletedFile: false,
								renamedFile: false,
							},
						]
					: await loadLocalChangesAsync(
							repo,
							workflowId,
							reviewController.signal,
						);
			if (generation !== reviewGeneration) return;
			const findings =
				profile === "test"
					? [
							{
								id: "demo-run:demo-warning",
								originalId: "demo-warning",
								severity: "warning" as const,
								path: "src/example.ts",
								line: 2,
								detail: "Prefer const for immutable value.",
								fix: "Use const.",
							},
						]
					: loadDeveloperReviewFindings(repo, workflowId);
			setReviewChanges(changes);
			setReviewChangeIndex(0);
			setReviewLine(0);
			setReviewComments([]);
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewSourceRange({});
			setReviewDiscussionLineIndices([]);
			setReviewSelectableLineCount(0);
			setReviewSelectedLineFindingIds([]);
			setReviewSearchMode(false);
			setReviewSearchQuery("");
			setReviewSplitView(null);
			setReviewFindings(findings);
			setSelectedReviewFindingIds(new Set<string>());
			setReviewView("files");
			setReviewOpen(true);
			setReviewKind("developer");
			queueMicrotask(() => setModalActive("developer-review"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			if (generation === reviewGeneration) {
				setReviewLoading(false);
				reviewController = undefined;
			}
		}
	};
	const openReviewDiff = async () => {
		const file = reviewVisibleChanges()[reviewChangeIndex()];
		if (!file) return;
		reviewDiffController?.abort();
		reviewDiffController = new AbortController();
		try {
			setReviewDiff(
				profile === "test"
					? "diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,4 @@\n const value = 1;\n-old();\n+new();\n+reviewed();\n"
					: await loadLocalDiffAsync(
							repo,
							workflowId,
							file,
							reviewDiffController.signal,
						),
			);
			setReviewLine(0);
			setReviewView("diff");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const developerReviewPhase = () =>
		requiredUserAction()?.key === "developer-review";
	const finishDeveloperReview = async () => {
		if (busy()) return;
		// Finishing dispatches the workflow gate, so it is only meaningful while
		// the workflow actually waits in the developer review phase.
		if (!developerReviewPhase()) {
			notify(
				"Developer review can only be finished during the developer review phase",
				"warning",
			);
			return;
		}
		setBusy(true);
		setMessage("Finishing developer review…");
		setReviewFinishing(true);
		setReviewFinishingMessage(
			"Saving comments and dispatching developer review…",
		);
		try {
			// Yield one macrotask so the progress overlay paints before any
			// synchronous save/dispatch work begins.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const findingComments: DeveloperReviewComment[] = reviewFindings()
				.filter((finding) => selectedReviewFindingIds().has(finding.id))
				.map((finding) => ({
					filePath: finding.path ?? "repository",
					line: finding.line ?? 1,
					body: `${finding.detail}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
					findingId: finding.originalId,
				}));
			const comments = [...reviewComments(), ...findingComments];
			if (profile !== "test") {
				await saveDeveloperReview(repo, workflowId, comments);
				const engineComments = reviewCommentsForEngine(comments, true);
				setMessage(
					await runWorkflow(
						comments.length ? "review-comments" : "approve-review",
						repo,
						workflowId,
						data().state.revision,
						comments.length
							? JSON.stringify({ comments: engineComments })
							: undefined,
					),
				);
				refresh();
			} else {
				setMessage(
					comments.length
						? "Review comments sent to worker"
						: "Developer review passed",
				);
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReviewView("files");
			setReviewOpen(false);
			setModalActive("none");
			setBusy(false);
			setReviewFinishing(false);
		}
	};
	const demoPlanArtifacts = () => [
		{
			newPath: "proposal.md",
			linesAdded: 4,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "design.md",
			linesAdded: 6,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "tasks.md",
			linesAdded: 5,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "specs/workflow-engine-runtime/spec.md",
			linesAdded: 8,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
	];
	const demoPlanContent = (artifact: string) => {
		const demo = {
			"proposal.md":
				"# Proposal\n\nMake the plan review modal-based.\n\n## What changes\n- Artifact list popup.\n- Markdown review modal.",
			"design.md":
				"# Design\n\n## Context\n\nMirror the developer review gate.\n\n## Decisions\n\nD1: Engine comments outcome.\n\nD2: Planner review-fix mode.",
			"tasks.md":
				"# Tasks\n\n- [ ] Engine routing\n- [ ] Markdown modal\n- [ ] Planner instruction",
			"specs/workflow-engine-runtime/spec.md":
				"# Workflow engine runtime\n\n## ADDED Requirements\n\n### Requirement: Review comments route to the planner\n\nThe plan gate SHALL accept bounded review comments.\n\n#### Scenario: Comments return to planning\n\nWHEN the developer dispatches review-comments.\n\nTHEN the workflow transitions to planning with feedback.",
		} as Record<string, string>;
		return demo[artifact] ?? `# ${artifact}\n\nDemo artifact content.`;
	};
	const openPlanReview = async () => {
		const generation = ++reviewGeneration;
		reviewDiffController?.abort();
		reviewDiffController = new AbortController();
		try {
			const wikiReview = requiredUserAction()?.key === "wiki-review";
			const changes: LocalChange[] = wikiReview
				? await loadWikiSnapshotChangesAsync(
						repo,
						workflowId,
						reviewDiffController.signal,
					)
				: profile === "test"
					? demoPlanArtifacts()
					: await Promise.all(
							artifacts()
								.slice(0, 200)
								.map(async (artifact) => {
									let linesAdded = 0;
									try {
										linesAdded = (
											await openSpecArtifactAsync(
												data().state,
												artifact,
												reviewDiffController?.signal,
											)
										).split(/\r?\n/).length;
									} catch {
										/* line count falls back to 0 when the artifact is unreadable */
									}
									return {
										newPath: artifact,
										linesAdded,
										linesDeleted: 0,
										newFile: true,
										deletedFile: false,
										renamedFile: false,
									};
								}),
						);
			if (generation !== reviewGeneration) return;
			setReviewKind(wikiReview ? "wiki" : "plan");
			setReviewChanges(changes);
			setReviewChangeIndex(0);
			setReviewLine(0);
			setReviewDiff("");
			setReviewComments([]);
			setReviewFindings([]);
			setSelectedReviewFindingIds(new Set<string>());
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewSourceRange({});
			setReviewDiscussionLineIndices([]);
			setReviewSelectableLineCount(0);
			setReviewSelectedLineFindingIds([]);
			setReviewSearchMode(false);
			setReviewSearchQuery("");
			setReviewSplitView(null);
			setReviewView("files");
			setReviewOpen(true);
			queueMicrotask(() => setModalActive("plan-review"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const openPlanMarkdown = async () => {
		const file = reviewVisibleChanges()[reviewChangeIndex()];
		if (!file) return;
		reviewDiffController?.abort();
		reviewDiffController = new AbortController();
		try {
			const content =
				reviewKind() === "wiki"
					? await loadWikiSnapshotDiffAsync(repo, workflowId, file)
					: profile === "test"
						? demoPlanContent(file.newPath)
						: await openSpecArtifactAsync(
								data().state,
								file.newPath,
								reviewDiffController?.signal,
							);
			setReviewDiff(content);
			setReviewLine(0);
			setReviewView("diff");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const navigateReviewFile = async (direction: 1 | -1) => {
		const previous = reviewChangeIndex();
		const total = reviewVisibleChanges().length;
		if (!total) return;
		const next = (previous + direction + total) % total;
		const file = reviewVisibleChanges()[next];
		if (!file) return;
		reviewDiffController?.abort();
		reviewDiffController = new AbortController();
		try {
			const content =
				reviewKind() === "wiki"
					? await loadWikiSnapshotDiffAsync(
							repo,
							workflowId,
							file,
							reviewDiffController.signal,
						)
					: reviewKind() === "plan"
						? profile === "test"
							? demoPlanContent(file.newPath)
							: await openSpecArtifactAsync(
									data().state,
									file.newPath,
									reviewDiffController.signal,
								)
						: profile === "test"
							? "diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,4 @@\n const value = 1;\n-old();\n+new();\n+reviewed();\n"
							: await loadLocalDiffAsync(
									repo,
									workflowId,
									file,
									reviewDiffController.signal,
								);
			setReviewChangeIndex(next);
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewLine(0);
			setReviewDiff(content);
		} catch (error) {
			setReviewChangeIndex(previous);
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const navigatePlanMarkdownFile = async (direction: 1 | -1) => {
		const previous = reviewChangeIndex();
		reviewDiffController?.abort();
		reviewDiffController = new AbortController();
		try {
			const total = reviewVisibleChanges().length;
			if (!total) return;
			const next = (previous + direction + total) % total;
			const file = reviewVisibleChanges()[next];
			if (!file) return;
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewLine(0);
			setReviewDiff(
				reviewKind() === "wiki"
					? await loadWikiSnapshotDiffAsync(
							repo,
							workflowId,
							file,
							reviewDiffController?.signal,
						)
					: profile === "test"
						? demoPlanContent(file.newPath)
						: await openSpecArtifactAsync(
								data().state,
								file.newPath,
								reviewDiffController?.signal,
							),
			);
			setReviewChangeIndex(next);
		} catch (error) {
			setReviewChangeIndex(previous);
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const finishPlanReview = async () => {
		if (busy()) return;
		const wikiReview = requiredUserAction()?.key === "wiki-review";
		const saveReview = wikiReview ? saveWikiReview : savePlanReview;
		setBusy(true);
		setMessage(
			wikiReview ? "Finishing wiki review…" : "Finishing plan review…",
		);
		setReviewFinishing(true);
		setReviewFinishingMessage(
			wikiReview
				? "Saving comments and dispatching wiki review…"
				: "Saving comments and dispatching plan review…",
		);
		try {
			// Yield one macrotask so the progress overlay paints before any
			// synchronous save/dispatch work begins.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const comments = reviewComments();
			if (profile !== "test") {
				await saveReview(repo, workflowId, comments);
				const engineComments = reviewCommentsForEngine(comments);
				setMessage(
					await runWorkflow(
						comments.length
							? "review-comments"
							: wikiReview
								? "approve-wiki"
								: "approve-plan",
						repo,
						workflowId,
						data().state.revision,
						comments.length
							? JSON.stringify({ comments: engineComments })
							: undefined,
					),
				);
				refresh();
			} else {
				if (comments.length) {
					setMessage("Plan review comments sent to planner");
				} else {
					setDemoIndex((index) => (index + 1) % demoPhases.length);
					setMessage("Plan approved");
				}
				refresh();
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReviewView("files");
			setReviewOpen(false);
			setModalActive("none");
			setBusy(false);
			setReviewFinishing(false);
		}
	};
	const openPlanRejection = () => {
		setPlanRejectionSelection(0);
		setPlanRejectionOpen(true);
		queueMicrotask(() => setModalActive("plan-rejection"));
	};
	const rejectPlan = async (reason: string) => {
		if (busy()) return;
		setBusy(true);
		setMessage("Rejecting plan…");
		try {
			if (profile === "test") setMessage("Plan rejected");
			else {
				await runWorkflow(
					"reject-plan",
					repo,
					workflowId,
					data().state.revision,
					JSON.stringify({ reason }),
				);
				refresh();
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setPlanRejectionOpen(false);
			setReviewOpen(false);
			setModalActive("none");
			setBusy(false);
		}
	};
	const handleReviewKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		if (reviewView() === "files" && reviewSearchMode()) {
			if (key === "escape") {
				setReviewSearchMode(false);
				setReviewSearchQuery("");
				setReviewChangeIndex(0);
			} else if (key === "enter" || key === "return") {
				setReviewSearchMode(false);
			} else if (key === "backspace" || key === "delete") {
				setReviewSearchQuery((query) => query.slice(0, -1));
				setReviewChangeIndex(0);
			} else if (
				event.sequence &&
				event.sequence.length === 1 &&
				event.sequence >= " "
			) {
				setReviewSearchQuery((query) => query + event.sequence);
				setReviewChangeIndex(0);
			}
			return true;
		}
		if (key === "escape") {
			if (reviewView() === "diff") {
				setReviewVisualMode(false);
				setReviewView("files");
			} else if (reviewSearchQuery()) {
				setReviewSearchQuery("");
				setReviewSearchMode(false);
				setReviewChangeIndex(0);
			} else {
				setReviewOpen(false);
				setModalActive("none");
			}
		} else if (
			key === "r" &&
			reviewKind() === "plan" &&
			reviewView() === "files"
		) {
			openPlanRejection();
		} else if (key === "f" && !event.shift) {
			if (reviewKind() === "plan" || reviewKind() === "wiki")
				void finishPlanReview();
			else void finishDeveloperReview();
		} else if (
			reviewView() === "files" &&
			(key === "/" || event.sequence === "/")
		) {
			setReviewSearchMode(true);
			setReviewSearchQuery("");
			setReviewChangeIndex(0);
		} else if (reviewView() === "files" && (key === "j" || key === "down"))
			setReviewChangeIndex((index) =>
				Math.min(Math.max(0, reviewVisibleChanges().length - 1), index + 1),
			);
		else if (reviewView() === "files" && (key === "k" || key === "up"))
			setReviewChangeIndex((index) => Math.max(0, index - 1));
		else if (
			reviewView() === "files" &&
			(key === "enter" || key === "return")
		) {
			if (reviewKind() === "plan" || reviewKind() === "wiki")
				openPlanMarkdown();
			else openReviewDiff();
		} else if (reviewView() === "diff" && key === "v") {
			if (reviewVisualMode()) setReviewVisualMode(false);
			else {
				setReviewVisualStart(reviewLine());
				setReviewVisualMode(true);
			}
		} else if (reviewView() === "diff" && key === "n")
			cycleReviewComments(event.shift ? -1 : 1);
		else if (reviewView() === "diff" && (key === "[" || key === "]"))
			navigateReviewFile(key === "]" ? 1 : -1);
		else if (
			reviewView() === "diff" &&
			key === "s" &&
			(reviewKind() === "developer" || reviewKind() === "wiki")
		)
			setReviewSplitView((split) =>
				split === null ? dimensions().width < 160 : !split,
			);
		else if (reviewView() === "diff" && (key === "j" || key === "down"))
			setReviewLine((line) =>
				Math.min(Math.max(0, reviewSelectableLineCount() - 1), line + 1),
			);
		else if (reviewView() === "diff" && (key === "k" || key === "up"))
			setReviewLine((line) => Math.max(0, line - 1));
		else if (
			reviewView() === "diff" &&
			(key === "space" || key === " ") &&
			reviewKind() === "developer"
		) {
			const ids = reviewSelectedLineFindingIds();
			if (ids.length)
				setSelectedReviewFindingIds((selected) => {
					const next = new Set(selected);
					const select = ids.some((id) => !next.has(id));
					for (const id of ids) {
						if (select) next.add(id);
						else next.delete(id);
					}
					return next;
				});
		} else if (reviewView() === "diff" && key === "c") {
			const selectedRange = reviewSourceRange();
			if (
				reviewKind() === "wiki" &&
				(selectedRange.start === undefined || selectedRange.end === undefined)
			) {
				notify(
					"Snapshot context is not commentable; select a current document line",
					"warning",
				);
				return true;
			}
			setReviewCommentText("");
			setReviewCommentMode(true);
			setModalActive("review-comment");
		}
		return true;
	};

	return {
		reviewOpen,
		setReviewOpen,
		reviewKind,
		setReviewKind,
		reviewView,
		setReviewView,
		reviewLoading,
		setReviewLoading,
		reviewChanges,
		setReviewChanges,
		reviewChangeIndex,
		setReviewChangeIndex,
		reviewLine,
		setReviewLine,
		reviewDiff,
		setReviewDiff,
		reviewComments,
		setReviewComments,
		reviewFindings,
		setReviewFindings,
		selectedReviewFindingIds,
		setSelectedReviewFindingIds,
		reviewCommentMode,
		setReviewCommentMode,
		reviewCommentText,
		setReviewCommentText,
		reviewVisualMode,
		setReviewVisualMode,
		reviewVisualStart,
		setReviewVisualStart,
		reviewSourceRange,
		setReviewSourceRange,
		reviewDiscussionLineIndices,
		setReviewDiscussionLineIndices,
		reviewSelectableLineCount,
		setReviewSelectableLineCount,
		reviewSelectedLineFindingIds,
		setReviewSelectedLineFindingIds,
		reviewSearchMode,
		setReviewSearchMode,
		reviewSearchQuery,
		setReviewSearchQuery,
		reviewSplitView,
		setReviewSplitView,
		planRejectionReasons,
		planRejectionOpen,
		setPlanRejectionOpen,
		planRejectionSelection,
		setPlanRejectionSelection,
		reviewVisibleChanges,
		reviewFile,
		reviewChangeForView,
		reviewChangesForView,
		reviewFilesAvailableLines,
		reviewDiffFile,
		reviewDiscussions,
		currentReviewDiscussions,
		cycleReviewComments,
		developerReviewPhase,
		openDeveloperReview,
		openReviewDiff,
		finishDeveloperReview,
		openPlanReview,
		openPlanMarkdown,
		navigateReviewFile,
		navigatePlanMarkdownFile,
		finishPlanReview,
		openPlanRejection,
		rejectPlan,
		handleReviewKey,
		reviewDiffSignal: () => reviewDiffController?.signal,
		dispose: () => {
			reviewGeneration++;
			reviewController?.abort();
			reviewDiffController?.abort();
		},
	};
}
