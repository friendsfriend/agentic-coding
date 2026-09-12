import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal } from "solid-js";

export const ISSUE_DETAIL_PANEL_COUNT = 3;

import type { ChangeRequest, Issue, IssueComment } from "@devenv/types";

export type ReferenceItem =
	| { type: "cr"; data: ChangeRequest }
	| { type: "issue"; data: Issue };

type ReferenceFilterKey = "type" | "state";
type ReferenceSortKey = "type" | "state" | "updated" | "title";
type ReferenceSortDirection = "asc" | "desc" | "none";
interface ListSortRule {
	key: string;
	label: string;
	direction: ReferenceSortDirection;
}
export interface ReferenceSortRule {
	key: ReferenceSortKey;
	label: string;
	direction: ReferenceSortDirection;
}

export function createIssueStore() {
	const [issues, setIssues] = createSignal<Issue[]>([]);
	const [issueLoading, setIssueLoading] = createSignal(false);
	const [issueError, setIssueError] = createSignal("");

	// Pagination state
	const [currentPage, setCurrentPage] = createSignal(1);
	const [totalPages, setTotalPages] = createSignal(0);
	const [totalCount, setTotalCount] = createSignal(0);
	const [perPage, setPerPage] = createSignal(50);

	// Selection and search
	const [selectedIssue, setSelectedIssue] = createSignal<Issue | null>(null);
	const [selectedIssueIndex, setSelectedIssueIndex] = createSignal(0);
	const [issueSearchMode, setIssueSearchMode] = createSignal(false);
	const [issueSearchQuery, setIssueSearchQuery] = createSignal("");
	const [issueSearchTerm, setIssueSearchTerm] = createSignal("");
	const [issueListFilters, setIssueListFilters] = createSignal<
		Record<string, string[]>
	>({ state: ["open"], labels: [] });
	const [issueListFilterParameterIndex, setIssueListFilterParameterIndex] =
		createSignal(0);
	const [issueListFilterValueIndex, setIssueListFilterValueIndex] =
		createSignal(0);
	const [issueListFilterFocusedPane, setIssueListFilterFocusedPane] =
		createSignal<"parameter" | "value">("parameter");
	const [showIssueListFilterModal, setShowIssueListFilterModal] =
		createSignal(false);
	const [showIssueListSortModal, setShowIssueListSortModal] =
		createSignal(false);
	const [issueListSortSelectedIndex, setIssueListSortSelectedIndex] =
		createSignal(0);
	const [issueListSortRules, setIssueListSortRules] = createSignal<
		ListSortRule[]
	>([
		{ key: "updated", label: "Updated", direction: "desc" },
		{ key: "created", label: "Created", direction: "none" },
		{ key: "title", label: "Title", direction: "none" },
	]);

	// Detail state
	const [issueDetailLoading, setIssueDetailLoading] = createSignal(false);
	const [issueDetailError, setIssueDetailError] = createSignal("");
	let issueDetailScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;

	// Panel focus navigation
	const [issueDetailPanelIndex, setIssueDetailPanelIndex] = createSignal(0);
	const issueDetailScrollBoxRefs: (ScrollBoxRenderable | undefined)[] = [];

	// Comments
	const [issueComments, setIssueComments] = createSignal<IssueComment[]>([]);
	const [issueCommentsLoading, setIssueCommentsLoading] = createSignal(false);
	const [issueCommentsError, setIssueCommentsError] = createSignal("");

	// ─── Mutation state ─────────────────────────────────────────────────────
	const [issueSubmitting, setIssueSubmitting] = createSignal(false);
	const [issueSubmitError, setIssueSubmitError] = createSignal("");
	const [availableLabels, setAvailableLabels] = createSignal<string[]>([]);
	const [availableCollaborators, setAvailableCollaborators] = createSignal<
		string[]
	>([]);

	// Linked CRs
	const [linkedChangeRequests, setLinkedCRs] = createSignal<ChangeRequest[]>(
		[],
	);
	const [linkedChangeRequestsLoading, setLinkedCRsLoading] =
		createSignal(false);
	const [linkedChangeRequestsError, setLinkedCRsError] = createSignal("");
	const [selectedLinkedCRIndex, setSelectedLinkedCRIndex] = createSignal(0);

	// Unified References — merged list of referenced issues + linked CRs
	const [references, setReferences] = createSignal<ReferenceItem[]>([]);
	const [selectedReferenceIndex, setSelectedReferenceIndex] = createSignal(0);
	const [referenceFilters, setReferenceFilters] = createSignal<
		Record<ReferenceFilterKey, string[]>
	>({ type: [], state: [] });
	const [referenceFilterParameterIndex, setReferenceFilterParameterIndex] =
		createSignal(0);
	const [referenceFilterValueIndex, setReferenceFilterValueIndex] =
		createSignal(0);
	const [referenceFilterFocusedPane, setReferenceFilterFocusedPane] =
		createSignal<"parameter" | "value">("parameter");
	const [showReferenceFilterModal, setShowReferenceFilterModal] =
		createSignal(false);
	const [showReferenceSortModal, setShowReferenceSortModal] =
		createSignal(false);
	const [referenceSortSelectedIndex, setReferenceSortSelectedIndex] =
		createSignal(0);
	const [referenceSortRules, setReferenceSortRules] = createSignal<
		ReferenceSortRule[]
	>([
		{ key: "updated", label: "Updated", direction: "desc" },
		{ key: "type", label: "Type", direction: "none" },
		{ key: "state", label: "State", direction: "none" },
		{ key: "title", label: "Title", direction: "none" },
	]);

	// Referenced Issues
	const [referencedIssues, setReferencedIssues] = createSignal<Issue[]>([]);
	const [referencedIssuesLoading, setReferencedIssuesLoading] =
		createSignal(false);
	const [referencedIssuesError, setReferencedIssuesError] = createSignal("");
	const [selectedReferencedIssueIndex, setSelectedReferencedIssueIndex] =
		createSignal(0);

	// Timeline view state
	const [selectedTimelineIndex, setSelectedTimelineIndex] = createSignal(0);

	// Comment modal
	const [showCommentModal, setShowCommentModal] = createSignal(false);
	const [commentText, setCommentText] = createSignal("");

	// Modal visibility
	const [showLabelPicker, setShowLabelPicker] = createSignal(false);
	const [labelPickerIndex, setLabelPickerIndex] = createSignal(0);
	const [labelPickerSelectedLabels, setLabelPickerSelectedLabels] =
		createSignal<string[]>([]);
	const [assigneePickerIndex, setAssigneePickerIndex] = createSignal(0);
	const [showCloseReasonModal, setShowCloseReasonModal] = createSignal(false);
	const [closeReasonIndex, setCloseReasonIndex] = createSignal(0);
	const [showAssigneePicker, setShowAssigneePicker] = createSignal(false);

	const issuesFiltered = createMemo(() => {
		const q = issueSearchQuery().toLowerCase();
		if (!q) return issues();
		return issues().filter(
			(i) => i.title.toLowerCase().includes(q) || i.iid.toString().includes(q),
		);
	});

	const issueListFilterParameters = createMemo(() => {
		const stateValues = [
			{ value: "open", label: "open" },
			{ value: "closed", label: "closed" },
			{ value: "all", label: "all" },
		];
		const scopeValues = [
			{ value: "all", label: "All issues" },
			{ value: "created-by-me", label: "Created by me" },
			{ value: "assigned-to-me", label: "Assigned to me" },
			{ value: "no-assignee", label: "No assignee" },
		];
		const labelCounts = new Map<string, number>();
		for (const issue of issues()) {
			for (const label of issue.labels ?? [])
				labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
		}
		return [
			{ key: "state", label: "State", values: stateValues },
			{ key: "scope", label: "Scope", values: scopeValues },
			{
				key: "labels",
				label: "Labels",
				values: Array.from(labelCounts.entries()).map(([value, count]) => ({
					value,
					label: value,
					count,
				})),
			},
		];
	});
	const activeIssueListSort = createMemo(() =>
		issueListSortRules().find((rule) => rule.direction !== "none"),
	);

	const referenceFilterParameters = createMemo(() => {
		const counts = (key: ReferenceFilterKey) => {
			const map = new Map<string, number>();
			for (const ref of references()) {
				const value = key === "type" ? ref.type : ref.data.state;
				map.set(value, (map.get(value) ?? 0) + 1);
			}
			return Array.from(map.entries()).map(([value, count]) => ({
				value,
				label:
					value === "cr"
						? "Change requests"
						: value === "issue"
							? "Issues"
							: value,
				count,
			}));
		};
		return [
			{ key: "type", label: "Type", values: counts("type") },
			{ key: "state", label: "State", values: counts("state") },
		];
	});

	const referencesFiltered = createMemo(() => {
		const active = referenceFilters();
		const filtered = references().filter((ref) => {
			const typeFilters = active.type ?? [];
			const stateFilters = active.state ?? [];
			return (
				(typeFilters.length === 0 || typeFilters.includes(ref.type)) &&
				(stateFilters.length === 0 || stateFilters.includes(ref.data.state))
			);
		});
		const rules = referenceSortRules().filter(
			(rule) => rule.direction !== "none",
		);
		return [...filtered].sort((a, b) => {
			for (const rule of rules) {
				let result = 0;
				if (rule.key === "type") result = a.type.localeCompare(b.type);
				if (rule.key === "state")
					result = a.data.state.localeCompare(b.data.state);
				if (rule.key === "title")
					result = a.data.title.localeCompare(b.data.title);
				if (rule.key === "updated")
					result =
						new Date(a.data.updated_at).getTime() -
						new Date(b.data.updated_at).getTime();
				if (result !== 0) return rule.direction === "desc" ? -result : result;
			}
			return 0;
		});
	});

	return {
		issues,
		setIssues,
		issueLoading,
		setIssueLoading,
		issueError,
		setIssueError,
		currentPage,
		setCurrentPage,
		totalPages,
		setTotalPages,
		totalCount,
		setTotalCount,
		perPage,
		setPerPage,
		selectedIssue,
		setSelectedIssue,
		selectedIssueIndex,
		setSelectedIssueIndex,
		issueSearchMode,
		setIssueSearchMode,
		issueSearchQuery,
		setIssueSearchQuery,
		issueSearchTerm,
		setIssueSearchTerm,
		issueListFilters,
		setIssueListFilters,
		issueListFilterParameters,
		issueListFilterParameterIndex,
		setIssueListFilterParameterIndex,
		issueListFilterValueIndex,
		setIssueListFilterValueIndex,
		issueListFilterFocusedPane,
		setIssueListFilterFocusedPane,
		showIssueListFilterModal,
		setShowIssueListFilterModal,
		showIssueListSortModal,
		setShowIssueListSortModal,
		issueListSortRules,
		setIssueListSortRules,
		issueListSortSelectedIndex,
		setIssueListSortSelectedIndex,
		activeIssueListSort,
		issueDetailLoading,
		setIssueDetailLoading,
		issueDetailError,
		setIssueDetailError,

		// Panel focus navigation
		issueDetailPanelIndex,
		setIssueDetailPanelIndex,
		issueDetailPanelCount: ISSUE_DETAIL_PANEL_COUNT,
		get issueDetailScrollBoxRefs() {
			return issueDetailScrollBoxRefs;
		},

		get issueDetailScrollBoxRef() {
			return issueDetailScrollBoxRef;
		},
		set issueDetailScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			issueDetailScrollBoxRef = value;
		},
		issueComments,
		setIssueComments,
		issueCommentsLoading,
		setIssueCommentsLoading,
		issueCommentsError,
		setIssueCommentsError,
		issueSubmitting,
		setIssueSubmitting,
		issueSubmitError,
		setIssueSubmitError,
		availableLabels,
		setAvailableLabels,
		availableCollaborators,
		setAvailableCollaborators,
		showCommentModal,
		setShowCommentModal,
		commentText,
		setCommentText,
		showLabelPicker,
		setShowLabelPicker,
		labelPickerIndex,
		setLabelPickerIndex,
		labelPickerSelectedLabels,
		setLabelPickerSelectedLabels,
		assigneePickerIndex,
		setAssigneePickerIndex,
		showCloseReasonModal,
		setShowCloseReasonModal,
		closeReasonIndex,
		setCloseReasonIndex,
		showAssigneePicker,
		setShowAssigneePicker,
		issuesFiltered,

		// Timeline
		selectedTimelineIndex,
		setSelectedTimelineIndex,

		// Linked CRs
		linkedChangeRequests,
		setLinkedCRs,
		linkedChangeRequestsLoading,
		setLinkedCRsLoading,
		linkedChangeRequestsError,
		setLinkedCRsError,
		selectedLinkedCRIndex,
		setSelectedLinkedCRIndex,

		// Referenced Issues
		referencedIssues,
		setReferencedIssues,
		referencedIssuesLoading,
		setReferencedIssuesLoading,
		referencedIssuesError,
		setReferencedIssuesError,
		selectedReferencedIssueIndex,
		setSelectedReferencedIssueIndex,

		// Unified References
		references,
		setReferences,
		referencesFiltered,
		referenceFilterParameters,
		referenceFilters,
		setReferenceFilters,
		referenceFilterParameterIndex,
		setReferenceFilterParameterIndex,
		referenceFilterValueIndex,
		setReferenceFilterValueIndex,
		referenceFilterFocusedPane,
		setReferenceFilterFocusedPane,
		showReferenceFilterModal,
		setShowReferenceFilterModal,
		showReferenceSortModal,
		setShowReferenceSortModal,
		referenceSortRules,
		setReferenceSortRules,
		referenceSortSelectedIndex,
		setReferenceSortSelectedIndex,
		selectedReferenceIndex,
		setSelectedReferenceIndex,
	};
}

export type IssueStore = ReturnType<typeof createIssueStore>;
