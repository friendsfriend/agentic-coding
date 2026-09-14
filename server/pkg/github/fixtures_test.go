package github

// Cross-runtime provider fixtures for the GitHub client
// (`port-git-providers-and-ai-to-bun`, task 1.2).
//
// A fixture pins both sides of one call: the exact HTTP request the Go client
// issues (method, URL, selected headers) and the parsed result it produced from
// a canned provider response. The Bun client replays the same response through
// its injectable fetch and must issue the same request and produce the same
// value, so provider-specific pagination/limit/error behavior is proven by
// fixture instead of by calling a live provider from both runtimes.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/github \
//	  go test ./pkg/github -run TestWriteGitHubFixtures
import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordedRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body,omitempty"`
}

type fixtureCall struct {
	Op      string `json:"op"`
	Query   string `json:"query,omitempty"`
	Limit   int    `json:"limit,omitempty"`
	Number  int    `json:"number,omitempty"`
	Error   bool   `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Value   string `json:"value,omitempty"`
}

type githubFixture struct {
	Case     string          `json:"case"`
	Note     string          `json:"note"`
	Response fixtureResponse `json:"response"`
	Call     fixtureCall     `json:"call"`
	Request  recordedRequest `json:"request"`
}

type fixtureResponse struct {
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers,omitempty"`
}

// recordingTransport serves one canned response and records the request.
type recordingTransport struct {
	response fixtureResponse
	recorded recordedRequest
}

// readerOrEmpty tolerates the nil body a GET request carries.
func readerOrEmpty(body io.Reader) io.Reader {
	if body == nil {
		return strings.NewReader("")
	}
	return body
}

func (t *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(readerOrEmpty(req.Body))
	t.recorded = recordedRequest{
		Method: req.Method,
		URL:    req.URL.String(),
		Headers: map[string]string{
			"accept":               req.Header.Get("Accept"),
			"authorization":        req.Header.Get("Authorization"),
			"x-github-api-version": req.Header.Get("X-GitHub-Api-Version"),
			"user-agent":           req.Header.Get("User-Agent"),
			"content-type":         req.Header.Get("Content-Type"),
		},
		Body: string(body),
	}
	headers := http.Header{}
	for name, value := range t.response.Headers {
		headers.Set(name, value)
	}
	return &http.Response{
		StatusCode: t.response.Status,
		Header:     headers,
		Body:       io.NopCloser(strings.NewReader(t.response.Body)),
		Request:    req,
	}, nil
}

func TestWriteGitHubFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range githubFixtures() {
		transport := &recordingTransport{response: fixture.Response}
		client := newClientWithContext(nil, "fixture-token", "octo", &http.Client{Transport: transport})
		recorded := fixture
		switch fixture.Call.Op {
		case "search":
			results, err := client.Search(nil, fixture.Call.Query, fixture.Call.Limit)
			recordGitHubErr(&recorded.Call, err)
			if err == nil {
				recorded.Call.Value = marshalGitHubValue(t, results)
			}
		default:
			t.Fatalf("unknown fixture operation %q", fixture.Call.Op)
		}
		recorded.Request = transport.recorded
		writeGitHubJSON(t, filepath.Join(dir, fixture.Case, "fixture.json"), recorded)
	}
}

func marshalGitHubValue(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture value: %v", err)
	}
	return string(data)
}

func recordGitHubErr(call *fixtureCall, err error) {
	if err == nil {
		call.Error = false
		call.Message = ""
		return
	}
	call.Error = true
	call.Message = strings.SplitN(err.Error(), "\n", 2)[0]
}

func writeGitHubJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	data, err := json.MarshalIndent(value, "", "\t")
	if err != nil {
		t.Fatalf("marshal %s: %v", path, err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func githubFixtures() []githubFixture {
	return []githubFixture{
		{
			Case: "search",
			Note: "repository search maps the provider payload and clamps the requested page size",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body: `{"total_count":2,"items":[` +
					`{"name":"devenv","full_name":"acme/devenv","clone_url":"https://github.com/acme/devenv.git","default_branch":"main"},` +
					`{"name":"tools","full_name":"acme/tools","clone_url":"https://github.com/acme/tools.git","default_branch":"trunk"}]}`,
			},
			Call: fixtureCall{Op: "search", Query: "acme devenv", Limit: 500},
		},
		{
			Case: "search-empty",
			Note: "an empty result set stays an empty list, not an error",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body:   `{"total_count":0,"items":[]}`,
			},
			Call: fixtureCall{Op: "search", Query: "nothing", Limit: 0},
		},
		{
			Case: "search-rate-limited",
			Note: "a provider error status becomes a bounded diagnostic that names the status and body",
			Response: fixtureResponse{
				Status: http.StatusForbidden,
				Body:   `{"message":"API rate limit exceeded"}`,
			},
			Call: fixtureCall{Op: "search", Query: "acme", Limit: 20},
		},
		{
			Case: "search-malformed",
			Note: "unparseable provider content fails the call instead of yielding a partial list",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body:   `{"items":[{"name":`,
			},
			Call: fixtureCall{Op: "search", Query: "acme", Limit: 20},
		},
		{
			Case: "search-change-requests",
			Note: "the search projection keeps the unified changerequest result shape",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body: `{"total_count":1,"items":[` +
					`{"name":"devenv","full_name":"acme/devenv","clone_url":"https://github.com/acme/devenv.git","default_branch":"main"}]}`,
			},
			Call: fixtureCall{Op: "search", Query: "acme", Limit: 20},
		},
	}
}
