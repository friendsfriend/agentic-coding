package server

// Cross-runtime Pi session fixtures (`port-git-providers-and-ai-to-bun`,
// tasks 1.2, 4.1). The fixture records the session directory tree that was
// read and the grouped result `queryPiSessions()` produced for it, so the Bun
// discovery can be asserted against real Go output without either runtime
// executing file content.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/pi-sessions \
//	  go test ./pkg/server -run TestWritePiSessionFixtures
import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type sessionFixtureFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type sessionFixture struct {
	Case     string               `json:"case"`
	Note     string               `json:"note"`
	Files    []sessionFixtureFile `json:"files"`
	Agents   []agentGroup         `json:"agents"`
	Note2    string               `json:"-"`
	PiInPath bool                 `json:"piInPath"`
}

func TestWritePiSessionFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range piSessionFixtures() {
		root := t.TempDir()
		for _, file := range fixture.Files {
			target := filepath.Join(root, filepath.FromSlash(file.Path))
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				t.Fatalf("mkdir %s: %v", filepath.Dir(target), err)
			}
			if err := os.WriteFile(target, []byte(file.Content), 0644); err != nil {
				t.Fatalf("write %s: %v", target, err)
			}
		}
		t.Setenv("PI_CODING_AGENT_DIR", root)
		groups, err := queryPiSessions()
		if err != nil {
			t.Fatalf("queryPiSessions: %v", err)
		}
		// The Go grouping iterates a map, so its order is incidental; the
		// fixture is captured sorted by group name and the Bun port sorts too.
		sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
		for i := range groups {
			sort.SliceStable(groups[i].Sessions, func(a, b int) bool {
				return groups[i].Sessions[a].ID < groups[i].Sessions[b].ID
			})
		}
		recorded := fixture
		recorded.Agents = groups
		// Session ids are absolute paths; record them relative to the root.
		for i := range recorded.Agents {
			for j := range recorded.Agents[i].Sessions {
				recorded.Agents[i].Sessions[j].ID = strings.TrimPrefix(
					recorded.Agents[i].Sessions[j].ID, root+string(filepath.Separator))
			}
		}
		writeServerFixture(t, filepath.Join(dir, fixture.Case, "fixture.json"), recorded)
	}
}

func writeServerFixture(t *testing.T, path string, value any) {
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

// sessionLine builds one JSONL line of the given type.
func sessionLine(typ string, fields string) string {
	if fields == "" {
		return `{"type":"` + typ + `"}`
	}
	return `{"type":"` + typ + `",` + fields + `}`
}

const normalSession = `{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/home/octo/projects/devenv"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Fix the login flow"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}
`

const longTitleSession = `{"type":"session","timestamp":"2026-02-03T04:05:06Z","cwd":"/home/octo/projects/devenv"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Please refactor the entire authentication subsystem so that it uses a single shared token store"}]}}
`

const multiLineTitleSession = `{"type":"session","timestamp":"2026-03-04T05:06:07Z","cwd":"/home/octo/projects/other"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Line one\n\tline two   line three"}]}}
`

const headerOnlySession = `{"type":"session","timestamp":"2026-04-05T06:07:08Z","cwd":"/home/octo/projects/other"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"no user message"}]}}
`

const malformedSession = `not json at all
{"type":"session","timestamp":"2026-05-06T07:08:09Z","cwd":"/home/octo/projects/broken"}
{"type":"message","message":
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"survives a malformed line"}]}}
`

const noHeaderSession = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"no header here"}]}}
`

const noCwdSession = `{"type":"session","timestamp":"2026-06-07T08:09:10Z"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"cwd missing"}]}}
`

func piSessionFixtures() []sessionFixture {
	// A line longer than the scanner's 1 MB buffer stops the file's parse.
	oversized := strings.Repeat("x", 1024*1024+16)
	return []sessionFixture{
		{
			Case:     "sessions",
			Note:     "sessions are grouped by the basename of their working directory, titles are truncated to 57 characters plus an ellipsis, and the timestamp is the creation and update time in milliseconds",
			PiInPath: true,
			Files: []sessionFixtureFile{
				{Path: "sessions/-home-octo-projects-devenv/aaa.jsonl", Content: normalSession},
				{Path: "sessions/-home-octo-projects-devenv/bbb.jsonl", Content: longTitleSession},
				{Path: "sessions/-home-octo-projects-other/ccc.jsonl", Content: multiLineTitleSession},
				{Path: "sessions/-home-octo-projects-other/ddd.jsonl", Content: headerOnlySession},
				{Path: "sessions/-home-octo-projects-other/notes.txt", Content: "not a session\n"},
				{Path: "sessions/-home-octo-projects-other/nested/deep.jsonl", Content: normalSession},
			},
		},
		{
			Case:     "malformed",
			Note:     "a malformed line is skipped, a file without a session header is skipped and a session without a cwd falls back to the directory slug",
			PiInPath: true,
			Files: []sessionFixtureFile{
				{Path: "sessions/-home-octo-projects-broken/bad.jsonl", Content: malformedSession},
				{Path: "sessions/-home-octo-projects-broken/headerless.jsonl", Content: noHeaderSession},
				{Path: "sessions/-slug-only/plain.jsonl", Content: noCwdSession},
			},
		},
		{
			Case:     "oversized-line",
			Note:     "a line above the 1 MB read bound stops that file's parse without failing the whole listing",
			PiInPath: true,
			Files: []sessionFixtureFile{
				{Path: "sessions/-home-octo-projects-devenv/big.jsonl", Content: normalSession + sessionLine("message", `"message":{"role":"user","content":[{"type":"text","text":"`+oversized+`"}]}`) + "\n"},
				{Path: "sessions/-home-octo-projects-devenv/small.jsonl", Content: normalSession},
			},
		},
		{
			Case:     "empty",
			Note:     "an absent sessions directory is not an error",
			PiInPath: true,
			Files:    []sessionFixtureFile{{Path: "sessions/.keep", Content: ""}},
		},
	}
}
