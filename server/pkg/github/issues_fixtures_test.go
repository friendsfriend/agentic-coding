package github

// Cross-runtime issue fixtures (`port-git-providers-and-ai-to-bun`, task 1.2,
// consumed by task 3.1). A case pins a whole flow: every HTTP request the Go
// issues client issued, the canned provider response for each, and the parsed
// value it produced. The Bun client replays the same responses through its
// injectable fetch, so pagination, filtering, timeline merging and mutation
// payloads are proven by fixture rather than by calling a live provider.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/github \
//	  go test ./pkg/github -run TestWriteIssueFixtures
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

// issueResponse is one canned provider response, selected by the first URL
// substring that matches.
type issueResponse struct {
	Match   string            `json:"match"`
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers,omitempty"`
}

type issueCall struct {
	Op      string               `json:"op"`
	Repo    string               `json:"repo,omitempty"`
	Number  int                  `json:"number,omitempty"`
	Body    string               `json:"body,omitempty"`
	Labels  []string             `json:"labels,omitempty"`
	Options *issueListOptionsOut `json:"options,omitempty"`
}

type issueListOptionsOut struct {
	Scope         string   `json:"scope,omitempty"`
	State         string   `json:"state,omitempty"`
	Search        string   `json:"search,omitempty"`
	Labels        []string `json:"labels,omitempty"`
	SortBy        string   `json:"sortBy,omitempty"`
	SortDirection string   `json:"sortDirection,omitempty"`
	Page          int      `json:"page,omitempty"`
	PerPage       int      `json:"perPage,omitempty"`
	SourceBranch  string   `json:"sourceBranch,omitempty"`
	TargetBranch  string   `json:"targetBranch,omitempty"`
	SkipDetails   bool     `json:"skipDetails,omitempty"`
	Positioned    bool     `json:"positioned,omitempty"`
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
			"authorization": req.Header.Get("Authorization"),
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
		// A repeated URL (a re-fetch after a mutation) reuses the last matching
		// response, which is what a live provider would answer with again.
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

func TestWriteIssueFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range issueFixtures() {
		transport := &scriptedTransport{responses: fixture.Responses, used: make([]bool, len(fixture.Responses))}
		client := newClientWithContext(nil, "fixture-token", "octo", &http.Client{Transport: transport})
		repoInfo := &RepoInfo{Owner: "acme", Repo: "devenv"}
		if fixture.Call.Repo != "" {
			parts := strings.SplitN(fixture.Call.Repo, "/", 2)
			repoInfo = &RepoInfo{Owner: parts[0], Repo: parts[1]}
		}
		concrete := NewIssuesClient(client, repoInfo).(*IssuesClient)
		issuesClient := issues.Client(concrete)
		recorded := fixture
		var value any
		var err error
		switch fixture.Call.Op {
		case "getIssues":
			options := &issues.IssueListOptions{}
			if fixture.Call.Options != nil {
				options = &issues.IssueListOptions{
					Scope:         fixture.Call.Options.Scope,
					State:         fixture.Call.Options.State,
					Search:        fixture.Call.Options.Search,
					Labels:        fixture.Call.Options.Labels,
					SortBy:        fixture.Call.Options.SortBy,
					SortDirection: fixture.Call.Options.SortDirection,
					Page:          fixture.Call.Options.Page,
					PerPage:       fixture.Call.Options.PerPage,
				}
			}
			value, err = issuesClient.GetIssues(nil, options)
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
			value, err = concrete.GetChangeRequestLinkedIssues(repoInfo, fixture.Call.Number)
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
		writeGitHubJSON(t, filepath.Join(dir, "issues", fixture.Case, "fixture.json"), recorded)
	}
}

// issueJSON is one issue payload shared by several cases.
const issueJSON = `{"id":11,"number":7,"title":"Broken login","body":"Closes #3 and fixes acme/other#4","state":"open","html_url":"https://github.com/acme/devenv/issues/7","user":{"login":"octo"},"labels":[{"name":"bug"},{"name":"p1"}],"assignees":[{"login":"octo"}],"milestone":{"title":"v1"},"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}`

const issueCommentJSON = `{"id":21,"body":"me too","user":{"login":"hubot"},"created_at":"2026-01-04T03:04:05Z","updated_at":"2026-01-04T03:04:05Z"}`

const issueTimelineJSON = `[` +
	`{"id":31,"event":"commented","actor":{"login":"hubot"},"created_at":"2026-01-04T03:04:05Z","body":"me too"},` +
	`{"id":32,"event":"labeled","actor":{"login":"octo"},"created_at":"2026-01-05T03:04:05Z","label":{"name":"bug"}},` +
	`{"id":33,"event":"assigned","actor":{"login":"octo"},"created_at":"2026-01-05T03:04:05Z","assignee":{"login":"octo"}},` +
	`{"id":34,"event":"renamed","actor":{"login":"octo"},"created_at":"2026-01-05T03:04:05Z","rename":{"from":"Old","to":"New"}},` +
	`{"id":35,"event":"cross-referenced","actor":{"login":"octo"},"created_at":"2026-01-05T03:04:05Z","source":{"type":"issue","issue":{"number":9,"title":"PR nine","pull_request":{}}}},` +
	`{"id":36,"event":"closed","actor":{"login":"octo"},"created_at":"2026-01-06T03:04:05Z"}]`

func issueFixtures() []issueFixture {
	return []issueFixture{
		{
			Case: "issues-search",
			Note: "searched, filtered and sorted page: the scope becomes a search qualifier, labels become label: qualifiers and pull requests are filtered out after parsing",
			Responses: []issueResponse{{
				Match:  "/search/issues",
				Status: http.StatusOK,
				Body: `{"total_count":3,"items":[` + issueJSON +
					`,{"id":12,"number":8,"title":"A pull request","pull_request":{},"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:04:05Z"}]}`,
			}},
			Call: issueCall{Op: "getIssues", Options: &issueListOptionsOut{
				Scope: "assigned-to-me", State: "open", Search: "login", Labels: []string{"bug", "p1"},
				SortBy: "created", SortDirection: "asc", Page: 2, PerPage: 25,
			}},
		},
		{
			Case: "issues-state-all",
			Note: "state=all uses the list endpoint (search cannot express it), keeps the Link-header page count and reports an unknown total",
			Responses: []issueResponse{{
				Match:  "/repos/acme/devenv/issues?",
				Status: http.StatusOK,
				Headers: map[string]string{
					"Link": `<https://api.github.com/repos/acme/devenv/issues?page=3>; rel="next", <https://api.github.com/repos/acme/devenv/issues?page=5>; rel="last"`,
				},
				Body: `[` + issueJSON + `,{"id":12,"number":8,"title":"A pull request","pull_request":{},"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:04:05Z"}]`,
			}},
			Call: issueCall{Op: "getIssues", Options: &issueListOptionsOut{
				State: "all", Page: 3, PerPage: 10, SortBy: "comments", SortDirection: "asc",
			}},
		},
		{
			Case: "issues-sort-fallback",
			Note: "an unsupported sort field falls back to updated and the page size is clamped to the provider maximum",
			Responses: []issueResponse{{
				Match:  "/search/issues",
				Status: http.StatusOK,
				Body:   `{"total_count":0,"items":[]}`,
			}},
			Call: issueCall{Op: "getIssues", Options: &issueListOptionsOut{
				State: "closed", SortBy: "unsupported", Page: 1, PerPage: 500,
			}},
		},
		{
			Case: "issue-detail",
			Note: "issue detail maps the provider payload onto the canonical issue shape",
			Responses: []issueResponse{{
				Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON,
			}},
			Call: issueCall{Op: "getIssue", Number: 7},
		},
		{
			Case: "issue-detail-error",
			Note: "a provider error status becomes a bounded diagnostic that names the status and body",
			Responses: []issueResponse{{
				Match: "/repos/acme/devenv/issues/7", Status: http.StatusNotFound, Body: `{"message":"Not Found"}`,
			}},
			Call: issueCall{Op: "getIssue", Number: 7},
		},
		{
			Case: "issue-comments",
			Note: "comments are merged with timeline events as system notes; commented events are not duplicated and an event with no label falls back to its raw name",
			Responses: []issueResponse{
				{Match: "/issues/7/comments", Status: http.StatusOK, Body: `[` + issueCommentJSON + `]`},
				{Match: "/issues/7/timeline", Status: http.StatusOK, Body: issueTimelineJSON},
			},
			Call: issueCall{Op: "getIssueComments", Number: 7},
		},
		{
			Case: "issue-comments-timeline-unavailable",
			Note: "a timeline that cannot be read still returns the regular comments",
			Responses: []issueResponse{
				{Match: "/issues/7/comments", Status: http.StatusOK, Body: `[` + issueCommentJSON + `]`},
				{Match: "/issues/7/timeline", Status: http.StatusForbidden, Body: `{"message":"Forbidden"}`},
			},
			Call: issueCall{Op: "getIssueComments", Number: 7},
		},
		{
			Case: "issue-close",
			Note: "closing sends state_reason and re-reads the issue for the updated state",
			Responses: []issueResponse{
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
			},
			Call: issueCall{Op: "closeIssue", Number: 7, Body: "not_planned"},
		},
		{
			Case: "issue-reopen",
			Note: "reopening sends state=open",
			Responses: []issueResponse{{
				Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON,
			}},
			Call: issueCall{Op: "reopenIssue", Number: 7},
		},
		{
			Case: "issue-set-labels",
			Note: "setting labels replaces them and re-reads the issue",
			Responses: []issueResponse{
				{Match: "/issues/7/labels", Status: http.StatusOK, Body: `[{"name":"bug"}]`},
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
			},
			Call: issueCall{Op: "setLabels", Number: 7, Labels: []string{"bug", "p1"}},
		},
		{
			Case: "issue-assignee",
			Note: "adding and removing an assignee use the assignees endpoint and re-read the issue",
			Responses: []issueResponse{
				{Match: "/issues/7/assignees", Status: http.StatusOK, Body: `{}`},
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
				{Match: "/issues/7/assignees", Status: http.StatusOK, Body: `{}`},
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
			},
			Call: issueCall{Op: "addAssignee", Number: 7, Body: "octo"},
		},
		{
			Case: "issue-comment",
			Note: "adding a comment posts the body and maps the created comment",
			Responses: []issueResponse{{
				Match: "/issues/7/comments", Status: http.StatusCreated, Body: issueCommentJSON,
			}},
			Call: issueCall{Op: "addComment", Number: 7, Body: "me too"},
		},
		{
			Case: "issue-comment-rejected",
			Note: "a comment the provider rejects reports its status and body instead of a created comment",
			Responses: []issueResponse{{
				Match: "/issues/7/comments", Status: http.StatusUnprocessableEntity, Body: `{"message":"Validation Failed"}`,
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
			Note: "collaborators are flattened to logins",
			Responses: []issueResponse{{
				Match: "/collaborators", Status: http.StatusOK, Body: `[{"login":"octo"},{"login":"hubot"}]`,
			}},
			Call: issueCall{Op: "getRepoCollaborators"},
		},
		{
			Case: "issue-linked-crs",
			Note: "linked change requests combine closing keywords and bare references from the body with timeline cross-references, in that order and without duplicates",
			Responses: []issueResponse{
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
				{Match: "/pulls/3", Status: http.StatusOK, Body: pullJSON},
				{Match: "/pulls/4", Status: http.StatusOK, Body: pullJSON},
				{Match: "/issues/7/timeline", Status: http.StatusOK, Body: issueTimelineJSON},
				{Match: "/pulls/9", Status: http.StatusOK, Body: pullJSON},
			},
			Call: issueCall{Op: "getIssueLinkedChangeRequests", Number: 7},
		},
		{
			Case: "issue-referenced-issues",
			Note: "referenced issues exclude pull requests and skip the ones that cannot be read",
			Responses: []issueResponse{
				{Match: "/repos/acme/devenv/issues/7", Status: http.StatusOK, Body: issueJSON},
				{Match: "/repos/acme/devenv/issues/3", Status: http.StatusOK, Body: issueJSON},
				{Match: "/repos/acme/devenv/issues/4", Status: http.StatusForbidden, Body: `{"message":"Forbidden"}`},
			},
			Call: issueCall{Op: "getIssueReferencedIssues", Number: 7},
		},
		{
			Case: "cr-linked-issues",
			Note: "issues linked to a change request come from the change request body and exclude pull requests",
			Responses: []issueResponse{
				{Match: "/pulls/9", Status: http.StatusOK, Body: pullJSON},
				{Match: "/repos/acme/devenv/issues/3", Status: http.StatusOK, Body: issueJSON},
				{Match: "/repos/acme/devenv/issues/4", Status: http.StatusOK, Body: issueJSON},
			},
			Call: issueCall{Op: "getChangeRequestLinkedIssues", Number: 9},
		},
	}
}

// pullJSON is one pull-request payload shared by the linked-reference cases.
const pullJSON = `{"id":41,"number":9,"title":"Fix login","body":"Closes #3 and acme/other#4","state":"open","html_url":"https://github.com/acme/devenv/pull/9","user":{"login":"octo"},"head":{"ref":"fix-login","sha":"abc123"},"base":{"ref":"main","sha":"def456"},"mergeable":true,"mergeable_state":"clean","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}`
