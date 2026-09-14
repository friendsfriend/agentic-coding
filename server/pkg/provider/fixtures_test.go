package provider

// Cross-runtime provider fixtures (`port-git-providers-and-ai-to-bun`,
// task 1.2). Each fixture is a replayable recipe (input files plus operations)
// next to the outputs the Go store actually produced, so the Bun provider
// store can be asserted against the same contract without either runtime
// mutating the other's state.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/provider \
//	  go test ./pkg/provider -run TestWriteProviderFixtures
import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type fixtureProvider struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Username    string   `json:"username"`
	Token       string   `json:"token,omitempty"`
	MissingVars []string `json:"missingVars,omitempty"`
}

type fixtureInvalid struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	File    string `json:"file"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type fixtureOperation struct {
	Op       string            `json:"op"`
	Name     string            `json:"name,omitempty"`
	Path     string            `json:"path,omitempty"`
	Provider *fixtureProvider  `json:"provider,omitempty"`
	Error    bool              `json:"error,omitempty"`
	Message  string            `json:"message,omitempty"`
	List     []fixtureProvider `json:"list,omitempty"`
	Invalid  []fixtureInvalid  `json:"invalid,omitempty"`
	Value    string            `json:"value,omitempty"`
	HasToken bool              `json:"hasToken,omitempty"`
}

type fixtureFile struct {
	Case       string             `json:"case"`
	Note       string             `json:"note"`
	Input      map[string]string  `json:"input"`
	Operations []fixtureOperation `json:"operations"`
}

func TestWriteProviderFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range providerFixtures() {
		root := t.TempDir()
		configDir := filepath.Join(root, "config")
		for name, content := range fixture.Input {
			target := filepath.Join(configDir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				t.Fatalf("mkdir %s: %v", filepath.Dir(target), err)
			}
			if err := os.WriteFile(target, []byte(content), 0600); err != nil {
				t.Fatalf("write %s: %v", target, err)
			}
		}
		store := NewStore(filepath.Join(configDir, "providers"), filepath.Join(configDir, ".env"))
		recorded := fixture
		recorded.Operations = runProviderOperations(t, store, configDir, fixture.Operations)
		writeProviderJSON(t, filepath.Join(dir, fixture.Case, "recipe.json"), fixture)
		writeProviderJSON(t, filepath.Join(dir, fixture.Case, "expected.json"), recorded)
	}
}

func runProviderOperations(t *testing.T, store Store, configDir string, operations []fixtureOperation) []fixtureOperation {
	t.Helper()
	recorded := make([]fixtureOperation, 0, len(operations))
	for _, op := range operations {
		result := op
		switch op.Op {
		case "load":
			recordProviderErr(&result, store.Load())
		case "list":
			result.List = snapshotList(store)
		case "invalid":
			result.Invalid = snapshotInvalid(store)
		case "get":
			p, ok := store.Get(op.Name)
			if !ok {
				result.Error = true
				result.Message = "not found"
				break
			}
			result.List = []fixtureProvider{snapshotProvider(p)}
		case "credentialsFor":
			username, token := store.CredentialsFor(op.Name)
			result.Value = username + "\x1f" + token
			result.HasToken = token != ""
		case "save":
			recordProviderErr(&result, store.Save(Provider{
				Name:     op.Provider.Name,
				Type:     op.Provider.Type,
				Username: op.Provider.Username,
				Token:    op.Provider.Token,
			}))
		case "delete":
			recordProviderErr(&result, store.Delete(op.Name))
		case "readFile":
			data, err := os.ReadFile(filepath.Join(configDir, filepath.FromSlash(op.Path)))
			if err != nil {
				result.Error = true
				result.Message = err.Error()
				break
			}
			result.Value = string(data)
		default:
			t.Fatalf("unknown fixture operation %q", op.Op)
		}
		recorded = append(recorded, result)
	}
	return recorded
}

// snapshotList sorts by name: the Go store lists a map, so the fixture pins the
// content of the set rather than an incidental iteration order. The Bun store
// is asserted against the same sorted projection.
func snapshotList(store Store) []fixtureProvider {
	providers := store.List()
	result := make([]fixtureProvider, 0, len(providers))
	for _, p := range providers {
		result = append(result, snapshotProvider(p))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func snapshotProvider(p Provider) fixtureProvider {
	return fixtureProvider{
		Name:        p.Name,
		Type:        p.Type,
		Username:    p.Username,
		Token:       p.Token,
		MissingVars: p.MissingVars,
	}
}

func snapshotInvalid(store Store) []fixtureInvalid {
	invalid := store.InvalidProviders()
	result := make([]fixtureInvalid, 0, len(invalid))
	for _, p := range invalid {
		result = append(result, fixtureInvalid{
			Name: p.Name, Type: p.Type, File: p.File, Reason: p.Reason, Message: p.Message,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func recordProviderErr(result *fixtureOperation, err error) {
	if err == nil {
		result.Error = false
		result.Message = ""
		return
	}
	result.Error = true
	result.Message = strings.SplitN(err.Error(), "\n", 2)[0]
}

func writeProviderJSON(t *testing.T, path string, value any) {
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

func providerFixtures() []fixtureFile {
	return []fixtureFile{
		{
			Case: "load-credentials",
			Note: "placeholder resolution, missing vars, invalid clear-text files and filename-derived names",
			Input: map[string]string{
				"providers/team.json":  "{\n  \"name\": \"team\",\n  \"type\": \"gitlab\",\n  \"username\": \"${DEVENV_PROVIDER_TEAM_USERNAME}\",\n  \"token\": \"${DEVENV_PROVIDER_TEAM_TOKEN}\"\n}\n",
				"providers/anon.json":  "{\n  \"type\": \"github\",\n  \"username\": \"${DEVENV_PROVIDER_ANON_USERNAME}\",\n  \"token\": \"${DEVENV_PROVIDER_ANON_TOKEN}\"\n}\n",
				"providers/plain.json": "{\n  \"name\": \"plain\",\n  \"type\": \"github\",\n  \"username\": \"someone\",\n  \"token\": \"secret\"\n}\n",
				".env":                 "DEVENV_PROVIDER_TEAM_USERNAME=octo\nDEVENV_PROVIDER_TEAM_TOKEN='tok en'\n",
			},
			Operations: []fixtureOperation{
				{Op: "load"},
				{Op: "list"},
				{Op: "invalid"},
				{Op: "get", Name: "team"},
				{Op: "credentialsFor", Name: "team"},
				{Op: "credentialsFor", Name: "plain"},
				{Op: "credentialsFor", Name: "missing"},
			},
		},
		{
			Case: "save-credentials",
			Note: "credential writes go to the env file with placeholders in the provider file, and an empty token keeps the stored one",
			Input: map[string]string{
				"providers/team.json": "{\n  \"name\": \"team\",\n  \"type\": \"gitlab\",\n  \"username\": \"${DEVENV_PROVIDER_TEAM_USERNAME}\",\n  \"token\": \"${DEVENV_PROVIDER_TEAM_TOKEN}\"\n}\n",
				".env":                "# keep me\nUNRELATED=1\nDEVENV_PROVIDER_TEAM_TOKEN=old\n",
			},
			Operations: []fixtureOperation{
				{Op: "load"},
				{Op: "save", Provider: &fixtureProvider{Name: "team", Type: "gitlab", Username: "octo", Token: "tok en"}},
				{Op: "readFile", Path: "providers/team.json"},
				{Op: "readFile", Path: ".env"},
				{Op: "save", Provider: &fixtureProvider{Name: "team", Type: "gitlab", Username: "octo"}},
				{Op: "credentialsFor", Name: "team"},
				{Op: "delete", Name: "team"},
				{Op: "readFile", Path: ".env"},
			},
		},
		{
			Case: "validation",
			Note: "rejected saves keep the store unchanged and report a bounded diagnostic",
			Input: map[string]string{
				"providers/team.json": "{\n  \"name\": \"team\",\n  \"type\": \"gitlab\",\n  \"username\": \"${DEVENV_PROVIDER_TEAM_USERNAME}\",\n  \"token\": \"${DEVENV_PROVIDER_TEAM_TOKEN}\"\n}\n",
				".env":                "DEVENV_PROVIDER_TEAM_USERNAME=octo\nDEVENV_PROVIDER_TEAM_TOKEN=tok\n",
			},
			Operations: []fixtureOperation{
				{Op: "load"},
				{Op: "save", Provider: &fixtureProvider{Name: "x", Type: "bitbucket"}},
				{Op: "save", Provider: &fixtureProvider{Name: "bad/name", Type: "github"}},
				{Op: "save", Provider: &fixtureProvider{Name: "", Type: "github"}},
				{Op: "save", Provider: &fixtureProvider{Name: "team!", Type: "github", Username: "octo", Token: "tok"}},
				{Op: "delete", Name: "absent"},
				{Op: "list"},
			},
		},
	}
}
