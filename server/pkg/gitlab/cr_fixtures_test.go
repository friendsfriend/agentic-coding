package gitlab

// Cross-runtime GitLab change-request and CI fixtures
// (`port-git-providers-and-ai-to-bun`, tasks 1.2, 3.7, 3.8).
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/gitlab \
//	  go test ./pkg/gitlab -run TestWriteGitLabChangeRequestFixtures
import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

type crFixture struct {
	Case      string            `json:"case"`
	Note      string            `json:"note"`
	Responses []issueResponse   `json:"responses"`
	Call      crCall            `json:"call"`
	Requests  []recordedRequest `json:"requests"`
	Error     bool              `json:"error,omitempty"`
	Message   string            `json:"message,omitempty"`
	Value     string            `json:"value,omitempty"`
}

type crCall struct {
	Op          string   `json:"op"`
	Number      int      `json:"number,omitempty"`
	Body        string   `json:"body,omitempty"`
	Discussion  string   `json:"discussionId,omitempty"`
	Resolved    bool     `json:"resolved,omitempty"`
	Username    string   `json:"username,omitempty"`
	SourceB     string   `json:"sourceBranch,omitempty"`
	TargetB     string   `json:"targetBranch,omitempty"`
	State       string   `json:"state,omitempty"`
	Search      string   `json:"search,omitempty"`
	Labels      []string `json:"labels,omitempty"`
	SortBy      string   `json:"sortBy,omitempty"`
	Order       string   `json:"order,omitempty"`
	Page        int      `json:"page,omitempty"`
	PerPage     int      `json:"perPage,omitempty"`
	SkipDetails bool     `json:"skipDetails,omitempty"`
	Positioned  bool     `json:"positioned,omitempty"`
}

func TestWriteGitLabChangeRequestFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range gitlabCRFixtures() {
		transport := &scriptedTransport{responses: fixture.Responses, used: make([]bool, len(fixture.Responses))}
		client := &client{
			baseURL:    "https://gitlab.example.com",
			token:      "fixture-token",
			username:   "octo",
			httpClient: &http.Client{Transport: transport},
		}
		project := &ProjectInfo{Host: "gitlab.example.com", Namespace: "acme", Project: "devenv"}
		recorded := fixture
		var value any
		var err error
		switch fixture.Call.Op {
		case "getChangeRequestsWithOptions":
			value, err = client.GetChangeRequestsWithOptions(project, &changerequest.ChangeRequestListOptions{
				State:         fixture.Call.State,
				Page:          fixture.Call.Page,
				PerPage:       fixture.Call.PerPage,
				SourceBranch:  fixture.Call.SourceB,
				TargetBranch:  fixture.Call.TargetB,
				Search:        fixture.Call.Search,
				Labels:        fixture.Call.Labels,
				SortBy:        fixture.Call.SortBy,
				SortDirection: fixture.Call.Order,
				SkipDetails:   fixture.Call.SkipDetails,
			})
		case "getChangeRequest":
			value, err = client.GetChangeRequest(project, fixture.Call.Number)
		case "getChangeRequestChanges":
			value, err = client.GetChangeRequestChanges(project, fixture.Call.Number)
		case "getMrVersions":
			value, err = client.GetMRVersions(project, fixture.Call.Number)
		case "getMrDiscussions":
			value, err = client.GetMRDiscussions(project, fixture.Call.Number)
		case "createMrDiffComment":
			var position *DiffPosition
			if fixture.Call.Positioned {
				newLine := 12
				position = &DiffPosition{
					BaseSHA: "def4567890abcdef7890abcdef7890abcdef7890", HeadSHA: "abc1234567890abcdef7890abcdef7890abcdef", StartSHA: "def4567890abcdef7890abcdef7890abcdef7890",
					PositionType: "text", NewPath: "src/login.ts", OldPath: "src/login.ts",
					NewLine: &newLine,
				}
			}
			err = client.CreateMRDiffComment(project, fixture.Call.Number, fixture.Call.Body, position)
		case "replyToDiscussion":
			err = client.ReplyToDiscussion(project, fixture.Call.Number, fixture.Call.Discussion, fixture.Call.Body)
		case "resolveDiscussion":
			err = client.ResolveDiscussion(project, fixture.Call.Number, fixture.Call.Discussion, fixture.Call.Resolved)
		case "approve":
			err = client.ApproveChangeRequest(project, fixture.Call.Number)
		case "unapprove":
			err = client.UnapproveChangeRequest(project, fixture.Call.Number)
		case "toggleMrApproval":
			err = client.ToggleMRApproval(project, fixture.Call.Number, fixture.Call.Username)
		case "rebase":
			err = client.RebaseChangeRequest(project, fixture.Call.Number)
		case "close":
			err = client.CloseChangeRequest(project, fixture.Call.Number)
		case "getPipelines":
			value, err = client.GetPipelines(project, fixture.Call.Number)
		case "getPipelineJobs":
			value, err = client.GetPipelineJobs(project, fixture.Call.Number)
		case "getJobLogs":
			value, err = client.GetJobLogs(project, fixture.Call.Number)
		case "getTestSummary":
			value, err = client.GetTestSummary(project, fixture.Call.Number)
		case "restartJob":
			err = client.RestartJob(project, fixture.Call.Number)
		case "cancelJob":
			err = client.CancelJob(project, fixture.Call.Number)
		default:
			t.Fatalf("unknown fixture operation %q", fixture.Call.Op)
		}
		if err != nil {
			recorded.Error = true
			recorded.Message = strings.SplitN(err.Error(), "\n", 2)[0]
		} else {
			encoded, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				t.Fatalf("marshal %s: %v", fixture.Call.Op, marshalErr)
			}
			recorded.Value = string(encoded)
		}
		recorded.Requests = transport.recorded
		writeGitLabJSON(t, filepath.Join(dir, "changerequest", fixture.Case, "fixture.json"), recorded)
	}
}

