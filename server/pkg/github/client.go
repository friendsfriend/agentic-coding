package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// Client is the GitHub-specific implementation of changerequest.Client.
// It provides merge/pull request operations for GitHub repositories.
type Client interface {
	changerequest.Client
	GetJobLogsContext(ctx context.Context, info *changerequest.RepoInfo, jobID int) (string, error)
	GetPullRequest(info *RepoInfo, prNumber int) (*ChangeRequest, error)
	GetWorkflowRunByID(info *RepoInfo, runID int64) (*ghWorkflowRun, error)
	GetCheckRunsForRef(info *RepoInfo, ref string) ([]ghCheckRun, error)
}

type client struct {
	token      string
	username   string
	httpClient *http.Client
	ctx        context.Context
}

func NewClient(token, username string) Client {
	return newClientWithContext(context.Background(), token, username, nil)
}

func NewClientWithContext(ctx context.Context, token, username string) Client {
	return newClientWithContext(ctx, token, username, nil)
}

func newClient(token, username string, httpClient *http.Client) Client {
	return newClientWithContext(context.Background(), token, username, httpClient)
}

func newClientWithContext(ctx context.Context, token, username string, httpClient *http.Client) Client {
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: time.Second * 15,
			Transport: &http.Transport{
				ResponseHeaderTimeout: time.Second * 10,
				TLSHandshakeTimeout:   time.Second * 5,
				DisableKeepAlives:     false,
			},
		}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return &client{
		token:      token,
		username:   username,
		httpClient: httpClient,
		ctx:        ctx,
	}
}

