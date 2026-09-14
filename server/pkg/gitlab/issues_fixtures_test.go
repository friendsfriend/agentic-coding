package gitlab

// Cross-runtime GitLab issue fixtures (`port-git-providers-and-ai-to-bun`,
// tasks 1.2, 3.5, 3.6). A case pins a whole flow: every HTTP request the Go
// issues client issued, the canned provider response for each, and the parsed
// value it produced.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/gitlab \
//	  go test ./pkg/gitlab -run TestWriteGitLabIssueFixtures
import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/issues"
)

type issueResponse struct {
	Match   string            `json:"match"`
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers,omitempty"`
}

type issueCall struct {
	Op       string   `json:"op"`
	Number   int      `json:"number,omitempty"`
	Body     string   `json:"body,omitempty"`
	Labels   []string `json:"labels,omitempty"`
	Scope    string   `json:"scope,omitempty"`
	State    string   `json:"state,omitempty"`
	Search   string   `json:"search,omitempty"`
	SortBy   string   `json:"sortBy,omitempty"`
	Order    string   `json:"order,omitempty"`
	Page     int      `json:"page,omitempty"`
	PerPage  int      `json:"perPage,omitempty"`
	Username string   `json:"username,omitempty"`
}

type issueFixture struct {
	Case      string            `json:"case"`
	Note      string            `json:"note"`
	Responses []issueResponse   `json:"responses"`
	Call      issueCall         `json:"call"`
	Requests  []recordedRequest `json:"requests"`
	Error     bool              `json:"error,omitempty"`
	Message   string            `json:"message,omitempty"`
	Value     string            `json:"value,omitempty"`
}

// scriptedTransport serves the case's canned responses in order and records
// every request.
type scriptedTransport struct {
	responses []issueResponse
	used      []bool
	recorded  []recordedRequest
}

func (t *scriptedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(readerOrEmpty(req.Body))
	t.recorded = append(t.recorded, recordedRequest{
		Method: req.Method,
		URL:    req.URL.String(),
		Headers: map[string]string{
			"accept":        req.Header.Get("Accept"),
			"content-type":  req.Header.Get("Content-Type"),
			"private-token": req.Header.Get("PRIVATE-TOKEN"),
		},
		Body: string(body),
	})
	index := -1
	for i, candidate := range t.responses {
		if strings.Contains(req.URL.String(), candidate.Match) && !t.used[i] {
			index = i
			break
		}
	}
	if index < 0 {
		for i, candidate := range t.responses {
			if strings.Contains(req.URL.String(), candidate.Match) {
				index = i
			}
		}
	}
	if index < 0 {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Header:     http.Header{},
			Body:       io.NopCloser(strings.NewReader(`{"message":"no fixture response"}`)),
			Request:    req,
		}, nil
	}
	t.used[index] = true
	headers := http.Header{}
	for name, value := range t.responses[index].Headers {
		headers.Set(name, value)
	}
	return &http.Response{
		StatusCode: t.responses[index].Status,
		Header:     headers,
		Body:       io.NopCloser(strings.NewReader(t.responses[index].Body)),
		Request:    req,
	}, nil
}

func TestWriteGitLabIssueFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range gitlabIssueFixtures() {
		transport := &scriptedTransport{responses: fixture.Responses, used: make([]bool, len(fixture.Responses))}
		client := &client{
			baseURL:    "https://gitlab.example.com",
			token:      "fixture-token",
			username:   "octo",
			httpClient: &http.Client{Transport: transport},
		}
		project := &ProjectInfo{Host: "gitlab.example.com", Namespace: "acme", Project: "devenv"}
		concrete := NewIssuesClient(client, project).(*IssuesClient)
		issuesClient := issues.Client(concrete)
		recorded := fixture
		var value any
		var err error
		switch fixture.Call.Op {
		case "getIssues":
			value, err = issuesClient.GetIssues(nil, &issues.IssueListOptions{
				Scope:         fixture.Call.Scope,
				State:         fixture.Call.State,
				Search:        fixture.Call.Search,
				Labels:        fixture.Call.Labels,
				SortBy:        fixture.Call.SortBy,
				SortDirection: fixture.Call.Order,
				Page:          fixture.Call.Page,
				PerPage:       fixture.Call.PerPage,
			})
		case "getIssue":
			value, err = issuesClient.GetIssue(nil, fixture.Call.Number)
		case "getIssueComments":
			value, err = issuesClient.GetIssueComments(nil, fixture.Call.Number)
		case "closeIssue":
			value, err = issuesClient.CloseIssue(nil, fixture.Call.Number, fixture.Call.Body)
		case "reopenIssue":
			value, err = issuesClient.ReopenIssue(nil, fixture.Call.Number)
		case "setLabels":
			value, err = issuesClient.SetLabels(nil, fixture.Call.Number, fixture.Call.Labels)
		case "addAssignee":
			value, err = issuesClient.AddAssignee(nil, fixture.Call.Number, fixture.Call.Body)
		case "removeAssignee":
			value, err = issuesClient.RemoveAssignee(nil, fixture.Call.Number)
		case "addComment":
			value, err = issuesClient.AddComment(nil, fixture.Call.Number, fixture.Call.Body)
		case "getRepoLabels":
			value, err = issuesClient.GetRepoLabels(nil)
		case "getRepoCollaborators":
			value, err = issuesClient.GetRepoCollaborators(nil)
		case "getIssueLinkedChangeRequests":
			value, err = issuesClient.GetIssueLinkedChangeRequests(nil, fixture.Call.Number)
		case "getIssueReferencedIssues":
			value, err = concrete.GetIssueReferencedIssues(nil, fixture.Call.Number)
		case "getChangeRequestLinkedIssues":
			value, err = concrete.GetChangeRequestLinkedIssues(project, fixture.Call.Number)
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
		writeGitLabJSON(t, filepath.Join(dir, "issues", fixture.Case, "fixture.json"), recorded)
	}
}

