// Package changerequest provides a unified interface for provider-specific change request operations
// across different Git providers (GitHub, GitLab, etc.).
//
// The Client interface defines the common operations that all providers must
// implement, enabling the rest of the application to work with any Git provider
// without knowing provider-specific details.
package changerequest

import (
	"context"
	"time"
)

// RepoInfo holds repository identification for a Git provider.
// The fields are populated differently depending on the provider:
//
//   - GitHub: Owner, Repo (Host is always "github.com")
//   - GitLab: Namespace, Project (Host contains the GitLab instance)
type RepoInfo struct {
	// Owner is the repository owner/organization (GitHub).
	Owner string
	// Repo is the repository name (GitHub).
	Repo string
	// Host is the Git provider hostname (e.g., "github.com", "gitlab.com").
	Host string
	// Namespace is the group/project path (GitLab).
	Namespace string
	// Project is the project name within the namespace (GitLab).
	Project string
}

// ChangeRequestListOptions holds pagination and filter options for listing change requests.
type ChangeRequestListOptions struct {
	// SourceBranch filters by source branch. Empty means no filter.
	SourceBranch string
	// TargetBranch filters by target branch. Empty means no filter.
	TargetBranch string
	// State filters by change request state: "opened", "merged", "closed", "all". Empty defaults to "opened".
	State string
	// Page is the 1-based page number. 0 means page 1.
	Page int
	// PerPage is the page size. 0 means provider default (50).
	PerPage int
	// Search is a free-text search query.
	Search string
	// Labels filters by labels where provider supports it.
	Labels []string
	// SortBy is provider-normalized sort field (updated, created, title, etc.).
	SortBy string
	// SortDirection is asc or desc.
	SortDirection string
	// SkipDetails skips per-change-request detail/approval/pipeline fetches when true.
	// When true, only the list data is returned (much faster).
	SkipDetails bool
}

// ChangeRequestListResult holds the paginated response from listing change requests.
type ChangeRequestListResult struct {
	// ChangeRequests is the list of change requests for the current page.
	ChangeRequests []ChangeRequest `json:"items"`
	// TotalCount is the total number of change requests across all pages.
	// -1 if unknown (GitHub does not provide this).
	TotalCount int `json:"totalCount"`
	// TotalPages is the total number of pages.
	// -1 if unknown.
	TotalPages int `json:"totalPages"`
	// CurrentPage is the current page number (1-based).
	CurrentPage int `json:"currentPage"`
	// PerPage is the number of items per page.
	PerPage int `json:"perPage"`
}

