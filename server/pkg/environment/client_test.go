package environment

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/state"
)

// recorder is a private-operation endpoint that records every request, so a
// test can assert both the operation contract and that one logical Go call
// produces exactly one request (never a duplicated write).
type recorder struct {
	mu       sync.Mutex
	requests []recordedRequest
	handler  func(operation string, params json.RawMessage) (any, int, *Error)
}

type recordedRequest struct {
	path      string
	token     string
	operation string
	params    json.RawMessage
}

func (r *recorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Body != nil {
		decoder := json.NewDecoder(req.Body)
		var payload struct {
			Operation string          `json:"operation"`
			Params    json.RawMessage `json:"params"`
		}
		if err := decoder.Decode(&payload); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		r.mu.Lock()
		r.requests = append(r.requests, recordedRequest{
			path:      req.URL.Path,
			token:     req.Header.Get("Authorization"),
			operation: payload.Operation,
			params:    payload.Params,
		})
		r.mu.Unlock()
		value, status, failure := r.handler(payload.Operation, payload.Params)
		if failure != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": failure})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": value})
		return
	}
	http.Error(w, "no body", http.StatusBadRequest)
}

func (r *recorder) recorded() []recordedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedRequest(nil), r.requests...)
}

func (r *recorder) count() int { return len(r.recorded()) }

func startRecorder(t *testing.T, handler func(string, json.RawMessage) (any, int, *Error)) (*Client, *recorder) {
	t.Helper()
	rec := &recorder{handler: handler}
	server := httptest.NewServer(rec)
	t.Cleanup(server.Close)
	return NewClient(server.URL, "private-token"), rec
}

