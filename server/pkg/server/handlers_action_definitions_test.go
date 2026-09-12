package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/actionregistry"
	"github.com/friendsfriend/devenv/pkg/resources"
)

type definitionProvider struct{ actions []actiondef.Action }

func (definitionProvider) Name() string { return "test" }
func (p definitionProvider) Compile(context.Context) ([]actiondef.Action, error) {
	return p.actions, nil
}

type definitionKinds map[actiondef.StepKind]bool

func (k definitionKinds) Has(kind actiondef.StepKind) bool { return k[kind] }

func definitionTestServer(t *testing.T) *Server {
	t.Helper()
	registry := actionregistry.New()
	action := actionregistry.CompileTarget("api", resources.ActionTarget{ID: "target", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Label: "Dev", Profile: "dev", Command: "sh"})
	_, err := registry.Rebuild(context.Background(), []actionregistry.Provider{definitionProvider{[]actiondef.Action{action}}}, definitionKinds{actiondef.StepKindProcess: true})
	if err != nil {
		t.Fatal(err)
	}
	return &Server{actionDefinitions: registry}
}

func TestStartActionRunRejectsUnknownInputBeforeExecution(t *testing.T) {
	s := definitionTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/action-runs", strings.NewReader(`{"actionId":"app/api/action/run/shell/dev","inputs":{"unexpected":"value"}}`))
	res := httptest.NewRecorder()
	s.handleStartActionRun(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "unknown input") {
		t.Fatalf("start: %d %s", res.Code, res.Body.String())
	}
}

func TestListAndInspectActionDefinitions(t *testing.T) {
	s := definitionTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/apps/api/actions", nil)
	req.SetPathValue("ident", "api")
	res := httptest.NewRecorder()
	s.handleListActionDefinitions(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "app/api/action/run/shell/dev") {
		t.Fatalf("list: %d %s", res.Code, res.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/action-definition?id=app%2Fapi%2Faction%2Frun%2Fshell%2Fdev", nil)
	res = httptest.NewRecorder()
	s.handleGetActionDefinition(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"label":"Dev"`) {
		t.Fatalf("get: %d %s", res.Code, res.Body.String())
	}
}