// Client is the unified interface for change request operations across providers.
//
// This interface abstracts the differences between Git providers (GitHub, GitLab, etc.)
// allowing the application to work with any provider through a consistent API.
// Each method accepts a RepoInfo parameter to identify the target repository.
//
// Implementations are expected to be safe for concurrent use by multiple goroutines.
type Client interface {
	// Search finds repositories matching the given query.
	//
	// The limit parameter controls the maximum number of results returned.
	// If limit is <= 0, a provider-specific default is used.
	//
	// Returns repositories the authenticated user has access to.
	Search(info *RepoInfo, query string, limit int) ([]SearchResult, error)

	// GetChangeRequests returns change requests matching the given options.
	//
	// If options is nil, default options are used (page 1, per_page 50, opened state, no details skipped).
	//
	// Returns an ChangeRequestListResult with items and pagination metadata.
	// Items is an empty slice if no change requests match, never nil.
	GetChangeRequests(info *RepoInfo, options *ChangeRequestListOptions) (*ChangeRequestListResult, error)

	// GetChangeRequestChanges returns the list of changed files in a change request.
	//
	// The crNumber is the provider-specific change request ID (IID on GitLab, Number on GitHub).
	//
	// Each ChangeRequestChange includes the diff and parsed diff lines for rendering.
	// Returns an empty slice if the change request has no changes.
	GetChangeRequestChanges(info *RepoInfo, crNumber int) ([]ChangeRequestChange, error)

	// GetDiscussions returns all discussion threads in a change request.
	//
	// A discussion is a thread of comments, either on a specific code location
	// (inline review comment) or at the change request level (general comment).
	//
	// Returns an empty slice if no discussions exist.
	GetDiscussions(info *RepoInfo, crNumber int) ([]Discussion, error)

	// Approve submits an approval for the change request.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the user lacks permission to approve
	//   - the change request is already merged or closed
	Approve(info *RepoInfo, crNumber int) error

	// Unapprove removes the user's approval from the change request.
	//
	// Returns nil on success, even if the user hadn't approved.
	// Returns an error if the repository cannot be reached.
	Unapprove(info *RepoInfo, crNumber int) error

	// ToggleApproval approves if not yet approved, or removes approval if already approved.
	//
	// This is a convenience method that queries the current approval state
	// and calls either Approve or Unapprove accordingly.
	ToggleApproval(info *RepoInfo, crNumber int) error

	// GetJobLogs retrieves the log output for a CI/CD job.
	//
	// The jobID is the provider-specific job identifier.
	// Returns the raw log text, typically with ANSI color codes for terminal rendering.
	//
	// Returns an empty string if logs are not available.
	GetJobLogs(info *RepoInfo, jobID int) (string, error)

	// ValidateConnection tests the API connection and authentication.
	//
	// Returns nil if the connection is valid. Returns an error describing
	// the failure otherwise (authentication failed, network error, etc.).
	//
	// Call this before performing other operations to fail fast.
	ValidateConnection(info *RepoInfo) error

	// GetPipelines returns CI/CD pipelines for the repository.
	//
	// If limit is > 0, returns at most that many pipelines.
	// Pipelines are sorted by creation time, newest first.
	//
	// Returns an empty slice if no pipelines exist.
	GetPipelines(info *RepoInfo, limit int) ([]Pipeline, error)

	// GetPipelineJobs returns the jobs/stages for a specific pipeline.
	//
	// The pipelineID is the provider-specific pipeline identifier.
	//
	// Returns an empty slice if the pipeline has no jobs.
	GetPipelineJobs(info *RepoInfo, pipelineID int) ([]Job, error)

	// RestartJob retries a failed or cancelled job.
	//
	// Returns nil on success. Returns an error if:
	//   - the job cannot be found
	//   - the job is not in a restartable state (e.g., already running)
	//   - the user lacks permission
	RestartJob(info *RepoInfo, jobID int) error

	// CancelJob aborts a running job.
	//
	// Returns nil on success. Returns an error if:
	//   - the job cannot be found
	//   - the job is not in a cancellable state (e.g., already finished)
	//   - the user lacks permission
	CancelJob(info *RepoInfo, jobID int) error

	// Close closes a change request.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the change request is already merged or closed
	//   - the user lacks permission
	Close(info *RepoInfo, crNumber int) error

	// Rebase rebases the source branch onto the target branch.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the change request is already merged or closed
	//   - the user lacks permission
	//   - rebasing is not supported by the provider (e.g., GitHub)
	Rebase(info *RepoInfo, crNumber int) error

	// CreateDiffComment creates a new inline comment on a specific line in the diff.
	//
	// The position parameter specifies the location in the diff where the comment should appear.
	// If position is nil, a general discussion comment is created instead.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the change request cannot be found
	//   - the user lacks permission
	CreateDiffComment(info *RepoInfo, crNumber int, body string, position *DiffPosition) error

	// ReplyToDiscussion adds a reply to an existing discussion thread.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the discussion cannot be found
	//   - the user lacks permission
	ReplyToDiscussion(info *RepoInfo, crNumber int, discussionID string, body string) error

	// ResolveDiscussion marks a discussion as resolved or unresolves it.
	//
	// Returns nil on success. Returns an error if:
	//   - the repository cannot be reached
	//   - the discussion cannot be found
	//   - the user lacks permission
	ResolveDiscussion(info *RepoInfo, crNumber int, discussionID string, resolved bool) error

	// GetTestSummary returns test results for a pipeline.
	//
	// The pipelineID is the provider-specific pipeline identifier.
	// Returns nil if test results are not available for this pipeline.
	GetTestSummary(info *RepoInfo, pipelineID int) (*TestSummary, error)

	// StreamJobLogs streams job log output in real-time.
	//
	// Returns a channel that receives log lines as they are produced.
	// The channel is closed when all logs have been streamed or an error occurs.
	// The context can be used to cancel the streaming operation.
	StreamJobLogs(ctx context.Context, info *RepoInfo, jobID int) (chan string, error)
}

