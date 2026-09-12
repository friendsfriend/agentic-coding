package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// Client is the GitLab API client used internally.
type Client interface {
	Username() string
	GetChangeRequests(projectInfo *ProjectInfo, sourceBranch, targetBranch string) ([]ChangeRequest, error)
	GetChangeRequestsWithOptions(projectInfo *ProjectInfo, opts *changerequest.ChangeRequestListOptions) (*changerequest.ChangeRequestListResult, error)
	GetPipelineJobs(projectInfo *ProjectInfo, pipelineID int) ([]Job, error)
	GetTestSummary(projectInfo *ProjectInfo, pipelineID int) (*TestSummary, error)
	GetChangeRequestChanges(projectInfo *ProjectInfo, mrIID int) ([]ChangeRequestChange, error)
	GetMRVersions(projectInfo *ProjectInfo, mrIID int) ([]map[string]interface{}, error)
	CreateMRDiffComment(projectInfo *ProjectInfo, mrIID int, body string, position *DiffPosition) error
	GetMRDiscussions(projectInfo *ProjectInfo, mrIID int) ([]Discussion, error)
	ReplyToDiscussion(projectInfo *ProjectInfo, mrIID int, discussionID string, body string) error
	ResolveDiscussion(projectInfo *ProjectInfo, mrIID int, discussionID string, resolved bool) error
	ApproveChangeRequest(projectInfo *ProjectInfo, mrIID int) error
	UnapproveChangeRequest(projectInfo *ProjectInfo, mrIID int) error
	ToggleMRApproval(projectInfo *ProjectInfo, mrIID int, username string) error
	RebaseChangeRequest(projectInfo *ProjectInfo, mrIID int) error
	CloseChangeRequest(projectInfo *ProjectInfo, mrIID int) error
	GetJobLogs(projectInfo *ProjectInfo, jobID int) (string, error)
	GetJobLogsContext(ctx context.Context, projectInfo *ProjectInfo, jobID int) (string, error)
	StreamJobLogs(ctx context.Context, projectInfo *ProjectInfo, jobID int) (chan string, error)
	SearchProjects(query string, limit int) ([]SearchResult, error)
	ValidateConnection() error
	GetPipelines(projectInfo *ProjectInfo, limit int) ([]Pipeline, error)
	RestartJob(projectInfo *ProjectInfo, jobID int) error
	CancelJob(projectInfo *ProjectInfo, jobID int) error
}

type client struct {
	baseURL    string
	token      string
	username   string
	httpClient *http.Client
	ctx        context.Context
}