func (c *client) requestContext() context.Context {
	if c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

// --- GitHub API raw types (used internally for unmarshalling) ---

type ghPRBranch struct {
	Ref  string `json:"ref"` // branch name
	SHA  string `json:"sha"`
	Repo *struct {
		DefaultBranch string `json:"default_branch"`
	} `json:"repo,omitempty"`
}

type ghUser struct {
	Login string `json:"login"`
}

type ghPR struct {
	ID        int        `json:"id"`
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	State     string     `json:"state"` // open, closed
	Merged    bool       `json:"merged"`
	Draft     bool       `json:"draft"`
	HTMLURL   string     `json:"html_url"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	User      ghUser     `json:"user"`
	Head      ghPRBranch `json:"head"`
	Base      ghPRBranch `json:"base"`
	// Mergeability — may be null until GitHub computes it
	Mergeable      *bool  `json:"mergeable"`
	MergeableState string `json:"mergeable_state"` // clean, dirty, unstable, blocked, unknown
}

type ghReview struct {
	ID   int    `json:"id"`
	User ghUser `json:"user"`
	// "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"
	State string `json:"state"`
}

type ghPRFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename,omitempty"`
	Status           string `json:"status"` // added, removed, modified, renamed, copied, changed, unchanged
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Patch            string `json:"patch,omitempty"` // unified diff
}

type ghIssueComment struct {
	ID        int       `json:"id"`
	Body      string    `json:"body"`
	User      ghUser    `json:"user"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ghPRReviewComment struct {
	ID                  int       `json:"id"`
	Body                string    `json:"body"`
	User                ghUser    `json:"user"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
	Path                string    `json:"path"`
	Line                *int      `json:"line"`
	OriginalLine        *int      `json:"original_line"`
	StartLine           *int      `json:"start_line"`
	OriginalStartLine   *int      `json:"original_start_line"`
	Side                string    `json:"side"` // LEFT or RIGHT
	DiffHunk            string    `json:"diff_hunk"`
	InReplyToID         *int      `json:"in_reply_to_id"`
	PullRequestReviewID int       `json:"pull_request_review_id"`
}

// ghTimelineEvent represents an item from the GitHub Issue/PR Timeline API.
// The timeline returns a mixed array: issue comments (event="commented") and
// issue events (labeled, assigned, renamed, milestoned, etc.).
// We use json.RawMessage for sub-objects so we can switch on event type.
type ghTimelineEvent struct {
	ID        int       `json:"id"`
	Event     string    `json:"event"` // "commented", "labeled", "assigned", "renamed", etc.
	Actor     ghUser    `json:"actor"`
	CreatedAt time.Time `json:"created_at"`
	Body      string    `json:"body,omitempty"` // only for "commented" events
	Label     *struct {
		Name string `json:"name"`
	} `json:"label,omitempty"`
	Assignee *ghUser `json:"assignee,omitempty"`
	Rename   *struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"rename,omitempty"`
	Milestone *struct {
		Title string `json:"title"`
	} `json:"milestone,omitempty"`
	RequestedReviewer *ghUser `json:"requested_reviewer,omitempty"`
	Source            *struct {
		Type  string `json:"type"`
		Issue *struct {
			Number  int    `json:"number"`
			Title   string `json:"title"`
			HTMLURL string `json:"html_url"`
		} `json:"issue,omitempty"`
	} `json:"source,omitempty"`
	PerformedViaGithubApp *json.RawMessage `json:"performed_via_github_app,omitempty"`
}

// --- Canonical types (matching what the server returns to the TUI) ---

// ChangeRequest is the canonical merge/pull request shape returned by the server.
// Field names and JSON tags are identical to the GitLab client's ChangeRequest struct
// so the TUI can consume both sources transparently.
type ChangeRequest struct {
	ID            int       `json:"id"`
	IID           int       `json:"iid"`
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	SourceBranch  string    `json:"source_branch"`
	TargetBranch  string    `json:"target_branch"`
	DefaultBranch string    `json:"default_branch,omitempty"`
	State         string    `json:"state"` // opened, merged, closed
	WebURL        string    `json:"web_url"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Author        struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	// GitHub has no GitLab-style pipeline, but we expose the latest matching
	// Actions workflow run as head_pipeline for TUI compatibility.
	HeadPipeline *struct {
		ID     int    `json:"id"`
		Status string `json:"status"`
		WebURL string `json:"web_url"`
	} `json:"head_pipeline,omitempty"`

	// Merge-ability
	MergeStatus         string `json:"merge_status"`          // "can_be_merged" | "cannot_be_merged" | "checking"
	DetailedMergeStatus string `json:"detailed_merge_status"` // mirrors mergeable_state
	Draft               bool   `json:"draft"`
	WorkInProgress      bool   `json:"work_in_progress"` // legacy alias for draft
	HasConflicts        bool   `json:"has_conflicts"`
	// GitHub doesn't have the concept of "blocking discussions resolved" — always true
	BlockingDiscussionsResolved bool   `json:"blocking_discussions_resolved"`
	RebaseInProgress            bool   `json:"rebase_in_progress"` // always false for GitHub
	MergeError                  string `json:"merge_error"`

	Approvals *MergeRequestApprovals `json:"approvals,omitempty"`
}

// MergeRequestApprovals mirrors the GitLab approvals shape consumed by the TUI.
type MergeRequestApprovals struct {
	ApprovalsRequired int `json:"approvals_required"` // 1 (GitHub requires at least 1 review — we report 1)
	ApprovalsLeft     int `json:"approvals_left"`
	ApprovedBy        []struct {
		User struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"user"`
	} `json:"approved_by"`
}

// ChangeRequestChange mirrors the GitLab ChangeRequestChange shape.
type ChangeRequestChange struct {
	OldPath      string     `json:"old_path"`
	NewPath      string     `json:"new_path"`
	AMode        string     `json:"a_mode"`
	BMode        string     `json:"b_mode"`
	NewFile      bool       `json:"new_file"`
	RenamedFile  bool       `json:"renamed_file"`
	DeletedFile  bool       `json:"deleted_file"`
	Diff         string     `json:"diff"`
	LinesAdded   int        `json:"lines_added"`
	LinesDeleted int        `json:"lines_deleted"`
	DiffLines    []DiffLine `json:"diff_lines,omitempty"`
}

// DiffLine mirrors the GitLab DiffLine shape.
type DiffLine struct {
	LineCode string `json:"line_code"`
	Type     string `json:"type"`     // "new", "old", "match"
	OldLine  *int   `json:"old_line"` // nil for added lines
	NewLine  *int   `json:"new_line"` // nil for deleted lines
	Text     string `json:"text"`
	RichText string `json:"rich_text"`
}

// Discussion mirrors the GitLab Discussion shape so the TUI can render it.
type Discussion struct {
	ID             string `json:"id"`
	IndividualNote bool   `json:"individual_note"`
	Notes          []Note `json:"notes"`
}

// Note mirrors the GitLab Note shape.
type Note struct {
	ID         int        `json:"id"`
	Type       string     `json:"type"`
	Body       string     `json:"body"`
	Author     NoteAuthor `json:"author"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	System     bool       `json:"system"`
	Resolvable bool       `json:"resolvable"`
	Resolved   bool       `json:"resolved"`
}

// NoteAuthor mirrors the GitLab NoteAuthor shape.
type NoteAuthor struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// --- Helper: HTTP request with GitHub auth ---

func (c *client) doRequest(method, apiURL string, body io.Reader) (*http.Response, error) {
	return c.doRequestContext(c.requestContext(), method, apiURL, body)
}

func (c *client) doRequestContext(ctx context.Context, method, apiURL string, body io.Reader) (*http.Response, error) {
	if ctx == nil {
		ctx = c.requestContext()
	}
	req, err := http.NewRequestWithContext(ctx, method, apiURL, body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.token))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "devenv-cli")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return c.httpClient.Do(req)
}

