package kubernetes

import (
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestBuildSecretPlansValidationAndRedaction(t *testing.T) {
	secrets := []resources.KubernetesSecretConfig{{Name: "env", Keys: []string{"DB_USER", "DB_PASS"}}}
	_, err := BuildSecretPlans(Runner{}, "apps", secrets, map[string]string{"DB_USER": "u"})
	if err == nil || !strings.Contains(err.Error(), `missing env key "DB_PASS"`) {
		t.Fatalf("missing key err = %v", err)
	}
	plans, err := BuildSecretPlans(Runner{}, "apps", secrets, map[string]string{"DB_USER": "u", "DB_PASS": "secret"})
	if err != nil {
		t.Fatalf("BuildSecretPlans error = %v", err)
	}
	if len(plans) != 1 || plans[0].Values["DB_PASS"] != "secret" {
		t.Fatalf("plans = %#v", plans)
	}
	redacted := RedactSecretCommand(plans[0])
	joined := strings.Join(redacted.Args, " ")
	if strings.Contains(joined, "DB_PASS=secret") || !strings.Contains(joined, "DB_PASS=<redacted>") {
		t.Fatalf("redacted args = %q", joined)
	}
	if !strings.Contains(strings.Join(plans[0].Command.Args, " "), "DB_PASS=secret") {
		t.Fatalf("command missing literal: %#v", plans[0].Command.Args)
	}
}
