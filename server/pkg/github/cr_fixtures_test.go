package github

// Cross-runtime change-request and CI fixtures
// (`port-git-providers-and-ai-to-bun`, tasks 1.2, 3.3, 3.4). See
// `issues_fixtures_test.go` for the flow shape; this file adds the pull
// request, discussion, approval and Actions cases.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/github \
//	  go test ./pkg/github -run TestWriteChangeRequestFixtures
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

type crFixture struct {
	Case      string          `json:"case"`
	Note      string          `json:"note"`
	Responses []issueResponse `json:"responses"`
	// RedirectBody is served from a local listener when a case exercises the
	// job-log redirect, so no live provider is contacted.
	RedirectBody string            `json:"redirectBody,omitempty"`
	Call         issueCall         `json:"call"`
	Requests     []recordedRequest `json:"requests"`
	Error        bool              `json:"error,omitempty"`
	Message      string            `json:"message,omitempty"`
	Value        string            `json:"value,omitempty"`
}

func TestWriteChangeRequestFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range crFixtures() {
		responses := make([]issueResponse, len(fixture.Responses))
		copy(responses, fixture.Responses)
		if fixture.RedirectBody != "" {
			logs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(fixture.RedirectBody))
			}))
			defer logs.Close()
			for i := range responses {
				for name, value := range responses[i].Headers {
					responses[i].Headers[name] = strings.ReplaceAll(value, "{{redirect}}", logs.URL+"/logs")
				}
			}
		}
		transport := &scriptedTransport{responses: responses, used: make([]bool, len(responses))}
		client := newClientWithContext(nil, "fixture-token", "octo", &http.Client{Transport: transport})
		repoInfo := &RepoInfo{Owner: "acme", Repo: "devenv"}
		crInfo := repoInfo.ToChangeRequest()
		recorded := fixture
		var value any
		var err error
		switch fixture.Call.Op {
		case "getChangeRequests":
			options := &changerequest.ChangeRequestListOptions{}
			if fixture.Call.Options != nil {
				options = &changerequest.ChangeRequestListOptions{
					SourceBranch:  fixture.Call.Options.SourceBranch,
					TargetBranch:  fixture.Call.Options.TargetBranch,
					State:         fixture.Call.Options.State,
					Search:        fixture.Call.Options.Search,
					Labels:        fixture.Call.Options.Labels,
					SortBy:        fixture.Call.Options.SortBy,
					SortDirection: fixture.Call.Options.SortDirection,
					Page:          fixture.Call.Options.Page,
					PerPage:       fixture.Call.Options.PerPage,
					SkipDetails:   fixture.Call.Options.SkipDetails,
				}
			}
			value, err = client.GetChangeRequests(crInfo, options)
		case "getPullRequest":
			value, err = client.GetPullRequest(repoInfo, fixture.Call.Number)
		case "getChangeRequestChanges":
			value, err = client.GetChangeRequestChanges(crInfo, fixture.Call.Number)
		case "getDiscussions":
			value, err = client.GetDiscussions(crInfo, fixture.Call.Number)
		case "approve":
			err = client.Approve(crInfo, fixture.Call.Number)
		case "unapprove":
			err = client.Unapprove(crInfo, fixture.Call.Number)
		case "toggleApproval":
			err = client.ToggleApproval(crInfo, fixture.Call.Number)
		case "close":
			err = client.Close(crInfo, fixture.Call.Number)
		case "rebase":
			err = client.Rebase(crInfo, fixture.Call.Number)
		case "resolveDiscussion":
			err = client.ResolveDiscussion(crInfo, fixture.Call.Number, "1", true)
		case "createDiffComment":
			var position *changerequest.DiffPosition
			if fixture.Call.Options != nil && fixture.Call.Options.Positioned {
				newLine := 12
				position = &changerequest.DiffPosition{
					HeadSHA:  "abc123",
					NewPath:  "src/login.ts",
					NewLine:  &newLine,
					OldPath:  "src/login.ts",
					OldLine:  nil,
					BaseSHA:  "def456",
					StartSHA: "def456",
				}
			}
			err = client.CreateDiffComment(crInfo, fixture.Call.Number, fixture.Call.Body, position)
		case "replyToDiscussion":
			err = client.ReplyToDiscussion(crInfo, fixture.Call.Number, "31", fixture.Call.Body)
		case "getPipelineJobs":
			value, err = client.GetPipelineJobs(crInfo, fixture.Call.Number)
		case "getJobLogs":
			value, err = client.GetJobLogs(crInfo, fixture.Call.Number)
		default:
			t.Fatalf("unknown fixture operation %q", fixture.Call.Op)
		}
		if err != nil {
			recorded.Error = true
			recorded.Message = strings.SplitN(err.Error(), "\n", 2)[0]
		} else {
			encoded, marshalErr := json.Marshal(canonicalFixtureValue(value))
			if marshalErr != nil {
				t.Fatalf("marshal %s: %v", fixture.Call.Op, marshalErr)
			}
			recorded.Value = string(encoded)
		}
		recorded.Requests = transport.recorded
		writeGitHubJSON(t, filepath.Join(dir, "changerequest", fixture.Case, "fixture.json"), recorded)
	}
}