// SearchResult represents a repository found via search.
// The field names are normalized across providers for consistent handling.
type SearchResult struct {
	// Name is the repository name without the namespace/path.
	Name string `json:"name"`
	// FullPath is the full qualified name including namespace (e.g., "org/repo" or "group/project").
	FullPath string `json:"fullPath"`
	// HTTPURL is the HTTPS clone URL for the repository.
	HTTPURL string `json:"httpUrl"`
	// DefaultBranch is the name of the repository's default branch (e.g., "main", "master").
	DefaultBranch string `json:"defaultBranch"`
}

// ChangeRequest represents a change request from any Git provider.
// Field names and JSON tags are normalized across providers.
type ChangeRequest struct {
	// ID is the provider-assigned unique identifier.
	ID int `json:"id"`
	// IID is the internal/numbered ID visible in URLs (MR! on GitLab, # on GitHub).
	IID int `json:"iid"`
	// Title is the change request title.
	Title string `json:"title"`
	// Description is the change request body/description text.
	Description string `json:"description"`
	// SourceBranch is the branch containing the changes.
	SourceBranch string `json:"source_branch"`
	// TargetBranch is the branch the changes will be merged into.
	TargetBranch string `json:"target_branch"`
	// DefaultBranch is the repository default branch used to judge whether target branch is unusual.
	DefaultBranch string `json:"default_branch,omitempty"`
	// State is the current state: "opened", "merged", "closed", etc.
	State string `json:"state"`
	// WebURL is the URL to view this change request in a browser.
	WebURL string `json:"web_url"`
	// CreatedAt is when the change request was created.
	CreatedAt time.Time `json:"created_at"`
	// UpdatedAt is when the change request was last updated.
	UpdatedAt time.Time `json:"updated_at"`
	// Author identifies who created the change request.
	Author struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	// HeadPipeline is the CI/CD pipeline running on the source branch, if any.
	HeadPipeline *PipelineRef `json:"head_pipeline,omitempty"`
	// MergeStatus summarizes whether the change request can be merged.
	// Common values: "can_be_merged", "cannot_be_merged", "checking".
	MergeStatus string `json:"merge_status"`
	// DetailedMergeStatus provides more specific mergeability info.
	// Examples: "mergeable", "not_open", "dirty", "checking".
	DetailedMergeStatus string `json:"detailed_merge_status"`
	// Draft is true if the change request is marked as a draft/work-in-progress.
	Draft bool `json:"draft"`
	// WorkInProgress is an alias for Draft for compatibility.
	WorkInProgress bool `json:"work_in_progress"`
	// HasConflicts is true if the change request has merge conflicts with the target branch.
	HasConflicts bool `json:"has_conflicts"`
	// BlockingDiscussionsResolved is true if all required discussions are resolved.
	BlockingDiscussionsResolved bool `json:"blocking_discussions_resolved"`
	// RebaseInProgress is true if a rebase operation is currently running.
	RebaseInProgress bool `json:"rebase_in_progress"`
	// MergeError contains an error message if a merge attempt failed.
	MergeError string `json:"merge_error"`
	// ApproveStatus contains approval/review information, if available.
	ApproveStatus *ApproveStatus `json:"approvals,omitempty"`
}

// PipelineRef is a minimal reference to a CI/CD pipeline.
type PipelineRef struct {
	ID     int    `json:"id"`
	Status string `json:"status"`
	WebURL string `json:"web_url"`
}

