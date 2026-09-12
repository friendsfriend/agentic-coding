package kubernetes

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type CommandRunner interface {
	Run(ctx context.Context, cmd Command) ([]byte, error)
}

type ExecCommandRunner struct{}

func (ExecCommandRunner) Run(ctx context.Context, cmd Command) ([]byte, error) {
	stdout, stderr, err := (ExecCommandRunner{}).RunDetailed(ctx, cmd)
	out := append(stdout, stderr...)
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", cmd.Name, strings.Join(cmd.Args, " "), err, strings.TrimSpace(string(stderr)))
	}
	return out, nil
}

func (ExecCommandRunner) RunDetailed(ctx context.Context, cmd Command) ([]byte, []byte, error) {
	c := exec.CommandContext(ctx, cmd.Name, cmd.Args...)
	if len(cmd.Env) > 0 {
		c.Env = append(c.Environ(), cmd.Env...)
	}
	var stdout, stderr strings.Builder
	c.Stdout, c.Stderr = &stdout, &stderr
	err := c.Run()
	return []byte(stdout.String()), []byte(stderr.String()), err
}

type CommandObservation struct {
	Command Command
	Output  string
	Stderr  string
	Err     error
}

type ClusterService struct {
	Runner  Runner
	Exec    CommandRunner
	Now     func() time.Time
	Observe func(CommandObservation)
}

func NewClusterService(r Runner) ClusterService {
	return ClusterService{Runner: r, Exec: ExecCommandRunner{}, Now: time.Now}
}

func (s ClusterService) run(ctx context.Context, cmd Command) ([]byte, error) {
	if detailed, ok := s.commandRunner().(interface {
		RunDetailed(context.Context, Command) ([]byte, []byte, error)
	}); ok {
		stdout, stderr, err := detailed.RunDetailed(ctx, cmd)
		if s.Observe != nil {
			s.Observe(CommandObservation{Command: cmd, Output: string(stdout), Stderr: string(stderr), Err: err})
		}
		if err != nil {
			return append(stdout, stderr...), fmt.Errorf("%s %s: %w: %s", cmd.Name, strings.Join(cmd.Args, " "), err, strings.TrimSpace(string(stderr)))
		}
		return append(stdout, stderr...), nil
	}
	out, err := s.commandRunner().Run(ctx, cmd)
	if s.Observe != nil {
		s.Observe(CommandObservation{Command: cmd, Output: string(out), Err: err})
	}
	return out, err
}

func (s ClusterService) Create(ctx context.Context) error {
	r := s.Runner.withDefaults()
	if err := r.Preflight(); err != nil {
		return err
	}
	clusters, err := s.run(ctx, r.KindGetClustersCommand())
	if err != nil {
		return err
	}
	if !clusterListContains(clusters, r.ClusterName) {
		if _, err := s.run(ctx, r.KindCreateClusterCommand()); err != nil {
			return err
		}
	}
	return s.ExportKubeconfig(ctx)
}

func (s ClusterService) Delete(ctx context.Context) error {
	r := s.Runner.withDefaults()
	if err := r.Preflight(); err != nil {
		return err
	}
	_, err := s.run(ctx, r.KindDeleteClusterCommand())
	return err
}

func (s ClusterService) Recreate(ctx context.Context) error {
	if err := s.Delete(ctx); err != nil {
		return err
	}
	return s.Create(ctx)
}

func (s ClusterService) ExportKubeconfig(ctx context.Context) error {
	r := s.Runner.withDefaults()
	if err := r.Preflight(); err != nil {
		return err
	}
	_, err := s.run(ctx, r.KindExportKubeconfigCommand())
	return err
}

func (s ClusterService) commandRunner() CommandRunner {
	if s.Exec != nil {
		return s.Exec
	}
	return ExecCommandRunner{}
}

func clusterListContains(out []byte, name string) bool {
	for _, line := range strings.Fields(string(out)) {
		if line == name {
			return true
		}
	}
	return false
}