// canonicalFixtureValue sorts every approved-by list so a fixture is a
// contract: the Go client iterated a map, so its order was incidental and the
// Bun port sorts by username.
func canonicalFixtureValue(value any) any {
	switch typed := value.(type) {
	case *changerequest.ChangeRequestListResult:
		for i := range typed.ChangeRequests {
			sortApprovalEntries(typed.ChangeRequests[i].ApproveStatus)
		}
		return typed
	case *changerequest.ChangeRequest:
		sortApprovalEntries(typed.ApproveStatus)
		return typed
	case []changerequest.ChangeRequest:
		for i := range typed {
			sortApprovalEntries(typed[i].ApproveStatus)
		}
		return typed
	case *MergeRequestApprovals:
		sortApprovedBy(typed)
		return typed
	case *ChangeRequest:
		sortApprovedBy(typed.Approvals)
		return typed
	default:
		return value
	}
}

func sortApprovalEntries(status *changerequest.ApproveStatus) {
	if status == nil {
		return
	}
	sort.Slice(status.ApprovedBy, func(i, j int) bool {
		return status.ApprovedBy[i].User.Username < status.ApprovedBy[j].User.Username
	})
}

func sortApprovedBy(approvals *MergeRequestApprovals) {
	if approvals == nil {
		return
	}
	sort.Slice(approvals.ApprovedBy, func(i, j int) bool {
		return approvals.ApprovedBy[i].User.Username < approvals.ApprovedBy[j].User.Username
	})
}

// reviewJSON is a review list with a stale approval that was later dismissed
// and a current approval.
const reviewJSON = `[` +
	`{"id":51,"user":{"login":"hubot"},"state":"CHANGES_REQUESTED"},` +
	`{"id":52,"user":{"login":"hubot"},"state":"APPROVED"},` +
	`{"id":53,"user":{"login":"dependabot"},"state":"APPROVED"}]`

const runJSON = `{"total_count":1,"workflow_runs":[{"id":77,"name":"ci","status":"completed","conclusion":"success","html_url":"https://github.com/acme/devenv/actions/runs/77","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:05:05Z","head_sha":"abc123","head_branch":"fix-login"}]}`