// ApproveStatus holds approval/review information for a change request.
type ApproveStatus struct {
	// ApprovalsRequired is the minimum number of approvals needed.
	ApprovalsRequired int `json:"approvals_required"`
	// ApprovalsLeft is how many more approvals are needed.
	ApprovalsLeft int `json:"approvals_left"`
	// ApprovedBy lists the users who have approved.
	ApprovedBy []struct {
		User struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"user"`
	} `json:"approved_by"`
}

// ChangeRequestChange represents a changed file in a change request.
type ChangeRequestChange struct {
	// OldPath is the file path before the change (for renames/deletes).
	OldPath string `json:"old_path"`
	// NewPath is the file path after the change (for adds/renames).
	NewPath string `json:"new_path"`
	// AMode is the old file's permission mode (octal string).
	AMode string `json:"a_mode"`
	// BMode is the new file's permission mode (octal string).
	BMode string `json:"b_mode"`
	// NewFile is true if this is a newly created file.
	NewFile bool `json:"new_file"`
	// RenamedFile is true if the file was renamed.
	RenamedFile bool `json:"renamed_file"`
	// DeletedFile is true if the file was deleted.
	DeletedFile bool `json:"deleted_file"`
	// Diff is the unified diff of the file changes.
	Diff string `json:"diff"`
	// LinesAdded is the number of lines added.
	LinesAdded int `json:"lines_added"`
	// LinesDeleted is the number of lines removed.
	LinesDeleted int `json:"lines_deleted"`
	// DiffLines is the parsed diff with line numbers and metadata.
	// Populated by the client for rendering inline diffs.
	DiffLines []DiffLine `json:"diff_lines,omitempty"`
}

// DiffLine represents a single line in a diff with its metadata.
type DiffLine struct {
	// LineCode is a unique identifier for this line (provider-specific format).
	LineCode string `json:"line_code"`
	// Type indicates the line's role: "new" (added), "old" (removed), "match" (context).
	Type string `json:"type"`
	// OldLine is the line number in the old version (nil for added lines).
	OldLine *int `json:"old_line"`
	// NewLine is the line number in the new version (nil for removed lines).
	NewLine *int `json:"new_line"`
	// Text is the raw line content.
	Text string `json:"text"`
	// RichText is the HTML-formatted line content, if available.
	RichText string `json:"rich_text"`
}

// Discussion represents a comment thread in a change request.
// A discussion can be either an inline review comment (attached to a code location)
// or a general comment at the change request level.
type Discussion struct {
	// ID is the provider-assigned unique identifier for this thread.
	ID string `json:"id"`
	// IndividualNote is true if this is a single comment, false if it's a thread.
	IndividualNote bool `json:"individual_note"`
	// Notes contains all comments in this thread.
	// For individual notes, this slice has exactly one element.
	Notes []Note `json:"notes"`
}

// Note represents a single comment within a discussion.
type Note struct {
	// ID is the provider-assigned unique identifier.
	ID int `json:"id"`
	// Type indicates the note type: "DiffNote" (inline), "DiscussionNote" (general).
	Type string `json:"type"`
	// Body is the comment text (may contain Markdown).
	Body string `json:"body"`
	// Author identifies who wrote the comment.
	Author NoteAuthor `json:"author"`
	// CreatedAt is when the comment was created.
	CreatedAt time.Time `json:"created_at"`
	// UpdatedAt is when the comment was last edited.
	UpdatedAt time.Time `json:"updated_at"`
	// System is true for automatically generated comments (e.g., "change request closed").
	System bool `json:"system"`
	// Resolvable is true if this comment can be marked as resolved.
	Resolvable bool `json:"resolvable"`
	// Resolved is true if this comment has been marked as resolved.
	Resolved bool `json:"resolved"`
}

// NoteAuthor represents the author of a comment.
type NoteAuthor struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// Pipeline represents a CI/CD pipeline.
type Pipeline struct {
	// ID is the provider-assigned unique identifier.
	ID int `json:"id"`
	// IID is the internal/numbered ID.
	IID int `json:"iid"`
	// ProjectID is the provider's project identifier.
	ProjectID int `json:"project_id"`
	// Status is the current pipeline status.
	// Common values: "pending", "running", "success", "failed", "canceled".
	Status string `json:"status"`
	// Ref is the Git reference (branch/tag) the pipeline runs on.
	Ref string `json:"ref"`
	// SHA is the commit SHA that triggered this pipeline.
	SHA string `json:"sha"`
	// WebURL is the URL to view this pipeline in a browser.
	WebURL string `json:"web_url"`
	// CreatedAt is when the pipeline was created.
	CreatedAt time.Time `json:"created_at"`
	// UpdatedAt is when the pipeline was last updated.
	UpdatedAt time.Time `json:"updated_at"`
	// User identifies who triggered the pipeline.
	User struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"user"`
	// Source is what triggered the pipeline (e.g., "push", "merge_request_event", "schedule").
	Source string `json:"source"`
}

// Job represents a single job/stage within a CI/CD pipeline.
type Job struct {
	// ID is the provider-assigned unique identifier.
	ID int `json:"id"`
	// Name is the job name as defined in the CI configuration.
	Name string `json:"name"`
	// Stage is the CI stage this job belongs to (e.g., "build", "test", "deploy").
	Stage string `json:"stage"`
	// Status is the current job status.
	// Common values: "pending", "running", "success", "failed", "canceled".
	Status string `json:"status"`
	// WebURL is the URL to view this job in a browser.
	WebURL string `json:"web_url"`
	// CreatedAt is when the job was created.
	CreatedAt *time.Time `json:"created_at,omitempty"`
	// StartedAt is when the job started executing.
	StartedAt *time.Time `json:"started_at,omitempty"`
	// FinishedAt is when the job completed.
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	// Duration is the total execution time in seconds.
	Duration *float64 `json:"duration,omitempty"`
	// QueuedDuration is how long the job waited before starting.
	QueuedDuration *float64 `json:"queued_duration,omitempty"`
	// Pipeline is a reference to the parent pipeline.
	Pipeline struct {
		ID int `json:"id"`
	} `json:"pipeline"`
}

// DiffPosition specifies a location in a diff for inline comments.
type DiffPosition struct {
	// BaseSHA is the SHA of the base commit.
	BaseSHA string `json:"base_sha"`
	// StartSHA is the SHA of the commit where the diff was generated.
	StartSHA string `json:"start_sha"`
	// HeadSHA is the SHA of the head commit.
	HeadSHA string `json:"head_sha"`
	// PositionType is the type of position: "text", "image", or "file".
	PositionType string `json:"position_type"`
	// OldPath is the file path in the base commit.
	OldPath string `json:"old_path"`
	// NewPath is the file path in the head commit.
	NewPath string `json:"new_path"`
	// OldLine is the line number in the old version (for "old" type).
	OldLine *int `json:"old_line,omitempty"`
	// NewLine is the line number in the new version (for "new" type).
	NewLine *int `json:"new_line,omitempty"`
}

// TestCase represents a single test case result.
type TestCase struct {
	// Name is the full test name including class/describe context.
	Name string `json:"name"`
	// Classname is the test class or suite name.
	Classname string `json:"classname"`
	// Status is the test result: "success", "failed", "skipped", "error".
	Status string `json:"status"`
	// Time is the execution time in seconds.
	Time float64 `json:"time"`
	// SystemOut contains stdout/stderr output.
	SystemOut string `json:"system_out,omitempty"`
	// SystemErr contains error stack trace.
	SystemErr string `json:"system_err,omitempty"`
}

// TestSuite represents a group of test cases.
type TestSuite struct {
	// Name is the suite name.
	Name string `json:"name"`
	// TestCases is the list of test cases in this suite.
	TestCases []TestCase `json:"test_cases"`
}

// FailedTestGroup represents failed tests grouped by class name.
type FailedTestGroup struct {
	// ClassName is the test class name without package prefix.
	ClassName string `json:"class_name"`
	// TestMethods is the list of failed test method names.
	TestMethods []string `json:"test_methods"`
}

// TestSummary represents aggregated test results for a pipeline.
type TestSummary struct {
	// Total is the total number of tests.
	Total int `json:"total"`
	// Success is the number of passing tests.
	Success int `json:"success"`
	// Failed is the number of failing tests.
	Failed int `json:"failed"`
	// Skipped is the number of skipped tests.
	Skipped int `json:"skipped"`
	// Error is the number of tests with errors.
	Error int `json:"error"`
	// TestSuites contains detailed test suite results, if available.
	TestSuites []TestSuite `json:"test_suites,omitempty"`
	// FailedTestGroups contains failed tests grouped by class name.
	FailedTestGroups []FailedTestGroup `json:"failed_test_groups,omitempty"`
}