func (s ClusterService) kindExistsFromRuntimeFallback(ctx context.Context, r Runner, exec CommandRunner, kindErr error) (bool, bool) {
	if !isKindPodmanListBug(kindErr) {
		return false, false
	}
	provider := r.Container.Command
	if provider == "" {
		provider = r.Container.Name
	}
	if provider == "" {
		return false, false
	}
	out, err := exec.Run(ctx, Command{Name: provider, Args: []string{"ps", "-a", "--format", "{{.Names}}"}})
	if err != nil {
		return false, false
	}
	for _, name := range strings.Fields(string(out)) {
		if name == r.ClusterName+"-control-plane" || strings.HasPrefix(name, r.ClusterName+"-") {
			return true, true
		}
	}
	return false, true
}

func isKindPodmanListBug(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "KIND_EXPERIMENTAL_PROVIDER") &&
		strings.Contains(msg, "failed to list clusters") &&
		strings.Contains(msg, "cannot index slice/array with type string")
}

func (s ClusterService) Status(ctx context.Context) ClusterStatus {
	r := s.Runner.withDefaults()
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	status := ClusterStatus{ClusterName: r.ClusterName, ContextName: r.ContextName, Provider: r.Container.Name, State: ClusterStateMissing, Nodes: []ClusterNodeSummary{}, Namespaces: []NamespaceSummary{}, Releases: []DevEnvReleaseSummary{}, CollectedAt: now()}
	if status.Provider == "" {
		status.Provider = r.Container.Command
	}
	exec := s.commandRunner()
	clusters, err := exec.Run(ctx, r.KindGetClustersCommand())
	if err != nil {
		if exists, ok := s.kindExistsFromRuntimeFallback(ctx, r, exec, err); ok {
			status.Exists = exists
		} else {
			status.Warnings = append(status.Warnings, err.Error())
			return status
		}
	} else {
		status.Exists = clusterListContains(clusters, r.ClusterName)
	}
	if !status.Exists {
		return status
	}
	status.State = ClusterStateUnreachable
	if version, err := exec.Run(ctx, r.KubectlCommandFor("version", "-o", "json")); err != nil {
		status.Warnings = append(status.Warnings, err.Error())
	} else {
		status.Reachable = true
		status.State = ClusterStateRunning
		status.KubernetesVersion = parseKubernetesVersion(version)
	}
	if status.Reachable {
		if nodes, err := exec.Run(ctx, r.KubectlCommandFor("get", "nodes", "-o", "json")); err != nil {
			status.Warnings = append(status.Warnings, err.Error())
			status.State = ClusterStateDegraded
		} else {
			status.Nodes = parseNodes(nodes)
		}
		if pods, err := exec.Run(ctx, r.KubectlCommandFor("get", "pods", "--all-namespaces", "-o", "json")); err != nil {
			status.Warnings = append(status.Warnings, err.Error())
			status.State = ClusterStateDegraded
		} else {
			status.Pods, status.Namespaces, status.PodList = parsePods(pods)
		}
		if releases, err := exec.Run(ctx, r.HelmCommandFor("list", "--all-namespaces", "-o", "json")); err != nil {
			status.Warnings = append(status.Warnings, err.Error())
		} else {
			status.Releases = parseReleases(releases)
		}
	}
	if stats, warnings := collectKindNodeStats(ctx, r, exec, now()); stats != nil {
		status.Stats = stats
	} else {
		status.Warnings = append(status.Warnings, warnings...)
		if status.State == ClusterStateRunning && len(warnings) > 0 {
			status.State = ClusterStateDegraded
		}
	}
	return status
}