func (c *client) requestContext() context.Context {
	if c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

// Username returns the authenticated username for approval toggling.
func (c *client) Username() string {
	return c.username
}

// Pipeline represents a GitLab pipeline from the API
type Pipeline struct {
	ID        int       `json:"id"`
	IID       int       `json:"iid"`
	ProjectID int       `json:"project_id"`
	Status    string    `json:"status"`
	Ref       string    `json:"ref"`
	SHA       string    `json:"sha"`
	WebURL    string    `json:"web_url"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	User      struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"user"`
	Source string `json:"source"`
}

// Job represents a GitLab job/stage from the API
type Job struct {
	ID             int        `json:"id"`
	Name           string     `json:"name"`
	Stage          string     `json:"stage"`
	Status         string     `json:"status"`
	WebURL         string     `json:"web_url"`
	CreatedAt      *time.Time `json:"created_at,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
	Duration       *float64   `json:"duration,omitempty"`        // Job duration in seconds
	QueuedDuration *float64   `json:"queued_duration,omitempty"` // Time spent in queue
	Runner         *struct {
		ID          int    `json:"id"`
		Description string `json:"description"`
		Name        string `json:"name"`
	} `json:"runner,omitempty"`
	Pipeline struct {
		ID int `json:"id"`
	} `json:"pipeline"`
}

// TestCase represents an individual test case
type TestCase struct {
	Name      string         `json:"name"`
	Classname string         `json:"classname"`
	Status    string         `json:"status"`
	Time      float64        `json:"execution_time"`          // GitLab uses "execution_time" not "time"
	SystemOut FlexibleString `json:"system_output,omitempty"` // GitLab uses "system_output" - can be string or object
	SystemErr string         `json:"stack_trace,omitempty"`   // GitLab uses "stack_trace" for error info
}

// FlexibleString handles both string and object formats from GitLab API
// GitLab sometimes returns system_output as a string, sometimes as {"value": "..."}
type FlexibleString string

// UnmarshalJSON implements custom unmarshaling for FlexibleString
func (fs *FlexibleString) UnmarshalJSON(data []byte) error {
	// Handle null explicitly
	if string(data) == "null" {
		*fs = ""
		return nil
	}

	// Try to unmarshal as a plain string first
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		*fs = FlexibleString(str)
		return nil
	}

	// If that fails, try to unmarshal as an object with a "value" field
	var obj struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(data, &obj); err == nil {
		*fs = FlexibleString(obj.Value)
		return nil
	}

	// If all fail, just set empty string
	*fs = ""
	return nil
}

// MarshalJSON implements custom marshaling for FlexibleString
// Always output as a plain string for consistency
func (fs FlexibleString) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(fs))
}

// TestSuite represents a test suite containing multiple test cases
type TestSuite struct {
	Name      string     `json:"name"`
	TestCases []TestCase `json:"test_cases"`
}

// FailedTestGroup represents failed tests grouped by class name
type FailedTestGroup struct {
	ClassName   string   `json:"class_name"`   // Class name without package prefix
	TestMethods []string `json:"test_methods"` // List of failed test method names
}

// TestSummary represents test results for a pipeline
type TestSummary struct {
	Total            int               `json:"total"`
	Success          int               `json:"success"`
	Failed           int               `json:"failed"`
	Skipped          int               `json:"skipped"`
	Error            int               `json:"error"`
	TestSuites       []TestSuite       `json:"test_suites,omitempty"`
	FailedTests      []string          `json:"-"` // Legacy field for backward compatibility
	FailedTestGroups []FailedTestGroup `json:"-"` // New grouped failed tests by class
}

// MergeRequestApprovals represents the approval information for a change request
type MergeRequestApprovals struct {
	ApprovalsRequired int `json:"approvals_required"`
	ApprovalsLeft     int `json:"approvals_left"`
	ApprovedBy        []struct {
		User struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"user"`
	} `json:"approved_by"`
}

