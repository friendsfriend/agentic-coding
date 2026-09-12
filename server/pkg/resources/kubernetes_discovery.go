package resources

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (m *manager) discoverKubernetesRunTargets(appIdent, localDir string) ([]ActionTarget, error) {
	var targets []ActionTarget
	seen := map[string]bool{}
	add := func(target ActionTarget) {
		if seen[target.ID] {
			return
		}
		seen[target.ID] = true
		targets = append(targets, target)
	}

	charts, err := discoverHelmCharts(localDir)
	if err != nil {
		return nil, err
	}
	for _, chart := range charts {
		profile := kubernetesProfileForChart(chart)
		if filepath.Clean(chart) == filepath.Clean(localDir) {
			profile = "local"
		}
		cfg := KubernetesRunTargetConfig{Profile: profile, Chart: KubernetesHelmChartConfig{Path: chart}, Release: defaultKubernetesRelease(appIdent, profile), Namespace: "default"}
		add(kubernetesActionTarget(appIdent, cfg, chart))
	}

	configAppDir := filepath.Join(m.configDir, "apps", "k8s", appIdent)
	cfgPath := filepath.Join(configAppDir, KubernetesConfigFileName)
	hasExplicitConfig := false
	if _, err := os.Stat(cfgPath); err == nil {
		hasExplicitConfig = true
		cfg, err := LoadKubernetesConfig(cfgPath, localDir, m.configDir)
		if err != nil {
			return nil, err
		}
		for i, target := range cfg.Targets {
			if target.Profile == "" {
				target.Profile = fmt.Sprintf("local-%d", i+1)
			}
			if target.Release == "" {
				target.Release = defaultKubernetesRelease(appIdent, target.Profile)
			}
			if target.Namespace == "" {
				target.Namespace = "default"
			}
			add(kubernetesActionTarget(appIdent, target, cfgPath))
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}

	if !hasExplicitConfig {
		if cfgChart, ok, err := discoverConfigDirChart(configAppDir); err != nil {
			return nil, err
		} else if ok {
			profile := kubernetesProfileForChart(cfgChart)
			cfg := KubernetesRunTargetConfig{Profile: profile, Chart: KubernetesHelmChartConfig{Path: cfgChart}, Release: defaultKubernetesRelease(appIdent, profile), Namespace: "default"}
			add(kubernetesActionTarget(appIdent, cfg, cfgChart))
		}
	}

	sort.SliceStable(targets, func(i, j int) bool { return targets[i].ID < targets[j].ID })
	return targets, nil
}

func discoverHelmCharts(root string) ([]string, error) {
	if root == "" {
		return nil, nil
	}
	var candidates []string
	for _, rel := range []string{".", "chart", "helm", filepath.Join("deploy", "helm")} {
		candidates = append(candidates, filepath.Join(root, rel))
	}
	chartsDir := filepath.Join(root, "charts")
	entries, err := os.ReadDir(chartsDir)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				candidates = append(candidates, filepath.Join(chartsDir, entry.Name()))
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return existingChartDirs(candidates)
}

func discoverConfigDirChart(root string) (string, bool, error) {
	charts, err := existingChartDirs([]string{root, filepath.Join(root, "chart"), filepath.Join(root, "helm")})
	if err != nil || len(charts) == 0 {
		return "", false, err
	}
	return charts[0], true, nil
}

func existingChartDirs(candidates []string) ([]string, error) {
	var charts []string
	seen := map[string]bool{}
	for _, dir := range candidates {
		chartFile := filepath.Join(dir, "Chart.yaml")
		if _, err := os.Stat(chartFile); err == nil {
			clean := filepath.Clean(dir)
			if !seen[clean] {
				seen[clean] = true
				charts = append(charts, clean)
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	sort.Strings(charts)
	return charts, nil
}

func kubernetesActionTarget(appIdent string, cfg KubernetesRunTargetConfig, sourcePath string) ActionTarget {
	profile := cfg.Profile
	if profile == "" {
		profile = "local"
	}
	values := append([]string{}, cfg.Chart.Values...)
	values = append(values, cfg.Values...)
	secrets := make([]KubernetesSecretSummary, 0, len(cfg.Secrets))
	for _, secret := range cfg.Secrets {
		secrets = append(secrets, KubernetesSecretSummary{Name: secret.Name, Keys: append([]string{}, secret.Keys...)})
	}
	label := cfg.Name
	if label == "" {
		label = fmt.Sprintf("Kubernetes %s", profile)
	}
	provider := cfg.Provider
	if provider == "" {
		provider = ContainerProviderDocker
	}
	clusterName := cfg.Cluster
	if clusterName == "" {
		clusterName = "devenv"
	}
	contextName := cfg.Context
	if contextName == "" {
		contextName = "kind-" + clusterName
	}
	return ActionTarget{
		ID:         actionTargetID(appIdent, AppActionRun, ActionRuntimeKubernetes, profile),
		Provider:   provider,
		Action:     AppActionRun,
		Runtime:    ActionRuntimeKubernetes,
		Label:      label,
		Profile:    profile,
		SourcePath: sourcePath,
		Requires:   cfg.Requires,
		Exports:    cfg.Exports,
		Bindings:   cfg.Bindings,
		Kubernetes: &KubernetesTargetMetadata{Provider: provider, ClusterName: clusterName, ContextName: contextName, ChartPath: cfg.Chart.Path, Release: cfg.Release, Namespace: cfg.Namespace, ValuesFiles: values, Image: cfg.Image, Secrets: secrets, Ports: cfg.Ports, Wait: cfg.Wait, Exports: cfg.Exports, Bindings: cfg.Bindings, SourcePath: sourcePath},
	}
}

func kubernetesProfileForChart(chartPath string) string {
	base := filepath.Base(chartPath)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return "local"
	}
	profile := strings.ToLower(base)
	profile = strings.TrimSuffix(profile, "-chart")
	if profile == "chart" || profile == "helm" {
		return "local"
	}
	return profile
}

func defaultKubernetesRelease(appIdent, profile string) string {
	if profile == "" || profile == "local" {
		return appIdent
	}
	return appIdent + "-" + profile
}