func crFixtures() []crFixture {
	return []crFixture{
		{
			Case: "pr-list",
			Note: "the pull-request list endpoint maps state, paginates from the Link header and attaches approvals plus the latest workflow run per item",
			Responses: []issueResponse{
				{
					Match:  "/pulls?",
					Status: http.StatusOK,
					Headers: map[string]string{
						"Link": `<https://api.github.com/repos/acme/devenv/pulls?page=2>; rel="next", <https://api.github.com/repos/acme/devenv/pulls?page=4>; rel="last"`,
					},
					Body: `[` + pullJSON + `]`,
				},
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: reviewJSON},
				{Match: "/actions/runs?", Status: http.StatusOK, Body: runJSON},
			},
			Call: issueCall{Op: "getChangeRequests", Options: &issueListOptionsOut{
				State: "opened", Page: 2, PerPage: 25, SortBy: "created", SortDirection: "asc",
			}},
		},
		{
			Case: "pr-list-search",
			Note: "a search or label filter switches to the issue search endpoint with type:pr and then loads the full pull request for each hit",
			Responses: []issueResponse{
				{Match: "/search/issues", Status: http.StatusOK, Body: `{"total_count":1,"items":[{"number":9,"title":"Fix login","body":"Closes #3","state":"open","html_url":"https://github.com/acme/devenv/pull/9","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:04:05Z","user":{"login":"octo"}}]}`},
				{Match: "/pulls/9", Status: http.StatusOK, Body: pullJSON},
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: reviewJSON},
				{Match: "/actions/runs?", Status: http.StatusOK, Body: runJSON},
			},
			Call: issueCall{Op: "getChangeRequests", Options: &issueListOptionsOut{
				State: "opened", Search: "login", Labels: []string{"bug"}, Page: 1, PerPage: 50,
			}},
		},
		{
			Case: "pr-list-skip-details",
			Note: "skip-details avoids the per-item approval and workflow-run reads",
			Responses: []issueResponse{{
				Match: "/pulls?", Status: http.StatusOK, Body: `[` + pullJSON + `]`,
			}},
			Call: issueCall{Op: "getChangeRequests", Options: &issueListOptionsOut{
				State: "opened", SkipDetails: true, Page: 1, PerPage: 50,
			}},
		},
		{
			Case: "pr-detail",
			Note: "pull request detail maps mergeability, the merged state and the pipeline reference",
			Responses: []issueResponse{
				{Match: "/pulls/9", Status: http.StatusOK, Body: pullJSON},
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: reviewJSON},
				{Match: "/actions/runs?", Status: http.StatusOK, Body: runJSON},
			},
			Call: issueCall{Op: "getPullRequest", Number: 9},
		},
		{
			Case: "pr-detail-conflicts",
			Note: "an unmergeable pull request reports conflicts and the provider mergeable state",
			Responses: []issueResponse{
				{Match: "/pulls/9", Status: http.StatusOK, Body: `{"id":41,"number":9,"title":"Fix login","body":"","state":"closed","merged":true,"html_url":"https://github.com/acme/devenv/pull/9","user":{"login":"octo"},"head":{"ref":"fix-login","sha":"abc123"},"base":{"ref":"main","sha":"def456"},"mergeable":false,"mergeable_state":"dirty","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}`},
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: `[]`},
				{Match: "/actions/runs?", Status: http.StatusOK, Body: `{"total_count":0,"workflow_runs":[]}`},
			},
			Call: issueCall{Op: "getPullRequest", Number: 9},
		},
		{
			Case: "pr-changes",
			Note: "changed files keep added, removed and renamed identity and carry positioned diff lines with the Go line identity",
			Responses: []issueResponse{{
				Match:  "/pulls/9/files",
				Status: http.StatusOK,
				Body: `[` +
					`{"filename":"src/login.ts","status":"modified","additions":1,"deletions":1,"patch":"@@ -10,3 +10,3 @@\n context\n-removed\n+added\n more"},` +
					`{"filename":"src/new.ts","status":"added","additions":2,"deletions":0,"patch":"@@ -0,0 +1,2 @@\n+one\n+two"},` +
					`{"filename":"src/old.ts","status":"removed","additions":0,"deletions":1,"patch":"@@ -1,1 +0,0 @@\n-gone"},` +
					`{"filename":"src/moved.ts","previous_filename":"src/was.ts","status":"renamed","additions":0,"deletions":0}]`,
			}},
			Call: issueCall{Op: "getChangeRequestChanges", Number: 9},
		},
		{
			Case: "pr-discussions",
			Note: "review threads keep replies attached to their root, issue comments become individual notes and timeline events become system notes without duplicating commented events",
			Responses: []issueResponse{
				{Match: "/pulls/9/comments", Status: http.StatusOK, Body: `[` +
					`{"id":31,"body":"root","user":{"login":"octo"},"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:04:05Z","path":"src/login.ts","in_reply_to_id":null},` +
					`{"id":32,"body":"reply","user":{"login":"hubot"},"created_at":"2026-01-02T04:04:05Z","updated_at":"2026-01-02T04:04:05Z","path":"src/login.ts","in_reply_to_id":31}]`},
				{Match: "/issues/9/comments", Status: http.StatusOK, Body: `[` + issueCommentJSON + `]`},
				{Match: "/issues/9/timeline", Status: http.StatusOK, Body: issueTimelineJSON},
			},
			Call: issueCall{Op: "getDiscussions", Number: 9},
		},
		{
			Case: "pr-approve",
			Note: "approving posts an APPROVE review",
			Responses: []issueResponse{{
				Match: "/pulls/9/reviews", Status: http.StatusOK, Body: `{"id":54}`,
			}},
			Call: issueCall{Op: "approve", Number: 9},
		},
		{
			Case: "pr-unapprove",
			Note: "unapproving dismisses the newest approval of the authenticated user",
			Responses: []issueResponse{
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: reviewJSON},
				{Match: "/dismissals", Status: http.StatusOK, Body: `{}`},
			},
			Call: issueCall{Op: "unapprove", Number: 9},
		},
		{
			Case: "pr-unapprove-none",
			Note: "unapproving without an own approval fails with the Go diagnostic instead of silently succeeding",
			Responses: []issueResponse{{
				Match: "/pulls/9/reviews", Status: http.StatusOK, Body: `[{"id":51,"user":{"login":"hubot"},"state":"APPROVED"}]`,
			}},
			Call: issueCall{Op: "unapprove", Number: 9},
		},
		{
			Case: "pr-toggle-approval",
			Note: "toggling approves when the authenticated user has not approved yet",
			Responses: []issueResponse{
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: `[{"id":51,"user":{"login":"hubot"},"state":"APPROVED"}]`},
				{Match: "/pulls/9/reviews", Status: http.StatusOK, Body: `{"id":54}`},
			},
			Call: issueCall{Op: "toggleApproval", Number: 9},
		},
		{
			Case: "pr-close",
			Note: "closing a pull request patches its state",
			Responses: []issueResponse{{
				Match: "/pulls/9", Status: http.StatusOK, Body: `{}`,
			}},
			Call: issueCall{Op: "close", Number: 9},
		},
		{
			Case:      "pr-rebase-unsupported",
			Note:      "server-side rebase is rejected with the Go diagnostic",
			Responses: []issueResponse{},
			Call:      issueCall{Op: "rebase", Number: 9},
		},
		{
			Case:      "pr-resolve-unsupported",
			Note:      "resolving a discussion is rejected with the Go diagnostic",
			Responses: []issueResponse{},
			Call:      issueCall{Op: "resolveDiscussion", Number: 9},
		},
		{
			Case: "pr-diff-comment",
			Note: "an inline comment sends the head commit, path, side and line derived from the position",
			Responses: []issueResponse{{
				Match: "/pulls/9/comments", Status: http.StatusCreated, Body: `{"id":61}`,
			}},
			Call: issueCall{Op: "createDiffComment", Number: 9, Body: "looks good", Options: &issueListOptionsOut{Positioned: true}},
		},
		{
			Case: "pr-reply",
			Note: "a discussion reply sends in_reply_to with the root comment id",
			Responses: []issueResponse{{
				Match: "/pulls/9/comments", Status: http.StatusCreated, Body: `{"id":62}`,
			}},
			Call: issueCall{Op: "replyToDiscussion", Number: 9, Body: "thanks"},
		},
		{
			Case: "ci-jobs",
			Note: "workflow run jobs map onto the GitLab job shape with a duration only when both timestamps exist",
			Responses: []issueResponse{{
				Match:  "/actions/runs/77/jobs",
				Status: http.StatusOK,
				Body: `{"total_count":3,"jobs":[` +
					`{"id":101,"name":"build","status":"completed","conclusion":"success","started_at":"2026-01-02T03:04:05Z","completed_at":"2026-01-02T03:06:05Z","html_url":"https://github.com/acme/devenv/actions/runs/77/job/101","run_id":77},` +
					`{"id":102,"name":"test","status":"in progress","conclusion":"","started_at":"2026-01-02T03:06:05Z","completed_at":"0001-01-01T00:00:00Z","html_url":"https://github.com/acme/devenv/actions/runs/77/job/102","run_id":77},` +
					`{"id":103,"name":"lint","status":"queued","conclusion":"","started_at":"0001-01-01T00:00:00Z","completed_at":"0001-01-01T00:00:00Z","html_url":"https://github.com/acme/devenv/actions/runs/77/job/103","run_id":77}]}`,
			}},
			Call: issueCall{Op: "getPipelineJobs", Number: 77},
		},
		{
			Case: "ci-job-logs",
			Note: "job logs follow the provider redirect without the API credential",
			Responses: []issueResponse{{
				Match:   "/actions/jobs/101/logs",
				Status:  http.StatusFound,
				Headers: map[string]string{"Location": "{{redirect}}"},
				Body:    "",
			}},
			RedirectBody: "log line one\nlog line two\n",
			Call:         issueCall{Op: "getJobLogs", Number: 101},
		},
	}
}