// ChangeRequest represents a GitLab change request from the API
type ChangeRequest struct {
	ID            int       `json:"id"`
	IID           int       `json:"iid"`
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	SourceBranch  string    `json:"source_branch"`
	TargetBranch  string    `json:"target_branch"`
	DefaultBranch string    `json:"default_branch,omitempty"`
	State         string    `json:"state"`
	WebURL        string    `json:"web_url"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Author        struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	// GitLab returns this as "head_pipeline" in the API response
	HeadPipeline *struct {
		ID     int    `json:"id"`
		Status string `json:"status"`
		WebURL string `json:"web_url"`
	} `json:"head_pipeline,omitempty"`
	// Approval and mergability status
	MergeStatus                 string                 `json:"merge_status"`                  // can_be_merged, cannot_be_merged, unchecked, checking, cannot_be_merged_recheck
	DetailedMergeStatus         string                 `json:"detailed_merge_status"`         // more detailed merge status (includes need_rebase, not_open, checking, mergeable, etc)
	Draft                       bool                   `json:"draft"`                         // whether MR is marked as draft
	WorkInProgress              bool                   `json:"work_in_progress"`              // legacy field for draft status
	HasConflicts                bool                   `json:"has_conflicts"`                 // whether MR has merge conflicts
	BlockingDiscussionsResolved bool                   `json:"blocking_discussions_resolved"` // whether all blocking discussions are resolved
	RebaseInProgress            bool                   `json:"rebase_in_progress"`            // whether a rebase operation is currently in progress
	MergeError                  string                 `json:"merge_error"`                   // error message if merge/rebase failed
	Approvals                   *MergeRequestApprovals `json:"approvals,omitempty"`
}

// ChangeRequestChange represents a changed file in a change request
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
	DiffLines    []DiffLine `json:"diff_lines,omitempty"` // Parsed diff lines with line codes
}

// DiffLine represents a single line in a diff with its metadata
type DiffLine struct {
	LineCode string `json:"line_code"` // GitLab's unique identifier for this line
	Type     string `json:"type"`      // "new", "old", "match" (context)
	OldLine  *int   `json:"old_line"`  // Line number in old file (nil for added lines)
	NewLine  *int   `json:"new_line"`  // Line number in new file (nil for deleted lines)
	Text     string `json:"text"`      // The actual line content
	RichText string `json:"rich_text"` // HTML-formatted text (if available)
}

// Discussion represents a GitLab discussion thread (can contain multiple notes/comments)
type Discussion struct {
	ID             string        `json:"id"`
	IndividualNote bool          `json:"individual_note"` // true if single comment, false if thread
	Notes          []Note        `json:"notes"`
	Position       *NotePosition `json:"position,omitempty"` // Position in diff (for diff comments)
}

// Note represents a single comment/note within a discussion
type Note struct {
	ID         int           `json:"id"`
	Type       string        `json:"type"` // "DiffNote", "DiscussionNote", etc.
	Body       string        `json:"body"` // Comment text (markdown)
	Author     NoteAuthor    `json:"author"`
	CreatedAt  time.Time     `json:"created_at"`
	UpdatedAt  time.Time     `json:"updated_at"`
	System     bool          `json:"system"`             // true for system-generated notes
	Position   *NotePosition `json:"position,omitempty"` // Position in diff
	Resolvable bool          `json:"resolvable"`         // Can this note be resolved?
	Resolved   bool          `json:"resolved"`           // Is this note resolved?
	ResolvedBy *NoteAuthor   `json:"resolved_by,omitempty"`
	ResolvedAt *time.Time    `json:"resolved_at,omitempty"`
}

// NoteAuthor represents the author of a note/comment
type NoteAuthor struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// NotePosition represents the position of a comment in a diff
type NotePosition struct {
	BaseSHA      string `json:"base_sha"`
	StartSHA     string `json:"start_sha"`
	HeadSHA      string `json:"head_sha"`
	OldPath      string `json:"old_path"`
	NewPath      string `json:"new_path"`
	PositionType string `json:"position_type"` // "text", "image", or "file"
	OldLine      *int   `json:"old_line,omitempty"`
	NewLine      *int   `json:"new_line,omitempty"`
	LineRange    *struct {
		Start struct {
			LineCode string `json:"line_code"`
			Type     string `json:"type"`
			OldLine  *int   `json:"old_line,omitempty"`
			NewLine  *int   `json:"new_line,omitempty"`
		} `json:"start"`
		End struct {
			LineCode string `json:"line_code"`
			Type     string `json:"type"`
			OldLine  *int   `json:"old_line,omitempty"`
			NewLine  *int   `json:"new_line,omitempty"`
		} `json:"end"`
	} `json:"line_range,omitempty"` // For multi-line comments
}

// NewClient creates a new GitLab API client
func NewClient(baseURL, token, username string) Client {
	return NewClientWithContext(context.Background(), baseURL, token, username)
}

func NewClientWithContext(ctx context.Context, baseURL, token, username string) Client {
	if ctx == nil {
		ctx = context.Background()
	}
	// Ensure baseURL has the correct format
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		baseURL = "https://" + baseURL
	}

	// Remove trailing slash
	baseURL = strings.TrimSuffix(baseURL, "/")

	return &client{
		baseURL:  baseURL,
		token:    token,
		username: username,
		ctx:      ctx,
		httpClient: &http.Client{
			Timeout: time.Second * 15, // Reasonable timeout for API calls
			Transport: &http.Transport{
				ResponseHeaderTimeout: time.Second * 10, // Max time to wait for response headers
				TLSHandshakeTimeout:   time.Second * 5,  // Max time for TLS handshake
				DisableKeepAlives:     false,            // Enable keep-alive for better performance
			},
		},
	}
}

// --- changerequest.Client implementations ---

// MRClient implements changerequest.Client by wrapping a Client.
type MRClient struct {
	client Client
}

// NewMRClient creates a new MRClient that implements changerequest.Client.
func NewMRClient(client Client) changerequest.Client {
	return &MRClient{client: client}
}

func (c *MRClient) Search(info *changerequest.RepoInfo, query string, limit int) ([]changerequest.SearchResult, error) {
	results, err := c.client.SearchProjects(query, limit)
	if err != nil {
		return nil, err
	}
	return convertSearchResultsToChangeRequest(results), nil
}

func (c *MRClient) GetChangeRequests(info *changerequest.RepoInfo, options *changerequest.ChangeRequestListOptions) (*changerequest.ChangeRequestListResult, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	return c.client.GetChangeRequestsWithOptions(projectInfo, options)
}

func (c *MRClient) GetChangeRequestChanges(info *changerequest.RepoInfo, mrNumber int) ([]changerequest.ChangeRequestChange, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	changes, err := c.client.GetChangeRequestChanges(projectInfo, mrNumber)
	if err != nil {
		return nil, err
	}
	return convertChangeRequestChangesToChangeRequest(changes), nil
}

func (c *MRClient) GetDiscussions(info *changerequest.RepoInfo, mrNumber int) ([]changerequest.Discussion, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	discussions, err := c.client.GetMRDiscussions(projectInfo, mrNumber)
	if err != nil {
		return nil, err
	}
	return convertDiscussionsToChangeRequest(discussions), nil
}

func (c *MRClient) Approve(info *changerequest.RepoInfo, mrNumber int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.ApproveChangeRequest(projectInfo, mrNumber)
}

func (c *MRClient) Unapprove(info *changerequest.RepoInfo, mrNumber int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.UnapproveChangeRequest(projectInfo, mrNumber)
}

func (c *MRClient) ToggleApproval(info *changerequest.RepoInfo, mrNumber int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.ToggleMRApproval(projectInfo, mrNumber, c.client.Username())
}

func (c *MRClient) GetJobLogs(info *changerequest.RepoInfo, jobID int) (string, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return "", err
	}
	return c.client.GetJobLogs(projectInfo, jobID)
}

func (c *MRClient) ValidateConnection(info *changerequest.RepoInfo) error {
	return c.client.ValidateConnection()
}

func (c *MRClient) GetPipelines(info *changerequest.RepoInfo, limit int) ([]changerequest.Pipeline, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	pipelines, err := c.client.GetPipelines(projectInfo, limit)
	if err != nil {
		return nil, err
	}
	return convertPipelinesToChangeRequest(pipelines), nil
}

func (c *MRClient) GetPipelineJobs(info *changerequest.RepoInfo, pipelineID int) ([]changerequest.Job, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	jobs, err := c.client.GetPipelineJobs(projectInfo, pipelineID)
	if err != nil {
		return nil, err
	}
	return convertJobsToChangeRequest(jobs), nil
}

func (c *MRClient) RestartJob(info *changerequest.RepoInfo, jobID int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.RestartJob(projectInfo, jobID)
}

func (c *MRClient) CancelJob(info *changerequest.RepoInfo, jobID int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.CancelJob(projectInfo, jobID)
}

func (c *MRClient) Close(info *changerequest.RepoInfo, mrNumber int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.CloseChangeRequest(projectInfo, mrNumber)
}

func (c *MRClient) Rebase(info *changerequest.RepoInfo, mrNumber int) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.RebaseChangeRequest(projectInfo, mrNumber)
}

func (c *MRClient) CreateDiffComment(info *changerequest.RepoInfo, mrNumber int, body string, position *changerequest.DiffPosition) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	var pos *DiffPosition
	if position != nil {
		pos = &DiffPosition{
			BaseSHA:      position.BaseSHA,
			HeadSHA:      position.HeadSHA,
			StartSHA:     position.StartSHA,
			PositionType: position.PositionType,
			NewPath:      position.NewPath,
			OldPath:      position.OldPath,
			NewLine:      position.NewLine,
			OldLine:      position.OldLine,
		}
	}
	return c.client.CreateMRDiffComment(projectInfo, mrNumber, body, pos)
}

func (c *MRClient) ReplyToDiscussion(info *changerequest.RepoInfo, mrNumber int, discussionID string, body string) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.ReplyToDiscussion(projectInfo, mrNumber, discussionID, body)
}

func (c *MRClient) ResolveDiscussion(info *changerequest.RepoInfo, mrNumber int, discussionID string, resolved bool) error {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.client.ResolveDiscussion(projectInfo, mrNumber, discussionID, resolved)
}

func (c *MRClient) GetTestSummary(info *changerequest.RepoInfo, pipelineID int) (*changerequest.TestSummary, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	summary, err := c.client.GetTestSummary(projectInfo, pipelineID)
	if err != nil {
		return nil, err
	}
	if summary == nil {
		return nil, nil
	}
	return convertTestSummaryToChangeRequest(summary), nil
}

func (c *MRClient) StreamJobLogs(ctx context.Context, info *changerequest.RepoInfo, jobID int) (chan string, error) {
	projectInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}
	return c.client.StreamJobLogs(ctx, projectInfo, jobID)
}

// --- Conversion helpers for mr types ---

func convertSearchResultsToChangeRequest(results []SearchResult) []changerequest.SearchResult {
	mrResults := make([]changerequest.SearchResult, len(results))
	for i, r := range results {
		mrResults[i] = changerequest.SearchResult{
			Name:          r.Name,
			FullPath:      r.FullPath,
			HTTPURL:       r.HTTPURL,
			DefaultBranch: r.DefaultBranch,
		}
	}
	return mrResults
}

func convertMRsToChangeRequest(mrs []ChangeRequest) []changerequest.ChangeRequest {
	result := make([]changerequest.ChangeRequest, len(mrs))
	for i, m := range mrs {
		result[i] = convertMRToChangeRequest(m)
	}
	return result
}

func convertMRToChangeRequest(m ChangeRequest) changerequest.ChangeRequest {
	result := changerequest.ChangeRequest{
		ID:                          m.ID,
		IID:                         m.IID,
		Title:                       m.Title,
		Description:                 m.Description,
		SourceBranch:                m.SourceBranch,
		TargetBranch:                m.TargetBranch,
		DefaultBranch:               m.DefaultBranch,
		State:                       m.State,
		WebURL:                      m.WebURL,
		CreatedAt:                   m.CreatedAt,
		UpdatedAt:                   m.UpdatedAt,
		Author:                      m.Author,
		MergeStatus:                 m.MergeStatus,
		DetailedMergeStatus:         m.DetailedMergeStatus,
		Draft:                       m.Draft,
		WorkInProgress:              m.WorkInProgress,
		HasConflicts:                m.HasConflicts,
		BlockingDiscussionsResolved: m.BlockingDiscussionsResolved,
		RebaseInProgress:            m.RebaseInProgress,
		MergeError:                  m.MergeError,
	}
	if m.HeadPipeline != nil {
		result.HeadPipeline = &changerequest.PipelineRef{
			ID:     m.HeadPipeline.ID,
			Status: m.HeadPipeline.Status,
			WebURL: m.HeadPipeline.WebURL,
		}
	}
	if m.Approvals != nil {
		result.ApproveStatus = &changerequest.ApproveStatus{
			ApprovalsRequired: m.Approvals.ApprovalsRequired,
			ApprovalsLeft:     m.Approvals.ApprovalsLeft,
			ApprovedBy:        m.Approvals.ApprovedBy,
		}
	}
	return result
}

func convertChangeRequestChangesToChangeRequest(changes []ChangeRequestChange) []changerequest.ChangeRequestChange {
	result := make([]changerequest.ChangeRequestChange, len(changes))
	for i, ch := range changes {
		result[i] = changerequest.ChangeRequestChange{
			OldPath:      ch.OldPath,
			NewPath:      ch.NewPath,
			AMode:        ch.AMode,
			BMode:        ch.BMode,
			NewFile:      ch.NewFile,
			RenamedFile:  ch.RenamedFile,
			DeletedFile:  ch.DeletedFile,
			Diff:         ch.Diff,
			LinesAdded:   ch.LinesAdded,
			LinesDeleted: ch.LinesDeleted,
		}
		if len(ch.DiffLines) > 0 {
			result[i].DiffLines = make([]changerequest.DiffLine, len(ch.DiffLines))
			for j, dl := range ch.DiffLines {
				result[i].DiffLines[j] = changerequest.DiffLine{
					LineCode: dl.LineCode,
					Type:     dl.Type,
					OldLine:  dl.OldLine,
					NewLine:  dl.NewLine,
					Text:     dl.Text,
					RichText: dl.RichText,
				}
			}
		}
	}
	return result
}

func convertDiscussionsToChangeRequest(discussions []Discussion) []changerequest.Discussion {
	result := make([]changerequest.Discussion, len(discussions))
	for i, d := range discussions {
		result[i] = changerequest.Discussion{
			ID:             d.ID,
			IndividualNote: d.IndividualNote,
			Notes:          make([]changerequest.Note, len(d.Notes)),
		}
		for j, n := range d.Notes {
			result[i].Notes[j] = changerequest.Note{
				ID:         n.ID,
				Type:       n.Type,
				Body:       n.Body,
				Author:     changerequest.NoteAuthor(n.Author),
				CreatedAt:  n.CreatedAt,
				UpdatedAt:  n.UpdatedAt,
				System:     n.System,
				Resolvable: n.Resolvable,
				Resolved:   n.Resolved,
			}
		}
	}
	return result
}

func convertPipelinesToChangeRequest(pipelines []Pipeline) []changerequest.Pipeline {
	result := make([]changerequest.Pipeline, len(pipelines))
	for i, p := range pipelines {
		result[i] = changerequest.Pipeline{
			ID:        p.ID,
			IID:       p.IID,
			ProjectID: p.ProjectID,
			Status:    p.Status,
			Ref:       p.Ref,
			SHA:       p.SHA,
			WebURL:    p.WebURL,
			CreatedAt: p.CreatedAt,
			UpdatedAt: p.UpdatedAt,
			User:      p.User,
			Source:    p.Source,
		}
	}
	return result
}

func convertJobsToChangeRequest(jobs []Job) []changerequest.Job {
	result := make([]changerequest.Job, len(jobs))
	for i, j := range jobs {
		result[i] = changerequest.Job{
			ID:             j.ID,
			Name:           j.Name,
			Stage:          j.Stage,
			Status:         j.Status,
			WebURL:         j.WebURL,
			CreatedAt:      j.CreatedAt,
			StartedAt:      j.StartedAt,
			FinishedAt:     j.FinishedAt,
			Duration:       j.Duration,
			QueuedDuration: j.QueuedDuration,
		}
		result[i].Pipeline.ID = j.Pipeline.ID
	}
	return result
}

func convertTestSummaryToChangeRequest(summary *TestSummary) *changerequest.TestSummary {
	if summary == nil {
		return nil
	}
	result := &changerequest.TestSummary{
		Total:   summary.Total,
		Success: summary.Success,
		Failed:  summary.Failed,
		Skipped: summary.Skipped,
		Error:   summary.Error,
	}
	if len(summary.TestSuites) > 0 {
		result.TestSuites = make([]changerequest.TestSuite, len(summary.TestSuites))
		for i, ts := range summary.TestSuites {
			result.TestSuites[i] = changerequest.TestSuite{
				Name: ts.Name,
			}
			if len(ts.TestCases) > 0 {
				result.TestSuites[i].TestCases = make([]changerequest.TestCase, len(ts.TestCases))
				for j, tc := range ts.TestCases {
					result.TestSuites[i].TestCases[j] = changerequest.TestCase{
						Name:      tc.Name,
						Classname: tc.Classname,
						Status:    tc.Status,
						Time:      tc.Time,
						SystemOut: string(tc.SystemOut),
						SystemErr: tc.SystemErr,
					}
				}
			}
		}
	}
	if len(summary.FailedTestGroups) > 0 {
		result.FailedTestGroups = make([]changerequest.FailedTestGroup, len(summary.FailedTestGroups))
		for i, fg := range summary.FailedTestGroups {
			result.FailedTestGroups[i] = changerequest.FailedTestGroup{
				ClassName:   fg.ClassName,
				TestMethods: fg.TestMethods,
			}
		}
	}
	return result
}

// ValidateConnection tests the GitLab API connection and authentication
func (c *client) ValidateConnection() error {
	// Try to get user info to validate connection and authentication
	apiURL := fmt.Sprintf("%s/api/v4/user", c.baseURL)

	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create validation request: %w", err)
	}

	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Check for common network errors
		if strings.Contains(err.Error(), "no such host") {
			return fmt.Errorf("GitLab server not found - check if %s is accessible", c.baseURL)
		}
		if strings.Contains(err.Error(), "connection refused") {
			return fmt.Errorf("connection refused - GitLab server may be down at %s", c.baseURL)
		}
		if strings.Contains(err.Error(), "timeout") {
			return fmt.Errorf("connection timeout - GitLab server at %s is not responding", c.baseURL)
		}
		return fmt.Errorf("failed to connect to GitLab API at %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token and permissions")
	case http.StatusForbidden:
		return fmt.Errorf("GitLab access forbidden - token may lack required permissions")
	case http.StatusNotFound:
		return fmt.Errorf("GitLab API endpoint not found - check server URL: %s", c.baseURL)
	case http.StatusTooManyRequests:
		return fmt.Errorf("GitLab API rate limit exceeded - please try again later")
	case http.StatusInternalServerError:
		return fmt.Errorf("GitLab server error - please try again later")
	case http.StatusOK:
		return nil // Success
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API validation failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// DiffPosition represents the position information for a diff comment
type DiffPosition struct {
	BaseSHA      string `json:"base_sha"`
	HeadSHA      string `json:"head_sha"`
	StartSHA     string `json:"start_sha"`
	PositionType string `json:"position_type"` // "text", "image", or "file"
	NewPath      string `json:"new_path"`
	OldPath      string `json:"old_path"`
	NewLine      *int   `json:"new_line,omitempty"` // For added or context lines
	OldLine      *int   `json:"old_line,omitempty"` // For removed or context lines
}
