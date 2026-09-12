import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal } from "solid-js";

export const CR_DETAIL_PANEL_COUNT = 7;

import type {
	ChangeRequest,
	ChangeRequestChange,
	Discussion,
	Issue,
	Job,
	TestCase,
	TestSummary,
} from "@devenv/types";

type ListControlTarget = "changedFiles" | "jobs" | "tests";
type SortDirection = "asc" | "desc" | "none";
interface SortRule {
	key: string;
	label: string;
	direction: SortDirection;
}

const dirtyChangeType = (change: ChangeRequestChange) =>
	change.deleted_file
		? "deleted"
		: change.renamed_file
			? "renamed"
			: change.new_file
				? "added"
				: "modified";

export function createChangeRequestStore() {
	const [changeRequests, setChangeRequests] = createSignal<ChangeRequest[]>([]);
	const [crLoading, setCrLoading] = createSignal(false);
	const [crError, setCrError] = createSignal("");

	// Pagination state
	const [currentPage, setCurrentPage] = createSignal(1);
	const [totalPages, setTotalPages] = createSignal(0);
	const [totalCount, setTotalCount] = createSignal(0);
	const [perPage, setPerPage] = createSignal(50);

	// Active server-side search term (set when user presses Enter in search mode)
	const [searchTerm, setSearchTerm] = createSignal("");
	const [selectedChangeRequest, setSelectedCR] =
		createSignal<ChangeRequest | null>(null);
	const [selectedChangeRequestIndex, setSelectedCRIndex] = createSignal(0);
	const [crChanges, setCrChanges] = createSignal<ChangeRequestChange[]>([]);
	const [crChangesLoading, setCrChangesLoading] = createSignal(false);
	const [crChangesError, setCrChangesError] = createSignal("");
	const [crTestSummary, setCrTestSummary] = createSignal<TestSummary | null>(
		null,
	);
	const [crTestLoading, setCrTestLoading] = createSignal(false);
	const [crTestError, setCrTestError] = createSignal("");
	const [crJobsForDetail, setCrJobsForDetail] = createSignal<Job[]>([]);
	const [crJobsForDetailLoading, setCrJobsForDetailLoading] =
		createSignal(false);
	const [crJobsForDetailError, setCrJobsForDetailError] = createSignal("");
	const [changeRequestLinkedIssues, setCrLinkedIssues] = createSignal<Issue[]>(
		[],
	);
	const [changeRequestLinkedIssuesLoading, setCrLinkedIssuesLoading] =
		createSignal(false);
	const [changeRequestLinkedIssuesError, setCrLinkedIssuesError] =
		createSignal("");
	const [selectedChangeRequestLinkedIssueIndex, setSelectedCrLinkedIssueIndex] =
		createSignal(0);
	const [crDiscussions, setCrDiscussions] = createSignal<Discussion[]>([]);
	const [crDiscussionsLoading, setCrDiscussionsLoading] = createSignal(false);
	const [crDiscussionsError, setCrDiscussionsError] = createSignal("");
	const [jobs, setJobs] = createSignal<Job[]>([]);
	const [jobsLoading, setJobsLoading] = createSignal(false);
	const [jobsError, setJobsError] = createSignal("");
	const [currentPipelineId, setCurrentPipelineId] = createSignal<number | null>(
		null,
	);
	const [selectedJobStageIndex, setSelectedJobStageIndex] = createSignal(0);
	const [selectedJobIndex, setSelectedJobIndex] = createSignal(0);
	const [selectedTestIndex, setSelectedTestIndex] = createSignal(0);
	const [showTestDetailModal, setShowTestDetailModal] = createSignal(false);
	const [testDetailCopyStatus, setTestDetailCopyStatus] = createSignal<
		string | null
	>(null);
	const [selectedChangedFileIndex, setSelectedChangedFileIndex] =
		createSignal(0);
	const [selectedDiscussionIndex, setSelectedDiscussionIndex] = createSignal(0);
	const [showDiffModal, setShowDiffModal] = createSignal(false);
	const [currentDiffFile, setCurrentDiffFile] =
		createSignal<ChangeRequestChange | null>(null);
	const [diffModalSelectedLine, setDiffModalSelectedLine] = createSignal(0);
	const [diffModalVisualMode, setDiffModalVisualMode] = createSignal(false);
	const [diffModalVisualStart, setDiffModalVisualStart] = createSignal(0);
	const [diffModalForceSplitView, setDiffModalForceSplitView] =
		createSignal<boolean>(false);
	const [showCommentModal, setShowCommentModal] = createSignal(false);
	const [commentText, setCommentText] = createSignal("");
	const [commentSubmitting, setCommentSubmitting] = createSignal(false);
	const [replyMode, setReplyMode] = createSignal<string | null>(null);
	const [replyText, setReplyText] = createSignal("");
	const [collapsedThreads, setCollapsedThreads] = createSignal<Set<string>>(
		new Set(),
	);
	const [discussionsShowOnlyComments, setDiscussionsShowOnlyComments] =
		createSignal(false);
	const [crSearchMode, setCrSearchMode] = createSignal(false);
	const [crSearchQuery, setCrSearchQuery] = createSignal("");
	const [crListFilters, setCrListFilters] = createSignal<
		Record<string, string[]>
	>({ state: ["opened"] });
	const [crListFilterParameterIndex, setCrListFilterParameterIndex] =
		createSignal(0);
	const [crListFilterValueIndex, setCrListFilterValueIndex] = createSignal(0);
	const [crListFilterFocusedPane, setCrListFilterFocusedPane] = createSignal<
		"parameter" | "value"
	>("parameter");
	const [showCrListFilterModal, setShowCrListFilterModal] = createSignal(false);
	const [showCrListSortModal, setShowCrListSortModal] = createSignal(false);
	const [crListSortSelectedIndex, setCrListSortSelectedIndex] = createSignal(0);
	const [crListSortRules, setCrListSortRules] = createSignal<SortRule[]>([
		{ key: "updated", label: "Updated", direction: "desc" },
		{ key: "created", label: "Created", direction: "none" },
		{ key: "title", label: "Title", direction: "none" },
	]);
	const [changedFilesSearchMode, setChangedFilesSearchMode] =
		createSignal(false);
	const [changedFilesSearchQuery, setChangedFilesSearchQuery] =
		createSignal("");
	const [testSearchMode, setTestSearchMode] = createSignal(false);
	const [testSearchQuery, setTestSearchQuery] = createSignal("");
	const [jobsSearchMode, setJobsSearchMode] = createSignal(false);
	const [jobsSearchQuery, setJobsSearchQuery] = createSignal("");
	const [listControlTarget, setListControlTarget] =
		createSignal<ListControlTarget | null>(null);
	const [showListFilterModal, setShowListFilterModal] = createSignal(false);
	const [showListSortModal, setShowListSortModal] = createSignal(false);
	const [listFilterParameterIndex, setListFilterParameterIndex] =
		createSignal(0);
	const [listFilterValueIndex, setListFilterValueIndex] = createSignal(0);
	const [listFilterFocusedPane, setListFilterFocusedPane] = createSignal<
		"parameter" | "value"
	>("parameter");
	const [listFilters, setListFilters] = createSignal<
		Record<ListControlTarget, Record<string, string[]>>
	>({ changedFiles: {}, jobs: {}, tests: {} });
	const [listSortSelectedIndex, setListSortSelectedIndex] = createSignal(0);
	const [listSortRules, setListSortRules] = createSignal<
		Record<ListControlTarget, SortRule[]>
	>({
		changedFiles: [
			{ key: "type", label: "Type", direction: "asc" },
			{ key: "path", label: "Path", direction: "none" },
			{ key: "size", label: "Size", direction: "none" },
		],
		jobs: [
			{ key: "status", label: "Status", direction: "asc" },
			{ key: "stage", label: "Stage", direction: "none" },
			{ key: "name", label: "Name", direction: "none" },
		],
		tests: [
			{ key: "status", label: "Status", direction: "asc" },
			{ key: "class", label: "Class", direction: "none" },
			{ key: "name", label: "Name", direction: "none" },
		],
	});

	// Panel focus navigation state
	const [crDetailPanelIndex, setCrDetailPanelIndex] = createSignal(0);
	const crDetailScrollBoxRefs: (ScrollBoxRenderable | undefined)[] = [];

	// CR AI review overlay state
	const [crAiVisible, setCrAiVisible] = createSignal(false);
	const [crAiLoading, setCrAiLoading] = createSignal(false);
	const [crAiStreaming, setCrAiStreaming] = createSignal(false);
	const [crAiSummary, setCrAiSummary] = createSignal<string | null>(null);
	const [crAiError, setCrAiError] = createSignal<string | null>(null);
	const [crAiFollowupText, setCrAiFollowupText] = createSignal("");
	const [crAiPostingComments, setCrAiPostingComments] = createSignal(false);
	const [crAiCommentsPosted, setCrAiCommentsPosted] = createSignal(false);

	let crAiScrollBoxRef: import("@opentui/core").ScrollBoxRenderable | undefined;
	let diffModalScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;
	let crAiAtBottom = true;
	let crAiLastScrollTop = 0;

	const currentListFilters = createMemo(
		() => listFilters()[listControlTarget() ?? "changedFiles"],
	);
	const crListFilterParameters = createMemo(() => {
		const stateValues = [
			{ value: "opened", label: "opened" },
			{ value: "merged", label: "merged" },
			{ value: "closed", label: "closed" },
			{ value: "all", label: "all" },
		];
		return [{ key: "state", label: "State", values: stateValues }];
	});
	const activeCrListSort = createMemo(() =>
		crListSortRules().find((rule) => rule.direction !== "none"),
	);
	const currentListSortRules = createMemo(
		() => listSortRules()[listControlTarget() ?? "changedFiles"],
	);
	const setCurrentListFilters = (
		value:
			| Record<string, string[]>
			| ((filters: Record<string, string[]>) => Record<string, string[]>),
	) => {
		const target = listControlTarget();
		if (!target) return;
		setListFilters((all) => ({
			...all,
			[target]: typeof value === "function" ? value(all[target]) : value,
		}));
	};
	const setCurrentListSortRules = (
		value: SortRule[] | ((rules: SortRule[]) => SortRule[]),
	) => {
		const target = listControlTarget();
		if (!target) return;
		setListSortRules((all) => ({
			...all,
			[target]: typeof value === "function" ? value(all[target]) : value,
		}));
	};
	const applyFilters = <T>(
		items: T[],
		target: ListControlTarget,
		valueFor: (item: T, key: string) => string,
	) => {
		const filters = listFilters()[target];
		return items.filter((item) =>
			Object.entries(filters).every(
				([key, values]) =>
					values.length === 0 || values.includes(valueFor(item, key)),
			),
		);
	};
	const applySort = <T>(
		items: T[],
		target: ListControlTarget,
		compare: (a: T, b: T, key: string) => number,
	) => {
		const rules = listSortRules()[target].filter((r) => r.direction !== "none");
		return items
			.map((item, index) => ({ item, index }))
			.sort((a, b) => {
				for (const rule of rules) {
					const result = compare(a.item, b.item, rule.key);
					if (result !== 0) return rule.direction === "desc" ? -result : result;
				}
				return a.index - b.index;
			})
			.map(({ item }) => item);
	};

	const changedFileValue = (c: ChangeRequestChange, key: string) =>
		key === "type"
			? dirtyChangeType(c)
			: key === "path"
				? c.new_path || c.old_path
				: String((c.lines_added ?? 0) + (c.lines_deleted ?? 0));
	const changedFilesFiltered = createMemo(() => {
		const q = changedFilesSearchQuery().toLowerCase();
		const searched = q
			? crChanges().filter((c) =>
					[c.new_path, c.old_path].some((v) => v?.toLowerCase().includes(q)),
				)
			: crChanges();
		return applySort(
			applyFilters(searched, "changedFiles", changedFileValue),
			"changedFiles",
			(a, b, key) =>
				key === "size"
					? (a.lines_added ?? 0) +
						(a.lines_deleted ?? 0) -
						((b.lines_added ?? 0) + (b.lines_deleted ?? 0))
					: changedFileValue(a, key).localeCompare(changedFileValue(b, key)),
		);
	});

	const testValue = (t: TestCase & { suiteName?: string }, key: string) =>
		key === "status" ? t.status : key === "class" ? t.classname : t.name;
	const jobsValue = (j: Job, key: string) =>
		key === "status" ? j.status : key === "stage" ? j.stage : j.name;
	const listFilterParameters = createMemo(() => {
		const target = listControlTarget();
		if (!target) return [];
		const source =
			target === "changedFiles"
				? applyFilters(
						changedFilesSearchQuery().toLowerCase()
							? crChanges().filter((c) =>
									[c.new_path, c.old_path].some((v) =>
										v
											?.toLowerCase()
											.includes(changedFilesSearchQuery().toLowerCase()),
									),
								)
							: crChanges(),
						"changedFiles",
						changedFileValue,
					)
				: target === "jobs"
					? jobs()
					: (crTestSummary()?.test_suites ?? []).flatMap((s) =>
							s.test_cases.map((t) => ({ ...t, suiteName: s.name })),
						);
		const rules = listSortRules()[target];
		return rules.map((rule) => {
			const counts = new Map<string, number>();
			for (const item of source as ReadonlyArray<unknown>) {
				const value =
					target === "changedFiles"
						? changedFileValue(item as ChangeRequestChange, rule.key)
						: target === "jobs"
							? jobsValue(item as Job, rule.key)
							: testValue(item as TestCase & { suiteName?: string }, rule.key);
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			return {
				key: rule.key,
				label: rule.label,
				values: Array.from(counts.entries()).map(([value, count]) => ({
					value,
					label: value,
					count,
				})),
			};
		});
	});

	const sortedTestsForDetail = createMemo(() => {
		const testSuites = crTestSummary()?.test_suites || [];
		const allTests: Array<TestCase & { suiteName: string }> = [];
		for (const suite of testSuites) {
			for (const testCase of suite.test_cases) {
				allTests.push({ ...testCase, suiteName: suite.name });
			}
		}
		allTests.sort((a, b) => {
			const aIsFailed = a.status === "failed" || a.status === "error";
			const bIsFailed = b.status === "failed" || b.status === "error";
			if (aIsFailed && !bIsFailed) return -1;
			if (!aIsFailed && bIsFailed) return 1;
			const classCompare = a.classname.localeCompare(b.classname);
			if (classCompare !== 0) return classCompare;
			return a.name.localeCompare(b.name);
		});
		return allTests;
	});

	const selectedTestForDetail = createMemo(
		() => sortedTestsForDetail()[selectedTestIndex()] ?? null,
	);

	return {
		changeRequests,
		setChangeRequests,
		crLoading,
		setCrLoading,
		crError,
		setCrError,
		// Pagination state
		currentPage,
		setCurrentPage,
		totalPages,
		setTotalPages,
		totalCount,
		setTotalCount,
		perPage,
		setPerPage,
		searchTerm,
		setSearchTerm,

		selectedChangeRequest,
		setSelectedCR,
		selectedChangeRequestIndex,
		setSelectedCRIndex,
		crChanges,
		setCrChanges,
		crChangesLoading,
		setCrChangesLoading,
		crChangesError,
		setCrChangesError,
		crTestSummary,
		setCrTestSummary,
		crTestLoading,
		setCrTestLoading,
		crTestError,
		setCrTestError,
		crJobsForDetail,
		setCrJobsForDetail,
		crJobsForDetailLoading,
		setCrJobsForDetailLoading,
		crJobsForDetailError,
		setCrJobsForDetailError,
		changeRequestLinkedIssues,
		setCrLinkedIssues,
		changeRequestLinkedIssuesLoading,
		setCrLinkedIssuesLoading,
		changeRequestLinkedIssuesError,
		setCrLinkedIssuesError,
		selectedChangeRequestLinkedIssueIndex,
		setSelectedCrLinkedIssueIndex,
		crDiscussions,
		setCrDiscussions,
		crDiscussionsLoading,
		setCrDiscussionsLoading,
		crDiscussionsError,
		setCrDiscussionsError,
		jobs,
		setJobs,
		jobsLoading,
		setJobsLoading,
		jobsError,
		setJobsError,
		currentPipelineId,
		setCurrentPipelineId,
		selectedJobStageIndex,
		setSelectedJobStageIndex,
		selectedJobIndex,
		setSelectedJobIndex,
		selectedTestIndex,
		setSelectedTestIndex,
		showTestDetailModal,
		setShowTestDetailModal,
		testDetailCopyStatus,
		setTestDetailCopyStatus,
		selectedChangedFileIndex,
		setSelectedChangedFileIndex,
		selectedDiscussionIndex,
		setSelectedDiscussionIndex,
		showDiffModal,
		setShowDiffModal,
		currentDiffFile,
		setCurrentDiffFile,
		diffModalSelectedLine,
		setDiffModalSelectedLine,
		diffModalVisualMode,
		setDiffModalVisualMode,
		diffModalVisualStart,
		setDiffModalVisualStart,
		diffModalForceSplitView,
		setDiffModalForceSplitView,
		showCommentModal,
		setShowCommentModal,
		commentText,
		setCommentText,
		commentSubmitting,
		setCommentSubmitting,
		replyMode,
		setReplyMode,
		replyText,
		setReplyText,
		collapsedThreads,
		setCollapsedThreads,
		discussionsShowOnlyComments,
		setDiscussionsShowOnlyComments,
		crSearchMode,
		setCrSearchMode,
		crSearchQuery,
		setCrSearchQuery,
		crListFilters,
		setCrListFilters,
		crListFilterParameters,
		crListFilterParameterIndex,
		setCrListFilterParameterIndex,
		crListFilterValueIndex,
		setCrListFilterValueIndex,
		crListFilterFocusedPane,
		setCrListFilterFocusedPane,
		showCrListFilterModal,
		setShowCrListFilterModal,
		showCrListSortModal,
		setShowCrListSortModal,
		crListSortRules,
		setCrListSortRules,
		crListSortSelectedIndex,
		setCrListSortSelectedIndex,
		activeCrListSort,
		changedFilesSearchMode,
		setChangedFilesSearchMode,
		changedFilesSearchQuery,
		setChangedFilesSearchQuery,
		testSearchMode,
		setTestSearchMode,
		testSearchQuery,
		setTestSearchQuery,
		jobsSearchMode,
		setJobsSearchMode,
		jobsSearchQuery,
		setJobsSearchQuery,
		listControlTarget,
		setListControlTarget,
		showListFilterModal,
		setShowListFilterModal,
		showListSortModal,
		setShowListSortModal,
		listFilterParameterIndex,
		setListFilterParameterIndex,
		listFilterValueIndex,
		setListFilterValueIndex,
		listFilterFocusedPane,
		setListFilterFocusedPane,
		currentListFilters,
		setCurrentListFilters,
		listFilterParameters,
		listSortSelectedIndex,
		setListSortSelectedIndex,
		currentListSortRules,
		setCurrentListSortRules,
		changedFilesFiltered,
		selectedTestForDetail,

		// Panel focus navigation
		crDetailPanelIndex,
		setCrDetailPanelIndex,
		crDetailPanelCount: CR_DETAIL_PANEL_COUNT,
		get crDetailScrollBoxRefs() {
			return crDetailScrollBoxRefs;
		},

		// CR AI review overlay
		crAiVisible,
		setCrAiVisible,
		crAiLoading,
		setCrAiLoading,
		crAiStreaming,
		setCrAiStreaming,
		crAiSummary,
		setCrAiSummary,
		crAiError,
		setCrAiError,
		crAiFollowupText,
		setCrAiFollowupText,
		crAiPostingComments,
		setCrAiPostingComments,
		crAiCommentsPosted,
		setCrAiCommentsPosted,
		get crAiScrollBoxRef() {
			return crAiScrollBoxRef;
		},
		set crAiScrollBoxRef(v:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			crAiScrollBoxRef = v;
		},
		get diffModalScrollBoxRef() {
			return diffModalScrollBoxRef;
		},
		set diffModalScrollBoxRef(v:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			diffModalScrollBoxRef = v;
		},
		get crAiAtBottom() {
			return crAiAtBottom;
		},
		set crAiAtBottom(v: boolean) {
			crAiAtBottom = v;
		},
		get crAiLastScrollTop() {
			return crAiLastScrollTop;
		},
		set crAiLastScrollTop(v: number) {
			crAiLastScrollTop = v;
		},
	};
}

export type ChangeRequestStore = ReturnType<typeof createChangeRequestStore>;