func readBody(resp *http.Response) ([]byte, error) {
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// parseLinkHeaderForPagination extracts current page and total pages from a GitHub Link header.
// GitHub's Link header format: <https://api.github.com/repos/.../pulls?page=2>; rel="next", <https://.../pulls?page=5>; rel="last"
// Since GitHub doesn't provide X-Total, we return -1 for total pages when unknown and
// detect boundaries by checking for rel="next" and rel="prev".
func parseLinkHeaderForPagination(linkHeader string, currentPage int) (page, totalPages int) {
	page = currentPage
	totalPages = -1

	if linkHeader == "" {
		// No Link header means only one page
		return page, currentPage
	}

	hasNext := false
	lastPageNum := -1

	// Parse each link: <url>; rel="type"
	links := strings.Split(linkHeader, ",")
	for _, link := range links {
		link = strings.TrimSpace(link)
		// Extract URL and rel
		parts := strings.Split(link, ";")
		if len(parts) < 2 {
			continue
		}
		urlPart := strings.TrimSpace(parts[0])
		relPart := strings.TrimSpace(parts[1])

		// Extract rel value
		relMatch := regexp.MustCompile(`rel="([^"]+)"`).FindStringSubmatch(relPart)
		if len(relMatch) < 2 {
			continue
		}
		rel := relMatch[1]

		// Extract page number from URL
		pageMatch := regexp.MustCompile(`[?&]page=(\d+)`).FindStringSubmatch(urlPart)
		if len(pageMatch) < 2 {
			continue
		}
		pageNum, _ := strconv.Atoi(pageMatch[1])

		switch rel {
		case "next":
			hasNext = true
		case "last":
			lastPageNum = pageNum
			if lastPageNum > 0 {
				totalPages = lastPageNum
			}
		}
	}

	// If no "next" link, we're on the last page
	if !hasNext {
		totalPages = currentPage
	}

	// If we have "last" page, use it as totalPages
	if lastPageNum > 0 {
		totalPages = lastPageNum
	}

	return page, totalPages
}

func (c *client) GetWorkflowRunByID(info *RepoInfo, runID int64) (*ghWorkflowRun, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs/%d",
		info.Owner, info.Repo, runID)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch workflow run: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var run ghWorkflowRun
	if err := json.Unmarshal(body, &run); err != nil {
		return nil, fmt.Errorf("failed to parse workflow run: %w", err)
	}

	return &run, nil
}