func parseKubernetesVersion(out []byte) string {
	var v struct {
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	_ = json.Unmarshal(out, &v)
	return v.ServerVersion.GitVersion
}

func parseNodes(out []byte) []ClusterNodeSummary {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				NodeInfo struct {
					KubeletVersion string `json:"kubeletVersion"`
				} `json:"nodeInfo"`
				Conditions []struct{ Type, Status string } `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	_ = json.Unmarshal(out, &list)
	res := make([]ClusterNodeSummary, 0, len(list.Items))
	for _, item := range list.Items {
		ready := false
		for _, c := range item.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready = true
			}
		}
		res = append(res, ClusterNodeSummary{Name: item.Metadata.Name, Ready: ready, KubeletVersion: item.Status.NodeInfo.KubeletVersion})
	}
	return res
}

func parsePods(out []byte) (PodSummary, []NamespaceSummary, []PodListItem) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	_ = json.Unmarshal(out, &list)
	summary := PodSummary{}
	byNS := map[string]int{}
	pods := make([]PodListItem, 0, len(list.Items))
	for _, item := range list.Items {
		summary.Total++
		byNS[item.Metadata.Namespace]++
		status := item.Status.Phase
		switch status {
		case "Running":
			summary.Running++
		case "Pending":
			summary.Pending++
		case "Succeeded":
			summary.Succeeded++
		case "Failed":
			summary.Failed++
		default:
			summary.Unknown++
			if status == "" {
				status = "Unknown"
			}
		}
		pods = append(pods, PodListItem{Name: item.Metadata.Name, Namespace: item.Metadata.Namespace, Status: status})
	}
	ns := make([]NamespaceSummary, 0, len(byNS))
	for name, count := range byNS {
		ns = append(ns, NamespaceSummary{Name: name, Pods: count})
	}
	return summary, ns, pods
}

func parseReleases(out []byte) []DevEnvReleaseSummary {
	var items []struct{ Name, Namespace, Status, Chart, Revision string }
	_ = json.Unmarshal(out, &items)
	res := make([]DevEnvReleaseSummary, 0, len(items))
	for _, item := range items {
		res = append(res, DevEnvReleaseSummary{Name: item.Name, Namespace: item.Namespace, Status: item.Status, Chart: item.Chart, Revision: item.Revision})
	}
	return res
}

func collectKindNodeStats(ctx context.Context, r Runner, exec CommandRunner, at time.Time) (*ClusterResourceStats, []string) {
	provider := r.Container.Command
	if provider == "" {
		provider = r.Container.Name
	}
	if provider == "" {
		return nil, []string{"container runtime unavailable for stats"}
	}
	ps, err := exec.Run(ctx, Command{Name: provider, Args: []string{"ps", "--format", "{{.Names}}"}})
	if err != nil {
		return nil, []string{err.Error()}
	}
	var names []string
	for _, n := range strings.Fields(string(ps)) {
		if strings.HasPrefix(n, r.ClusterName+"-") || strings.HasPrefix(n, "devenv-") {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return nil, []string{"kind node containers not found"}
	}
	stats := ClusterResourceStats{CollectedAt: at}
	for _, name := range names {
		node, ok := tryCollectNodeStats(ctx, exec, provider, name)
		if !ok {
			continue
		}
		stats.CPUPercent += node.CPUPercent
		stats.MemoryUsageBytes += node.MemoryUsageBytes
		stats.MemoryLimitBytes += node.MemoryLimitBytes
		stats.Nodes = append(stats.Nodes, node)
	}
	if len(stats.Nodes) == 0 {
		return nil, []string{"unable to collect stats from any node container"}
	}
	if stats.MemoryLimitBytes > 0 {
		stats.MemoryPercent = float64(stats.MemoryUsageBytes) / float64(stats.MemoryLimitBytes) * 100
	}
	return &stats, nil
}

func tryCollectNodeStats(ctx context.Context, exec CommandRunner, provider, name string) (NodeResourceStats, bool) {
	// Try JSON format (Docker + some Podman versions)
	out, err := exec.Run(ctx, Command{Name: provider, Args: []string{"stats", "--no-stream", "--format", "{{json .}}", name}})
	if err == nil {
		if node := parseRuntimeStatsJSON(name, out); node != nil {
			return *node, true
		}
	}
	// Try tab-separated format (Podman alternative)
	out, err = exec.Run(ctx, Command{Name: provider, Args: []string{"stats", "--no-stream", "--format", "{{.CPU}}\t{{.MemUsage}}\t{{.MemPerc}}", name}})
	if err == nil {
		if node := parseRuntimeStatsTab(name, out); node != nil {
			return *node, true
		}
	}
	// Try inspect as last resort
	return NodeResourceStats{Name: strings.TrimPrefix(name, "devenv-"), ContainerName: name}, false
}

func parseRuntimeStatsJSON(name string, out []byte) *NodeResourceStats {
	s := strings.TrimSpace(string(out))
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(s), &raw); err != nil || len(raw) == 0 {
		return nil
	}

	cpu := parsePercent(pickI(raw, "CPUPerc", "CPU", "cpu", "Cpu", "CpuPerc"))

	// Podman: MemUsage and MemLimit are separate numeric byte-count fields
	memUsageRaw, memUsageIsNum := raw["MemUsage"].(float64)
	memLimitRaw, memLimitIsNum := raw["MemLimit"].(float64)
	if memUsageIsNum && memLimitIsNum {
		memPerc := 0.0
		if mp := pickI(raw, "MemPerc", "mem_perc", "Memperc", "memperc"); mp != "" {
			memPerc = parsePercent(mp)
		}
		return &NodeResourceStats{
			Name:             strings.TrimPrefix(name, "devenv-"),
			ContainerName:    name,
			CPUPercent:       cpu,
			MemoryUsageBytes: uint64(memUsageRaw),
			MemoryLimitBytes: uint64(memLimitRaw),
			MemoryPercent:    memPerc,
		}
	}

	// Docker: MemUsage is a "X / Y" string
	memUsageStr := pickI(raw, "MemUsage", "mem_usage", "Mem", "Memusage", "memusage", "Memory", "memory")
	if memUsageStr == "" {
		return nil
	}
	memPercVal := pickI(raw, "MemPerc", "mem_perc", "Memperc", "memperc", "Mem", "memory")
	mU, mL := parseMemoryPair(memUsageStr)
	return &NodeResourceStats{Name: strings.TrimPrefix(name, "devenv-"), ContainerName: name, CPUPercent: cpu, MemoryUsageBytes: mU, MemoryLimitBytes: mL, MemoryPercent: parsePercent(memPercVal)}
}

func parseRuntimeStatsTab(name string, out []byte) *NodeResourceStats {
	// Use pipe separator to avoid MemUsage spaces splitting into separate fields
	line := strings.Replace(strings.TrimSpace(string(out)), "\t", "|", -1)
	parts := strings.SplitN(line, "|", 3)
	if len(parts) < 3 {
		return nil
	}
	cpu := strings.TrimSpace(parts[0])
	memUsage := strings.TrimSpace(parts[1])
	memPerc := strings.TrimSpace(parts[2])
	mU, mL := parseMemoryPair(memUsage)
	return &NodeResourceStats{Name: strings.TrimPrefix(name, "devenv-"), ContainerName: name, CPUPercent: parsePercent(cpu), MemoryUsageBytes: mU, MemoryLimitBytes: mL, MemoryPercent: parsePercent(memPerc)}
}
func pickI(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return fmt.Sprint(v)
		}
	}
	return ""
}

func parsePercent(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return v
}
func parseMemoryPair(s string) (uint64, uint64) {
	parts := strings.Split(s, "/")
	if len(parts) != 2 {
		return 0, 0
	}
	return parseBytes(parts[0]), parseBytes(parts[1])
}
func parseBytes(s string) uint64 {
	s = strings.TrimSpace(s)
	units := []struct {
		suffix string
		mult   float64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3}, {"B", 1}}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			v, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), 64)
			return uint64(v * u.mult)
		}
	}
	return 0
}