const glIssueJSON = `{"id":11,"iid":7,"title":"Broken login","description":"Fixes #3 and !9","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/issues/7","author":{"name":"Octo","username":"octo"},"labels":["bug","p1"],"assignees":[{"name":"Octo","username":"octo"}],"milestone":{"title":"v1"},"created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z"}`

const glNoteJSON = `{"id":21,"body":"me too","author":{"name":"Hubot","username":"hubot"},"created_at":"2026-01-04T03:04:05.000Z","updated_at":"2026-01-04T03:04:05.000Z","system":false}`

const glClosedByMRJSON = `{"id":41,"iid":9,"title":"Fix login","description":"Closes #7","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/merge_requests/9","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z","author":{"name":"Octo","username":"octo"},"source_branch":"fix-login","target_branch":"develop","merge_status":"can_be_merged","draft":false,"work_in_progress":false,"has_conflicts":false,"blocking_discussions_resolved":true,"head_pipeline":{"id":77,"status":"success","web_url":"https://gitlab.example.com/acme/devenv/-/pipelines/77"}}`

func gitlabIssueFixtures() []issueFixture {
	return []issueFixture{
		{
			Case: "issues-list",
			Note: "searched, filtered and sorted page: the scope becomes a GitLab scope value, the state is normalized to opened and the totals come from the pagination headers",
			Responses: []issueResponse{{
				Match:  "/issues?",
				Status: http.StatusOK,
				Headers: map[string]string{
					"X-Total":       "12",
					"X-Total-Pages": "3",
					"X-Page":        "2",
				},
				Body: `[` + glIssueJSON + `]`,
			}},
			Call: issueCall{Op: "getIssues", Scope: "assigned-to-me", State: "open", Search: "login",
				Labels: []string{"bug", "p1"}, SortBy: "created", Order: "asc", Page: 2, PerPage: 25},
		},
		{
			Case: "issues-no-assignee",
			Note: "the no-assignee scope becomes assignee_id=None and an unknown sort falls back to updated_at",
			Responses: []issueResponse{{
				Match: "/issues?", Status: http.StatusOK, Body: `[]`,
			}},
			Call: issueCall{Op: "getIssues", Scope: "no-assignee", State: "closed", SortBy: "unsupported", Page: 1, PerPage: 50},
		},
		{
			Case: "issue-detail",
			Note: "issue detail maps the provider payload onto the canonical issue shape",
			Responses: []issueResponse{{
				Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON,
			}},
			Call: issueCall{Op: "getIssue", Number: 7},
		},
		{
			Case: "issue-detail-error",
			Note: "a provider error status becomes a bounded diagnostic",
			Responses: []issueResponse{{
				Match: "/issues/7", Status: http.StatusNotFound, Body: `{"message":"404 Not Found"}`,
			}},
			Call: issueCall{Op: "getIssue", Number: 7},
		},
		{
			Case: "issue-comments",
			Note: "notes become comments with the provider system flag and an unknown total",
			Responses: []issueResponse{{
				Match: "/issues/7/notes", Status: http.StatusOK, Body: `[` + glNoteJSON + `]`,
			}},
			Call: issueCall{Op: "getIssueComments", Number: 7},
		},
		{
			Case: "issue-close",
			Note: "closing sends state_event=close",
			Responses: []issueResponse{{
				Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON,
			}},
			Call: issueCall{Op: "closeIssue", Number: 7, Body: "completed"},
		},
		{
			Case: "issue-reopen",
			Note: "reopening sends state_event=reopen",
			Responses: []issueResponse{{
				Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON,
			}},
			Call: issueCall{Op: "reopenIssue", Number: 7},
		},
		{
			Case: "issue-set-labels",
			Note: "labels are replaced through the issue update endpoint",
			Responses: []issueResponse{{
				Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON,
			}},
			Call: issueCall{Op: "setLabels", Number: 7, Labels: []string{"bug", "p1"}},
		},
		{
			Case: "issue-assignee",
			Note: "assigning sends assignee_ids with the username and unassigning sends an empty list",
			Responses: []issueResponse{
				{Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON},
				{Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON},
			},
			Call: issueCall{Op: "addAssignee", Number: 7, Body: "octo"},
		},
		{
			Case: "issue-comment",
			Note: "adding a note posts the body and maps the created note",
			Responses: []issueResponse{{
				Match: "/issues/7/notes", Status: http.StatusCreated, Body: glNoteJSON,
			}},
			Call: issueCall{Op: "addComment", Number: 7, Body: "me too"},
		},
		{
			Case: "issue-comment-rejected",
			Note: "a note the provider rejects reports its status and body",
			Responses: []issueResponse{{
				Match: "/issues/7/notes", Status: http.StatusBadRequest, Body: `{"message":"400 Bad Request"}`,
			}},
			Call: issueCall{Op: "addComment", Number: 7, Body: "me too"},
		},
		{
			Case: "issue-repo-labels",
			Note: "repository labels are flattened to names",
			Responses: []issueResponse{{
				Match: "/labels", Status: http.StatusOK, Body: `[{"name":"bug"},{"name":"p1"}]`,
			}},
			Call: issueCall{Op: "getRepoLabels"},
		},
		{
			Case: "issue-repo-collaborators",
			Note: "project members are flattened to usernames",
			Responses: []issueResponse{{
				Match: "/members", Status: http.StatusOK, Body: `[{"name":"Octo","username":"octo"},{"name":"Hubot","username":"hubot"}]`,
			}},
			Call: issueCall{Op: "getRepoCollaborators"},
		},
		{
			Case: "issue-linked-crs",
			Note: "linked change requests merge closed_by, issue links and inline !9 references, deduplicated by IID",
			Responses: []issueResponse{
				{Match: "/issues/7/closed_by", Status: http.StatusOK, Body: `[` + glClosedByMRJSON + `]`},
				{Match: "/issues/7/links", Status: http.StatusOK, Body: `[{"link_type":"relates_to","target":{"id":42,"iid":10,"title":"Draft MR","state":"opened","type":"merge_request","web_url":"https://gitlab.example.com/acme/devenv/-/merge_requests/10","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z","author":{"name":"Octo","username":"octo"}}},{"link_type":"relates_to","target":{"id":11,"iid":7,"title":"An issue","state":"opened","type":"issue","web_url":"https://gitlab.example.com/acme/devenv/-/issues/7"}}]`},
				{Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: glClosedByMRJSON},
			},
			Call: issueCall{Op: "getIssueLinkedChangeRequests", Number: 7},
		},
		{
			Case: "issue-referenced-issues",
			Note: "referenced issues come from bare #N references and skip the ones that cannot be read",
			Responses: []issueResponse{
				{Match: "/issues/7", Status: http.StatusOK, Body: glIssueJSON},
				{Match: "/issues/3", Status: http.StatusOK, Body: glIssueJSON},
				{Match: "/issues/9", Status: http.StatusForbidden, Body: `{"message":"403 Forbidden"}`},
			},
			Call: issueCall{Op: "getIssueReferencedIssues", Number: 7},
		},
		{
			Case: "cr-linked-issues",
			Note: "issues linked to a merge request come from closes_issues first, then from #N references in the description",
			Responses: []issueResponse{
				{Match: "/merge_requests/9/closes_issues", Status: http.StatusOK, Body: `[{"id":11,"iid":7,"title":"Broken login","description":"","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/issues/7","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z","author":{"name":"Octo","username":"octo"},"labels":["bug"],"assignees":[]}]`},
				{Match: "/merge_requests/9", Status: http.StatusOK, Body: `{"description":"Also closes #12"}`},
				{Match: "/issues/12", Status: http.StatusOK, Body: glIssueJSON},
			},
			Call: issueCall{Op: "getChangeRequestLinkedIssues", Number: 9},
		},
	}
}
