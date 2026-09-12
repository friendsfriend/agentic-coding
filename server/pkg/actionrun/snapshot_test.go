package actionrun

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

func TestDefinitionSnapshotRemovesSecretsEphemeralValuesAndExecutableConfig(t *testing.T) {
	definition := actiondef.Action{ActionID: "action", Resource: actiondef.ResourceRef{Kind: "app", ID: "api"}, InputDefinitions: []actiondef.InputDefinition{{PortDefinition: actiondef.PortDefinition{Key: "token", Type: "secret", Visibility: actiondef.VisibilitySecret}, Default: "plaintext"}}, RootStep: actiondef.Step{StepID: "root", StepType: actiondef.StepKindCommand, Configuration: map[string]any{"args": []string{"--token", "plaintext"}}, OutputPorts: []actiondef.PortDefinition{{Key: "token", Visibility: actiondef.VisibilitySecret}, {Key: "image.ref", Visibility: actiondef.VisibilityPublic}}}}
	snapshot := DefinitionSnapshot(definition)
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "plaintext") || strings.Contains(string(encoded), "--token") {
		t.Fatalf("snapshot leaked: %s", encoded)
	}
	if len(snapshot.RootStep.OutputPorts) != 1 || snapshot.RootStep.OutputPorts[0].Key != "image.ref" {
		t.Fatalf("ports=%#v", snapshot.RootStep.OutputPorts)
	}
}