func (c *client) GetCheckRunsForRef(info *RepoInfo, ref string) ([]ghCheckRun, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/commits/%s/check-runs",
		info.Owner, info.Repo, ref)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch check runs: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		TotalCount int          `json:"total_count"`
		CheckRuns  []ghCheckRun `json:"check_runs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse check runs: %w", err)
	}

	return result.CheckRuns, nil
}

// ValidateConnection implements changerequest.Client.ValidateConnection.
func (c *client) ValidateConnection(info *changerequest.RepoInfo) error {
	apiURL := "https://api.github.com/user"
	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return fmt.Errorf("GitHub connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub authentication failed (status %d): %s", resp.StatusCode, string(body))
	}
	return nil
}

// GetPipelines implements changerequest.Client.GetPipelines.
func (c *client) GetPipelines(info *changerequest.RepoInfo, limit int) ([]changerequest.Pipeline, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	limit = clampProviderLimit(limit)

	params := url.Values{}
	params.Set("per_page", fmt.Sprintf("%d", limit))
	params.Set("exclude_pull_requests", "false")

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs?%s",
		ghInfo.Owner, ghInfo.Repo, params.Encode())

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch workflow runs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result struct {
		WorkflowRuns []ghWorkflowRun `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse workflow runs: %w", err)
	}

	pipelines := make([]changerequest.Pipeline, 0, len(result.WorkflowRuns))
	for _, run := range result.WorkflowRuns {
		pipelines = append(pipelines, changerequest.Pipeline{
			ID:     run.ID,
			Status: mapRunStatusToGitLab(run),
			Ref:    run.HeadBranch,
			SHA:    run.HeadSHA,
			WebURL: run.HTMLURL,
			Source: "workflow_dispatch",
		})
	}
	return pipelines, nil
}

// GetPipelineJobs implements changerequest.Client.GetPipelineJobs.
func (c *client) GetPipelineJobs(info *changerequest.RepoInfo, pipelineID int) ([]changerequest.Job, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs/%d/jobs?per_page=100",
		ghInfo.Owner, ghInfo.Repo, pipelineID)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch jobs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Jobs []ghActionJob `json:"jobs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse jobs: %w", err)
	}

	jobs := make([]changerequest.Job, 0, len(result.Jobs))
	for _, j := range result.Jobs {
		job := convertActionJobToChangeRequest(j)
		job.Pipeline.ID = pipelineID
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (c *client) RestartJob(info *changerequest.RepoInfo, jobID int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/jobs/%d/rerun",
		ghInfo.Owner, ghInfo.Repo, jobID)

	resp, err := c.doRequest("POST", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *client) CancelJob(info *changerequest.RepoInfo, jobID int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}

	job, err := c.GetActionJob(info, jobID)
	if err != nil {
		return fmt.Errorf("failed to get job details: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs/%d/cancel",
		ghInfo.Owner, ghInfo.Repo, job.RunID)

	resp, err := c.doRequest("POST", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

func convertActionJobToChangeRequest(job ghActionJob) changerequest.Job {
	startedAt := job.StartedAt
	finishedAt := job.CompletedAt

	var duration *float64
	if !job.StartedAt.IsZero() && !job.CompletedAt.IsZero() {
		d := job.CompletedAt.Sub(job.StartedAt).Seconds()
		duration = &d
	}

	return changerequest.Job{
		ID:         job.ID,
		Name:       job.Name,
		Stage:      "Default",
		Status:     mapJobStatusToGitLab(job),
		WebURL:     job.HTMLURL,
		StartedAt:  &startedAt,
		FinishedAt: &finishedAt,
		Duration:   duration,
	}
}

func mapJobStatusToGitLab(job ghActionJob) string {
	switch job.Status {
	case "queued", "waiting", "pending":
		return "pending"
	case "in progress":
		return "running"
	case "completed":
		switch job.Conclusion {
		case "success", "neutral", "skipped":
			return "success"
		case "failure", "timed_out":
			return "failed"
		case "cancelled":
			return "canceled"
		default:
			return "running"
		}
	default:
		return "running"
	}
}

func (c *client) GetTestSummary(info *changerequest.RepoInfo, pipelineID int) (*changerequest.TestSummary, error) {
	return nil, nil
}

func (c *client) StreamJobLogs(ctx context.Context, info *changerequest.RepoInfo, jobID int) (chan string, error) {
	logs, err := c.GetJobLogs(info, jobID)
	if err != nil {
		return nil, err
	}

	ch := make(chan string, 1)
	go func() {
		defer close(ch)
		lines := strings.Split(logs, "\n")
		for _, line := range lines {
			select {
			case ch <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}