const glMRJSON = `{"id":41,"iid":9,"title":"Fix login","description":"Closes #7","source_branch":"fix-login","target_branch":"develop","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/merge_requests/9","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z","author":{"name":"Octo","username":"octo"},"head_pipeline":{"id":77,"status":"success","web_url":"https://gitlab.example.com/acme/devenv/-/pipelines/77"},"merge_status":"can_be_merged","detailed_merge_status":"mergeable","draft":false,"work_in_progress":false,"has_conflicts":false,"blocking_discussions_resolved":true,"rebase_in_progress":false,"merge_error":""}`

const glApprovalsJSON = `{"approvals_required":2,"approvals_left":1,"approved_by":[{"user":{"name":"Hubot","username":"hubot"}}]}`

const glDiff = "@@ -10,3 +10,3 @@\n context\n-removed\n+added\n more"

func gitlabCRFixtures() []crFixture {
	return []crFixture{
		{
			Case: "mr-list",
			Note: "the options list paginates from the X-* headers, sorts by updated_at by default and attaches approvals plus detail per item",
			Responses: []issueResponse{
				{Match: "/merge_requests?", Status: http.StatusOK,
					Headers: map[string]string{"X-Total": "12", "X-Total-Pages": "3", "X-Page": "2"},
					Body:    `[` + glMRJSON + `]`},
				{Match: "/merge_requests/9/approvals", Status: http.StatusOK, Body: glApprovalsJSON},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON},
			},
			Call: crCall{Op: "getChangeRequestsWithOptions", State: "opened", Page: 2, PerPage: 25,
				SourceB: "fix-login", TargetB: "develop", Search: "login", Labels: []string{"bug"},
				SortBy: "created", Order: "asc"},
		},
		{
			Case: "mr-list-skip-details",
			Note: "skip-details avoids the per-item detail and approval reads",
			Responses: []issueResponse{{
				Match: "/merge_requests?", Status: http.StatusOK, Body: `[` + glMRJSON + `]`,
			}},
			Call: crCall{Op: "getChangeRequestsWithOptions", State: "opened", Page: 1, PerPage: 50, SkipDetails: true},
		},
		{
			Case: "mr-detail",
			Note: "merge request detail maps the provider payload and attaches approvals",
			Responses: []issueResponse{
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON},
				{Match: "/merge_requests/9/approvals", Status: http.StatusOK, Body: glApprovalsJSON},
			},
			Call: crCall{Op: "getChangeRequest", Number: 9},
		},
		{
			Case: "mr-detail-approvals-unavailable",
			Note: "an unavailable approvals endpoint (GitLab CE) leaves the merge request without approvals",
			Responses: []issueResponse{
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON},
				{Match: "/merge_requests/9/approvals", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`},
			},
			Call: crCall{Op: "getChangeRequest", Number: 9},
		},
		{
			Case: "mr-changes",
			Note: "changed files recompute their line stats from the diff and carry positioned diff lines with the GitLab line code",
			Responses: []issueResponse{{
				Match:  "/merge_requests/9/changes",
				Status: http.StatusOK,
				Body: `{"changes":[` +
					`{"old_path":"src/login.ts","new_path":"src/login.ts","a_mode":"100644","b_mode":"100644","new_file":false,"renamed_file":false,"deleted_file":false,"diff":` + jsonString(glDiff) + `},` +
					`{"old_path":"src/was.ts","new_path":"src/moved.ts","a_mode":"100644","b_mode":"100644","new_file":false,"renamed_file":true,"deleted_file":false,"diff":""}]` +
					`,"diff_refs":{"base_sha":"def4567890abcdef7890abcdef7890abcdef7890","head_sha":"abc1234567890abcdef7890abcdef7890abcdef","start_sha":"def4567890abcdef7890abcdef7890abcdef7890"}}`,
			}},
			Call: crCall{Op: "getChangeRequestChanges", Number: 9},
		},
		{
			Case: "mr-changes-no-diff-refs",
			Note: "without a base_sha no positioned lines are produced, only the diff itself",
			Responses: []issueResponse{{
				Match:  "/merge_requests/9/changes",
				Status: http.StatusOK,
				Body:   `{"changes":[{"old_path":"a.txt","new_path":"a.txt","a_mode":"100644","b_mode":"100644","new_file":true,"renamed_file":false,"deleted_file":false,"diff":` + jsonString(glDiff) + `}],"diff_refs":{}}`,
			}},
			Call: crCall{Op: "getChangeRequestChanges", Number: 9},
		},
		{
			Case: "mr-changes-not-found",
			Note: "a missing change request reports the Go diagnostic",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/changes", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`,
			}},
			Call: crCall{Op: "getChangeRequestChanges", Number: 9},
		},
		{
			Case: "mr-versions",
			Note: "the versions endpoint returns the provider's diff versions",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/versions", Status: http.StatusOK,
				Body: `[{"id":1,"head_commit_sha":"abc1234567890abcdef7890abcdef7890abcdef","base_commit_sha":"def4567890abcdef7890abcdef7890abcdef7890","start_commit_sha":"def4567890abcdef7890abcdef7890abcdef7890","created_at":"2026-01-02T03:04:05.000Z"}]`,
			}},
			Call: crCall{Op: "getMrVersions", Number: 9},
		},
		{
			Case: "mr-versions-fallback",
			Note: "an unavailable versions endpoint falls back to the merge request diff_refs",
			Responses: []issueResponse{
				{Match: "/merge_requests/9/versions", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: `{"diff_refs":{"base_sha":"def4567890abcdef7890abcdef7890abcdef7890","head_sha":"abc1234567890abcdef7890abcdef7890abcdef","start_sha":"def4567890abcdef7890abcdef7890abcdef7890"}}`},
			},
			Call: crCall{Op: "getMrVersions", Number: 9},
		},
		{
			Case: "mr-discussions",
			Note: "discussion threads keep their notes, resolvable state and diff position",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/discussions", Status: http.StatusOK,
				Body: `[{"id":"abc","individual_note":false,"notes":[` +
					`{"id":31,"type":"DiffNote","body":"root","author":{"id":1,"username":"octo","name":"Octo","avatar_url":""},"created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-02T03:04:05.000Z","system":false,"resolvable":true,"resolved":false,"position":{"base_sha":"def4567890abcdef7890abcdef7890abcdef7890","start_sha":"def4567890abcdef7890abcdef7890abcdef7890","head_sha":"abc1234567890abcdef7890abcdef7890abcdef","old_path":"src/login.ts","new_path":"src/login.ts","position_type":"text","new_line":12}},` +
					`{"id":32,"type":"DiffNote","body":"reply","author":{"id":2,"username":"hubot","name":"Hubot","avatar_url":""},"created_at":"2026-01-02T04:04:05.000Z","updated_at":"2026-01-02T04:04:05.000Z","system":false,"resolvable":true,"resolved":true}]},` +
					`{"id":"def","individual_note":true,"notes":[{"id":33,"type":"DiscussionNote","body":"general","author":{"id":1,"username":"octo","name":"Octo","avatar_url":""},"created_at":"2026-01-02T05:04:05.000Z","updated_at":"2026-01-02T05:04:05.000Z","system":false,"resolvable":false,"resolved":false}]}]`,
			}},
			Call: crCall{Op: "getMrDiscussions", Number: 9},
		},
		{
			Case: "mr-comment",
			Note: "an inline comment sends the position with the head/base/start SHAs and the line",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/discussions", Status: http.StatusCreated, Body: `{"id":"abc"}`,
			}},
			Call: crCall{Op: "createMrDiffComment", Number: 9, Body: "looks good", Positioned: true},
		},
		{
			Case: "mr-comment-rejected",
			Note: "a rejected comment reports the provider status and body",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/discussions", Status: http.StatusBadRequest, Body: `{"message":"400 Bad Request"}`,
			}},
			Call: crCall{Op: "createMrDiffComment", Number: 9, Body: "looks good"},
		},
		{
			Case: "mr-reply",
			Note: "a reply is posted to the discussion's notes endpoint",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/discussions/abc/notes", Status: http.StatusCreated, Body: `{}`,
			}},
			Call: crCall{Op: "replyToDiscussion", Number: 9, Discussion: "abc", Body: "thanks"},
		},
		{
			Case: "mr-resolve",
			Note: "resolving puts the resolved flag on the discussion",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/discussions/abc", Status: http.StatusOK, Body: `{}`,
			}},
			Call: crCall{Op: "resolveDiscussion", Number: 9, Discussion: "abc", Resolved: true},
		},
		{
			Case: "mr-approve",
			Note: "approving posts to the approve endpoint",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/approve", Status: http.StatusCreated, Body: `{}`,
			}},
			Call: crCall{Op: "approve", Number: 9},
		},
		{
			Case: "mr-unapprove",
			Note: "unapproving posts to the unapprove endpoint",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/unapprove", Status: http.StatusCreated, Body: `{}`,
			}},
			Call: crCall{Op: "unapprove", Number: 9},
		},
		{
			Case: "mr-toggle-approval",
			Note: "toggling approves when the configured user has not approved yet",
			Responses: []issueResponse{
				{Match: "/merge_requests/9/approvals", Status: http.StatusOK, Body: `{"approvals_required":1,"approvals_left":1,"approved_by":[{"user":{"name":"Hubot","username":"hubot"}}]}`},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON},
				{Match: "/merge_requests/9/approve", Status: http.StatusCreated, Body: `{}`},
			},
			Call: crCall{Op: "toggleMrApproval", Number: 9, Username: "octo"},
		},
		{
			Case: "mr-toggle-unapprove",
			Note: "toggling unapproves when the display name matches an existing approval",
			Responses: []issueResponse{
				{Match: "/merge_requests/9/approvals", Status: http.StatusOK, Body: `{"approvals_required":1,"approvals_left":0,"approved_by":[{"user":{"name":"Kellner, Fabian","username":"F19918"}}]}`},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON},
				{Match: "/merge_requests/9/unapprove", Status: http.StatusCreated, Body: `{}`},
			},
			Call: crCall{Op: "toggleMrApproval", Number: 9, Username: "Kellner, Fabian"},
		},
		{
			Case: "mr-rebase",
			Note: "a rebase accepts both 200 and the queued 202",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/rebase", Status: http.StatusAccepted, Body: `{}`,
			}},
			Call: crCall{Op: "rebase", Number: 9},
		},
		{
			Case: "mr-rebase-conflict",
			Note: "a rebase already in progress reports the Go diagnostic",
			Responses: []issueResponse{{
				Match: "/merge_requests/9/rebase", Status: http.StatusConflict, Body: `{}`,
			}},
			Call: crCall{Op: "rebase", Number: 9},
		},
		{
			Case: "mr-close",
			Note: "closing sends a form-encoded state_event",
			Responses: []issueResponse{{
				Match: "/merge_requests/9", Status: http.StatusOK, Body: glMRJSON,
			}},
			Call: crCall{Op: "close", Number: 9},
		},
		{
			Case: "ci-pipelines",
			Note: "pipelines are ordered by id descending and the limit is clamped",
			Responses: []issueResponse{{
				Match: "/pipelines?", Status: http.StatusOK,
				Body: `[{"id":77,"iid":12,"project_id":3,"status":"success","ref":"fix-login","sha":"abc1234567890abcdef7890abcdef7890abcdef","web_url":"https://gitlab.example.com/acme/devenv/-/pipelines/77","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-02T03:05:05.000Z","user":{"name":"Octo","username":"octo"},"source":"push"}]`,
			}},
			Call: crCall{Op: "getPipelines", Number: 500},
		},
		{
			Case: "ci-jobs",
			Note: "pipeline jobs keep the provider timestamps and durations",
			Responses: []issueResponse{{
				Match: "/pipelines/77/jobs", Status: http.StatusOK,
				Body: `[{"id":101,"name":"build","stage":"build","status":"success","web_url":"https://gitlab.example.com/acme/devenv/-/jobs/101","created_at":"2026-01-02T03:04:05.000Z","started_at":"2026-01-02T03:04:10.000Z","finished_at":"2026-01-02T03:06:05.000Z","duration":115.5,"queued_duration":5.0,"runner":{"id":1,"description":"shared","name":"runner"},"pipeline":{"id":77}}]`,
			}},
			Call: crCall{Op: "getPipelineJobs", Number: 77},
		},
		{
			Case: "ci-job-logs",
			Note: "job logs are fetched as plain text from the trace endpoint",
			Responses: []issueResponse{{
				Match: "/jobs/101/trace", Status: http.StatusOK, Body: "log line one\nlog line two\n",
			}},
			Call: crCall{Op: "getJobLogs", Number: 101},
		},
		{
			Case: "ci-job-logs-missing",
			Note: "a missing trace reports the Go diagnostic",
			Responses: []issueResponse{{
				Match: "/jobs/101/trace", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`,
			}},
			Call: crCall{Op: "getJobLogs", Number: 101},
		},
		{
			Case: "ci-test-summary",
			Note: "the test report is mapped onto the provider summary and a flexible system_output is normalized to a string",
			Responses: []issueResponse{{
				Match: "/pipelines/77/test_report", Status: http.StatusOK,
				Body: `{"total_time":12.5,"total_count":3,"success_count":1,"failed_count":1,"skipped_count":1,"error_count":0,"test_suites":[{"name":"suite","test_cases":[` +
					`{"name":"passes","classname":"com.example.Spec","status":"success","execution_time":1.5,"system_output":"ok"},` +
					`{"name":"fails","classname":"com.example.Spec","status":"failed","execution_time":2.5,"system_output":{"value":"boom"},"stack_trace":"trace"}]}]}`,
			}},
			Call: crCall{Op: "getTestSummary", Number: 77},
		},
		{
			Case: "ci-test-summary-missing",
			Note: "a pipeline without a test report answers null instead of failing",
			Responses: []issueResponse{{
				Match: "/pipelines/77/test_report", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`,
			}},
			Call: crCall{Op: "getTestSummary", Number: 77},
		},
		{
			Case: "ci-job-retry",
			Note: "a retry expects 201 and reports the provider diagnostics otherwise",
			Responses: []issueResponse{{
				Match: "/jobs/101/retry", Status: http.StatusCreated, Body: `{"id":102}`,
			}},
			Call: crCall{Op: "restartJob", Number: 101},
		},
		{
			Case: "ci-job-retry-rejected",
			Note: "a non-restartable job reports the Go diagnostic",
			Responses: []issueResponse{{
				Match: "/jobs/101/retry", Status: http.StatusBadRequest, Body: `{}`,
			}},
			Call: crCall{Op: "restartJob", Number: 101},
		},
		{
			Case: "ci-job-cancel",
			Note: "a cancel expects 201",
			Responses: []issueResponse{{
				Match: "/jobs/101/cancel", Status: http.StatusCreated, Body: `{"id":101}`,
			}},
			Call: crCall{Op: "cancelJob", Number: 101},
		},
	}
}

// jsonString encodes a value as a JSON string literal for embedding.
func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
