package build

import (
	"os"
	"reflect"
	"strings"
	"testing"

	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestKubernetesLifecycleHelpers(t *testing.T) {
	wait := resources.KubernetesWaitConfig{Timeout: "90s"}
	if got := kubernetesWaitArgs(wait); !reflect.DeepEqual(got, []string{"--wait", "--timeout", "90s"}) {
		t.Fatalf("wait args = %#v", got)
	}
	plans, err := k8s.BuildSecretPlans(k8s.Runner{}, "apps", []resources.KubernetesSecretConfig{{Name: "env", Keys: []string{"TOKEN"}}}, map[string]string{"TOKEN": "secret"})
	if err != nil {
		t.Fatalf("BuildSecretPlans error = %v", err)
	}
	valueArgs, cleanup, err := secretValueFiles(plans[0])
	if err != nil {
		t.Fatalf("secretValueFiles error = %v", err)
	}
	defer cleanup()

	got := secretCreateArgs(plans[0], valueArgs)
	prefix := []string{"--context", "kind-devenv", "create", "secret", "generic", "env", "--namespace", "apps"}
	if len(got) != len(prefix)+1 || !reflect.DeepEqual(got[:len(prefix)], prefix) {
		t.Fatalf("secret args = %#v", got)
	}
	if !strings.HasPrefix(got[len(prefix)], "--from-file=TOKEN=") {
		t.Fatalf("expected --from-file value arg, got %#v", got)
	}
	if joined := strings.Join(got, " "); strings.Contains(joined, "TOKEN=secret") {
		t.Fatalf("secret leaked into argv: %q", joined)
	}

	valuePath := strings.TrimPrefix(got[len(prefix)], "--from-file=TOKEN=")
	content, err := os.ReadFile(valuePath)
	if err != nil {
		t.Fatalf("read secret value file: %v", err)
	}
	if string(content) != "secret" {
		t.Fatalf("secret value file = %q", string(content))
	}

	redacted := redactSecretValueArgs(got)
	if joined := strings.Join(redacted, " "); strings.Contains(joined, valuePath) || !strings.Contains(joined, "--from-file=TOKEN=<redacted>") {
		t.Fatalf("redacted args = %q", joined)
	}
}
