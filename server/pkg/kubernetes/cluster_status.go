package kubernetes

import "time"

type ClusterState string

const (
	ClusterStateMissing     ClusterState = "missing"
	ClusterStateRunning     ClusterState = "running"
	ClusterStateDegraded    ClusterState = "degraded"
	ClusterStateUnreachable ClusterState = "unreachable"
)

type ClusterStatus struct {
	ClusterName       string                 `json:"clusterName"`
	ContextName       string                 `json:"contextName"`
	Provider          string                 `json:"provider"`
	Exists            bool                   `json:"exists"`
	Reachable         bool                   `json:"reachable"`
	State             ClusterState           `json:"state"`
	KubernetesVersion string                 `json:"kubernetesVersion,omitempty"`
	Nodes             []ClusterNodeSummary   `json:"nodes"`
	Namespaces        []NamespaceSummary     `json:"namespaces"`
	Pods              PodSummary             `json:"pods"`
	PodList           []PodListItem          `json:"podList"`
	Releases          []DevEnvReleaseSummary `json:"releases"`
	Stats             *ClusterResourceStats  `json:"stats,omitempty"`
	Warnings          []string               `json:"warnings,omitempty"`
	CollectedAt       time.Time              `json:"collectedAt"`
}

type ClusterNodeSummary struct {
	Name           string `json:"name"`
	Ready          bool   `json:"ready"`
	Role           string `json:"role,omitempty"`
	KubeletVersion string `json:"kubeletVersion,omitempty"`
}

type NamespaceSummary struct {
	Name string `json:"name"`
	Pods int    `json:"pods"`
}

type PodSummary struct {
	Total     int `json:"total"`
	Running   int `json:"running"`
	Pending   int `json:"pending"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Unknown   int `json:"unknown"`
}

type PodListItem struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
}

type DevEnvReleaseSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
	Chart     string `json:"chart,omitempty"`
	Revision  string `json:"revision,omitempty"`
}

type ClusterResourceStats struct {
	CPUPercent       float64             `json:"cpuPercent"`
	MemoryUsageBytes uint64              `json:"memoryUsageBytes"`
	MemoryLimitBytes uint64              `json:"memoryLimitBytes"`
	MemoryPercent    float64             `json:"memoryPercent"`
	Nodes            []NodeResourceStats `json:"nodes"`
	CollectedAt      time.Time           `json:"collectedAt"`
}

type NodeResourceStats struct {
	Name             string  `json:"name"`
	ContainerName    string  `json:"containerName"`
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsageBytes uint64  `json:"memoryUsageBytes"`
	MemoryLimitBytes uint64  `json:"memoryLimitBytes"`
	MemoryPercent    float64 `json:"memoryPercent"`
}
