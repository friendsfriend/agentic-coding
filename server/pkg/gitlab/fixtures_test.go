package gitlab

// Cross-runtime provider fixtures for the GitLab client
// (`port-git-providers-and-ai-to-bun`, task 1.2). See
// `pkg/github/fixtures_test.go` for the fixture rationale: the request the Go
// client issues and the parsed value it produced are pinned together, and the
// Bun client replays the canned response through its injectable fetch.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/gitlab \
//	  go test ./pkg/gitlab -run TestWriteGitLabFixtures
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

type fixtureResponse struct {
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers,omitempty"`
}

type fixtureCall struct {
	Op      string `json:"op"`
	BaseURL string `json:"baseUrl,omitempty"`
	Query   string `json:"query,omitempty"`
	Limit   int    `json:"limit,omitempty"`
	Error   bool   `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Value   string `json:"value,omitempty"`
}

type gitlabFixture struct {
	Case     string          `json:"case"`
	Note     string          `json:"note"`
	Response fixtureResponse `json:"response"`
	Call     fixtureCall     `json:"call"`
	Request  recordedRequest `json:"request"`
}

// recordingTransport serves one canned response and records the request.
type recordingTransport struct {
	response fixtureResponse
	recorded recordedRequest
}

func (t *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(readerOrEmpty(req.Body))
	t.recorded = recordedRequest{
		Method: req.Method,
		URL:    req.URL.String(),
		Headers: map[string]string{
			"accept":        req.Header.Get("Accept"),
			"private-token": req.Header.Get("PRIVATE-TOKEN"),
			"user-agent":    req.Header.Get("User-Agent"),
			"content-type":  req.Header.Get("Content-Type"),
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

// readerOrEmpty tolerates the nil body a GET request carries.
func readerOrEmpty(body io.Reader) io.Reader {
	if body == nil {
		return strings.NewReader("")
	}
	return body
}

func TestWriteGitLabFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range gitlabFixtures() {
		transport := &recordingTransport{response: fixture.Response}
		client := &client{
			baseURL:    fixture.Call.BaseURL,
			token:      "fixture-token",
			username:   "octo",
			httpClient: &http.Client{Transport: transport},
		}
		recorded := fixture
		switch fixture.Call.Op {
		case "searchProjects":
			results, err := client.SearchProjects(fixture.Call.Query, fixture.Call.Limit)
			recordGitLabErr(&recorded.Call, err)
			if err == nil {
				recorded.Call.Value = marshalGitLabValue(t, results)
			}
		default:
			t.Fatalf("unknown fixture operation %q", fixture.Call.Op)
		}
		recorded.Request = transport.recorded
		writeGitLabJSON(t, filepath.Join(dir, fixture.Case, "fixture.json"), recorded)
	}
}

func marshalGitLabValue(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture value: %v", err)
	}
	return string(data)
}

func recordGitLabErr(call *fixtureCall, err error) {
	if err == nil {
		call.Error = false
		call.Message = ""
		return
	}
	call.Error = true
	call.Message = strings.SplitN(err.Error(), "\n", 2)[0]
}

func writeGitLabJSON(t *testing.T, path string, value any) {
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

func gitlabFixtures() []gitlabFixture {
	return []gitlabFixture{
		{
			Case: "search-projects",
			Note: "membership-scoped project search maps the provider payload and clamps the page size",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body: `[{"name":"devenv","path_with_namespace":"acme/devenv","http_url_to_repo":"https://gitlab.example.com/acme/devenv.git","default_branch":"main"},` +
					`{"name":"tools","path_with_namespace":"acme/tools","http_url_to_repo":"https://gitlab.example.com/acme/tools.git","default_branch":null}]`,
			},
			Call: fixtureCall{Op: "searchProjects", BaseURL: "https://gitlab.example.com", Query: "acme", Limit: 500},
		},
		{
			Case: "search-projects-empty",
			Note: "an empty project list stays empty, not an error",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body:   `[]`,
			},
			Call: fixtureCall{Op: "searchProjects", BaseURL: "https://gitlab.example.com", Query: "nothing", Limit: 0},
		},
		{
			Case: "search-projects-error",
			Note: "a provider error status becomes a bounded diagnostic that names the status and body",
			Response: fixtureResponse{
				Status: http.StatusUnauthorized,
				Body:   `{"message":"401 Unauthorized"}`,
			},
			Call: fixtureCall{Op: "searchProjects", BaseURL: "https://gitlab.example.com", Query: "acme", Limit: 20},
		},
		{
			Case: "search-projects-malformed",
			Note: "unparseable provider content fails the call instead of yielding a partial list",
			Response: fixtureResponse{
				Status: http.StatusOK,
				Body:   `[{"name":`,
			},
			Call: fixtureCall{Op: "searchProjects", BaseURL: "https://gitlab.example.com", Query: "acme", Limit: 20},
		},
	}
}
