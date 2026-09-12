package server

import (
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
)

func TestKubernetesCommandsUseSeparateSemanticSteps(t *testing.T) {
	cases := []struct {
		command k8s.Command
		want    string
	}{
		{k8s.Command{Name: "kind", Args: []string{"get", "clusters"}}, "Check cluster"},
		{k8s.Command{Name: "kind", Args: []string{"create", "cluster", "--name", "devenv"}}, "Create cluster"},
		{k8s.Command{Name: "kind", Args: []string{"delete", "cluster", "--name", "devenv"}}, "Delete cluster"},
		{k8s.Command{Name: "kind", Args: []string{"export", "kubeconfig", "--name", "devenv"}}, "Export kubeconfig"},
	}
	for _, tc := range cases {
		kind := actionrun.KubernetesClusterCommandStepKind(strings.Join(tc.command.Args, " "))
		command := strings.TrimSpace(strings.Join(append([]string{tc.command.Name}, tc.command.Args...), " "))
		if got := actionrun.StepLabel(string(kind), command); got != tc.want {
			t.Fatalf("label = %q, want %q", got, tc.want)
		}
	}
	if kubernetesClusterStepID(0) == kubernetesClusterStepID(1) {
		t.Fatal("each command must get a unique step")
	}
}
