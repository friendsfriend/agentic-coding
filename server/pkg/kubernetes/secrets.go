package kubernetes

import (
	"fmt"
	"sort"
	"strings"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type SecretApplyPlan struct {
	Name      string
	Namespace string
	Keys      []string
	Values    map[string]string
	Command   Command
}

func BuildSecretPlans(r Runner, namespace string, secrets []resources.KubernetesSecretConfig, env map[string]string) ([]SecretApplyPlan, error) {
	plans := make([]SecretApplyPlan, 0, len(secrets))
	for _, secret := range secrets {
		values := map[string]string{}
		keys := append([]string{}, secret.Keys...)
		sort.Strings(keys)
		for _, key := range keys {
			value, ok := env[key]
			if !ok {
				return nil, fmt.Errorf("missing env key %q for Kubernetes Secret %q", key, secret.Name)
			}
			values[key] = value
		}
		args := []string{"create", "secret", "generic", secret.Name, "--namespace", namespace, "--dry-run=client", "-o", "yaml"}
		for _, key := range keys {
			args = append(args, "--from-literal", key+"="+values[key])
		}
		plans = append(plans, SecretApplyPlan{Name: secret.Name, Namespace: namespace, Keys: keys, Values: values, Command: r.KubectlCommandFor(args...)})
	}
	return plans, nil
}

func RedactSecretCommand(plan SecretApplyPlan) Command {
	cmd := Command{Name: plan.Command.Name, Args: append([]string{}, plan.Command.Args...), Env: append([]string{}, plan.Command.Env...)}
	for i, arg := range cmd.Args {
		if strings.Contains(arg, "=") {
			for _, key := range plan.Keys {
				if strings.HasPrefix(arg, key+"=") {
					cmd.Args[i] = key + "=<redacted>"
				}
			}
		}
	}
	return cmd
}
