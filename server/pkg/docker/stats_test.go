package docker

import (
	"testing"

	"github.com/docker/docker/api/types/container"
)

func TestCalculateCPUPercent_Normal(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.CPUStats.CPUUsage.TotalUsage = 500
	stats.CPUStats.SystemUsage = 10000
	stats.CPUStats.OnlineCPUs = 4
	stats.PreCPUStats.CPUUsage.TotalUsage = 400
	stats.PreCPUStats.SystemUsage = 9000

	result := calculateCPUPercent(stats)

	// cpuDelta=100, systemDelta=1000 → 100/1000 * 100 = 10%
	if result < 9.9 || result > 10.1 {
		t.Errorf("expected ~10.0%%, got %f", result)
	}
}

func TestCalculateCPUPercent_ZeroedPrecpuStats(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.CPUStats.CPUUsage.TotalUsage = 500
	stats.CPUStats.SystemUsage = 10000
	stats.CPUStats.OnlineCPUs = 4
	stats.PreCPUStats.CPUUsage.TotalUsage = 0
	stats.PreCPUStats.SystemUsage = 0

	result := calculateCPUPercent(stats)

	if result != 0.0 {
		t.Errorf("expected 0.0 for zeroed precpu_stats (first frame), got %f", result)
	}
}

func TestCalculateCPUPercent_CapsAt100(t *testing.T) {
	stats := &container.StatsResponse{}
	// Simulate scenario where cpuDelta > systemDelta (multi-core burst)
	stats.CPUStats.CPUUsage.TotalUsage = 20000
	stats.CPUStats.SystemUsage = 10000
	stats.CPUStats.OnlineCPUs = 4
	stats.PreCPUStats.CPUUsage.TotalUsage = 1000
	stats.PreCPUStats.SystemUsage = 9000

	result := calculateCPUPercent(stats)

	if result != 100.0 {
		t.Errorf("expected 100.0 (capped), got %f", result)
	}
}

func TestCalculateCPUPercent_ZeroSystemDelta(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.CPUStats.CPUUsage.TotalUsage = 500
	stats.CPUStats.SystemUsage = 10000
	stats.CPUStats.OnlineCPUs = 1
	stats.PreCPUStats.CPUUsage.TotalUsage = 400
	stats.PreCPUStats.SystemUsage = 10000 // same as current → delta = 0

	result := calculateCPUPercent(stats)

	if result != 0.0 {
		t.Errorf("expected 0.0 for zero system delta, got %f", result)
	}
}

func TestCalculateMemoryUsage_CgroupV2(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.MemoryStats.Usage = 1000000
	stats.MemoryStats.Limit = 4000000
	stats.MemoryStats.Stats = map[string]uint64{
		"inactive_file": 200000,
	}

	usage, limit, percent := calculateMemoryUsage(stats)

	if usage != 800000 {
		t.Errorf("expected usage 800000, got %d", usage)
	}
	if limit != 4000000 {
		t.Errorf("expected limit 4000000, got %d", limit)
	}
	expectedPercent := 20.0
	if percent < 19.9 || percent > 20.1 {
		t.Errorf("expected ~%.1f%%, got %f", expectedPercent, percent)
	}
}

func TestCalculateMemoryUsage_CgroupV1Fallback(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.MemoryStats.Usage = 1000000
	stats.MemoryStats.Limit = 4000000
	stats.MemoryStats.Stats = map[string]uint64{
		"cache": 300000,
	}

	usage, limit, _ := calculateMemoryUsage(stats)

	if usage != 700000 {
		t.Errorf("expected usage 700000, got %d", usage)
	}
	if limit != 4000000 {
		t.Errorf("expected limit 4000000, got %d", limit)
	}
}

func TestCalculateMemoryUsage_RawFallback(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.MemoryStats.Usage = 1000000
	stats.MemoryStats.Limit = 4000000
	stats.MemoryStats.Stats = map[string]uint64{}

	usage, _, _ := calculateMemoryUsage(stats)

	if usage != 1000000 {
		t.Errorf("expected raw usage 1000000, got %d", usage)
	}
}

func TestCalculateMemoryUsage_NilStats(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.MemoryStats.Usage = 500000
	stats.MemoryStats.Limit = 2000000

	usage, _, _ := calculateMemoryUsage(stats)

	if usage != 500000 {
		t.Errorf("expected raw usage 500000, got %d", usage)
	}
}

func TestCalculateMemoryUsage_ZeroLimit(t *testing.T) {
	stats := &container.StatsResponse{}
	stats.MemoryStats.Usage = 500000
	stats.MemoryStats.Limit = 0
	stats.MemoryStats.Stats = map[string]uint64{}

	_, limit, percent := calculateMemoryUsage(stats)

	if limit != 0 {
		t.Errorf("expected limit 0, got %d", limit)
	}
	if percent != 0.0 {
		t.Errorf("expected 0%% for zero limit, got %f", percent)
	}
}