func TestStoreOperationsUseOneBoundedRequestEach(t *testing.T) {
	client, rec := startRecorder(t, func(operation string, params json.RawMessage) (any, int, *Error) {
		switch operation {
		case "state.getAppState":
			return storePayload{Ident: "alpha", Branch: "main", ActiveWorktree: "feature/x", MainWorktreeBranch: "main"}, http.StatusOK, nil
		case "state.getAppRunTargetInfo":
			return nil, http.StatusOK, nil
		case "state.getScriptArgsHistory":
			return []map[string]string{{"target": "second"}}, http.StatusOK, nil
		case "state.getDependencyLeases":
			return []leasePayload{{TargetID: "lease:db", OwnerRunID: "run-1"}}, http.StatusOK, nil
		case "state.getActionEventsSince", "state.getActionEventsBetween", "state.getActionLogEvents", "state.getActionEvents":
			return []string{`{"type":"action.run.started"}`}, http.StatusOK, nil
		case "manager.getProjectCatalog":
			return app.ProjectCatalog{Revision: "0123456789abcdef", Projects: []app.Project{{Ident: "alpha", Availability: "available"}}}, http.StatusOK, nil
		default:
			return nil, http.StatusOK, nil
		}
	})
	store := client.Store()

	appState, err := store.GetAppState("alpha")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if appState.MainWorktreeBranch != "main" || appState.ActiveWorktree != "feature/x" {
		t.Fatalf("unexpected app state: %+v", appState)
	}

	if _, found, err := store.GetAppRunTargetInfo("alpha"); err != nil || found {
		t.Fatalf("expected an absent run target, got found=%v err=%v", found, err)
	}

	history, err := store.GetScriptArgsHistory("scripts/build.sh", 50)
	if err != nil || len(history) != 1 || history[0]["target"] != "second" {
		t.Fatalf("unexpected history: %v (%v)", history, err)
	}

	leases, err := store.GetDependencyLeases()
	if err != nil || len(leases) != 1 || leases[0].TargetID != "lease:db" {
		t.Fatalf("unexpected leases: %v (%v)", leases, err)
	}

	since := time.Date(2024, 4, 5, 6, 7, 11, 0, time.UTC)
	if _, err := store.GetActionEventsSince(10, since); err != nil {
		t.Fatalf("GetActionEventsSince: %v", err)
	}
	if _, err := store.GetActionEventsBetween(10, since, since.Add(time.Hour)); err != nil {
		t.Fatalf("GetActionEventsBetween: %v", err)
	}
	if _, err := store.GetActionLogEvents("run-1", "step-1", 10); err != nil {
		t.Fatalf("GetActionLogEvents: %v", err)
	}

	// Every call is one request to the private path; Close writes nothing.
	requests := rec.recorded()
	if len(requests) != 7 {
		t.Fatalf("expected 7 requests, got %d", len(requests))
	}
	for _, request := range requests {
		if request.path != OperationPath {
			t.Fatalf("operation %s used path %s, want %s", request.operation, request.path, OperationPath)
		}
		if request.token != "Bearer private-token" {
			t.Fatalf("operation %s sent token %q", request.operation, request.token)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if rec.count() != 7 {
		t.Fatalf("Close must not write, requests now %d", rec.count())
	}

	// The time-range cursors keep the stored textual format.
	between := requests[5]
	var params struct {
		Since  string `json:"since"`
		Before string `json:"before"`
	}
	if err := json.Unmarshal(between.params, &params); err != nil {
		t.Fatal(err)
	}
	if params.Since != "2024-04-05T06:07:11.000Z" || params.Before != "2024-04-05T07:07:11.000Z" {
		t.Fatalf("unexpected cursor format: %+v", params)
	}
}

func TestStoreSendsAtomicUpdatesAsOneOperation(t *testing.T) {
	client, rec := startRecorder(t, func(string, json.RawMessage) (any, int, *Error) {
		return nil, http.StatusOK, nil
	})
	store := client.Store()

	// A multi-field state update must reach the authority as a single logical
	// transaction, never as three single-field writes.
	if err := store.SetAppState(state.AppState{
		Ident:              "alpha",
		Branch:             "feature/x",
		ActiveWorktree:     "feature/x",
		MainWorktreeBranch: "main",
	}); err != nil {
		t.Fatalf("SetAppState: %v", err)
	}
	if err := store.AddScriptArgsHistory("scripts/build.sh", map[string]string{"a": "b"}, 50); err != nil {
		t.Fatalf("AddScriptArgsHistory: %v", err)
	}
	if err := store.AddActionLogEvent("run-1", "step-1", "{}", 50000); err != nil {
		t.Fatalf("AddActionLogEvent: %v", err)
	}
	if err := store.SetDependencyLease(state.DependencyLease{TargetID: "lease:db", OwnerRunID: "run-1"}); err != nil {
		t.Fatalf("SetDependencyLease: %v", err)
	}

	requests := rec.recorded()
	if len(requests) != 4 {
		t.Fatalf("expected one request per logical operation, got %d", len(requests))
	}
	var update struct {
		Ident              string `json:"ident"`
		Branch             string `json:"branch"`
		ActiveWorktree     string `json:"activeWorktree"`
		MainWorktreeBranch string `json:"mainWorktreeBranch"`
	}
	if err := json.Unmarshal(requests[0].params, &update); err != nil {
		t.Fatal(err)
	}
	if update.Branch != "feature/x" || update.MainWorktreeBranch != "main" {
		t.Fatalf("unexpected state payload: %+v", update)
	}
}

func TestManagerPublishesReloadAndMutationSnapshots(t *testing.T) {
	apps := []app.App{{Ident: "alpha", DisplayName: "Alpha", AppType: app.TypeAPP}}
	services := []app.InfraService{{Ident: "docker-infra", DisplayName: "Docker Infra"}}
	client, rec := startRecorder(t, func(operation string, params json.RawMessage) (any, int, *Error) {
		switch operation {
		case "manager.getApps":
			return snapshot{Apps: apps, InfraServices: services}, http.StatusOK, nil
		case "manager.loadConfig":
			return snapshot{Apps: apps, InfraServices: services}, http.StatusOK, nil
		case "manager.loadCatalogConfig":
			return snapshot{Apps: apps, InfraServices: services}, http.StatusOK, nil
		case "manager.addApp":
			return snapshot{Apps: append(apps, app.App{Ident: "beta", DisplayName: "Beta"}), InfraServices: services}, http.StatusOK, nil
		case "manager.removeApp":
			return snapshot{Apps: apps, InfraServices: services}, http.StatusOK, nil
		case "manager.updateAppActiveWorktree", "manager.setMainWorktreeBranch":
			return snapshot{Apps: apps, InfraServices: services}, http.StatusOK, nil
		case "manager.saveConfig":
			return nil, http.StatusOK, nil
		case "manager.getProjectCatalog":
			return app.ProjectCatalog{Revision: "abc", Projects: []app.Project{{Ident: "alpha"}}}, http.StatusOK, nil
		default:
			return nil, http.StatusInternalServerError, &Error{Code: "unexpected", Message: operation}
		}
	})
	manager := client.Manager()

	if err := manager.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got := manager.GetApps(); len(got) != 1 || got[0].Ident != "alpha" {
		t.Fatalf("unexpected apps: %+v", got)
	}
	if got := manager.GetInfraServices(); len(got) != 1 {
		t.Fatalf("unexpected infra services: %+v", got)
	}
	if name := manager.GetDisplayName("docker-infra"); name != "Docker Infra" {
		t.Fatalf("unexpected display name: %s", name)
	}
	if name := manager.GetDisplayName("missing"); name != "missing" {
		t.Fatalf("unexpected fallback display name: %s", name)
	}
	if _, found := manager.GetAppByIdent("alpha"); !found {
		t.Fatal("expected alpha to be found")
	}
	// The cached snapshot serves reads without a second request.
	before := rec.count()
	_ = manager.GetApps()
	if rec.count() != before {
		t.Fatalf("a cached read must not call the authority (requests %d -> %d)", before, rec.count())
	}

	// A mutation publishes the new snapshot from the same response.
	if err := manager.AddApp(app.App{Ident: "beta", DisplayName: "Beta", AppType: app.TypeAPP}); err != nil {
		t.Fatalf("AddApp: %v", err)
	}
	if got := manager.GetApps(); len(got) != 2 {
		t.Fatalf("mutation snapshot was not published: %+v", got)
	}
	if err := manager.UpdateAppActiveWorktree("alpha", "feature/x"); err != nil {
		t.Fatalf("UpdateAppActiveWorktree: %v", err)
	}
	if err := manager.SetMainWorktreeBranch("alpha", "main"); err != nil {
		t.Fatalf("SetMainWorktreeBranch: %v", err)
	}
	if err := manager.RemoveApp("beta", false); err != nil {
		t.Fatalf("RemoveApp: %v", err)
	}
	if err := manager.SaveConfig(); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if err := manager.LoadCatalogConfig(); err != nil {
		t.Fatalf("LoadCatalogConfig: %v", err)
	}
	projects, err := manager.GetProjectCatalog()
	if err != nil || len(projects) != 1 || projects[0].Ident != "alpha" {
		t.Fatalf("unexpected catalog: %v (%v)", projects, err)
	}
	for _, request := range rec.recorded() {
		if strings.HasPrefix(request.path, "/api/v1/environment/api/") {
			t.Fatalf("operation %s used the delegated public prefix", request.operation)
		}
	}
}

func TestFailureAndConfigurationErrorsAreBounded(t *testing.T) {
	client, _ := startRecorder(t, func(operation string, _ json.RawMessage) (any, int, *Error) {
		if operation == "manager.loadConfig" {
			return nil, http.StatusConflict, &Error{
				Code:    "operation-failed",
				Message: `invalid infra service file broken.json: kubernetes service "broken" requires kubernetes config`,
			}
		}
		return nil, http.StatusOK, nil
	})
	manager := client.Manager()
	if err := manager.LoadConfig(); err == nil {
		t.Fatal("expected a reload diagnostic")
	} else if !strings.Contains(err.Error(), "requires kubernetes config") {
		t.Fatalf("unexpected diagnostic: %v", err)
	}

	// A base URL without a token fails fast instead of sending an unauthenticated
	// mutation.
	unauthenticated := NewClient("http://127.0.0.1:1", "")
	err := unauthenticated.Store().SetBranch("alpha", "main")
	if err == nil {
		t.Fatal("expected a token configuration error")
	}
	var failure *Error
	if !asEnvironmentError(err, &failure) || failure.Code != "environment-token-missing" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func asEnvironmentError(err error, target **Error) bool {
	failure, ok := err.(*Error)
	if ok {
		*target = failure
	}
	return ok
}

func TestFromEnvRequiresTheURLToOptIn(t *testing.T) {
	t.Setenv(URLEnvVar, "")
	t.Setenv(TokenEnvVar, "token")
	if _, migrated := FromEnv(); migrated {
		t.Fatal("an unset environment URL must stay in legacy mode")
	}
	t.Setenv(URLEnvVar, "http://127.0.0.1:4051")
	client, migrated := FromEnv()
	if !migrated || client == nil {
		t.Fatal("expected migrated mode with the URL set")
	}
}
