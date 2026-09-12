package kubernetes

import (
	"errors"
	"reflect"
	"testing"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestRuntimeStatusAndPortForwardCommands(t *testing.T) {
	r := Runner{KubectlCommand: "kubectl", HelmCommand: "helm", ContextName: "kind-devenv"}
	if got := MapHelmStatus(`{"info":{"status":"deployed"}}`, nil); got != app.InfraStatusRunning {
		t.Fatalf("status = %s", got)
	}
	if got := MapHelmStatus(`failed`, nil); got != app.InfraStatusFailed {
		t.Fatalf("status = %s", got)
	}
	if got := MapHelmStatus(``, errors.New("missing")); got != app.InfraStatusStopped {
		t.Fatalf("status = %s", got)
	}
	logs := LogsCommand(r, "api", "apps", nil)
	wantLogs := []string{"--context", "kind-devenv", "logs", "--namespace", "apps", "-l", "app.kubernetes.io/instance=api", "--all-containers", "--tail", "200"}
	if !reflect.DeepEqual(logs.Args, wantLogs) {
		t.Fatalf("logs args = %#v", logs.Args)
	}
	pf := PortForwardCommand(r, "apps", resources.KubernetesPortForwardConfig{Resource: "svc/api", LocalPort: 8080, RemotePort: 80})
	wantPF := []string{"--context", "kind-devenv", "port-forward", "--namespace", "apps", "svc/api", "8080:80"}
	if !reflect.DeepEqual(pf.Args, wantPF) {
		t.Fatalf("port-forward args = %#v", pf.Args)
	}
}
