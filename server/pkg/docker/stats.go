package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types/container"
)

// ContainerStatsEntry represents a single stats snapshot for a container.
type ContainerStatsEntry struct {
	CPUPercent    float64   `json:"cpuPercent"`
	MemoryUsage   uint64    `json:"memoryUsage"`
	MemoryLimit   uint64    `json:"memoryLimit"`
	MemoryPercent float64   `json:"memoryPercent"`
	Timestamp     time.Time `json:"timestamp"`
}

// calculateCPUPercent computes CPU usage percentage (0-100) from a Docker stats JSON response.
// It skips the first frame (where precpu_stats is zeroed) by returning 0.
func calculateCPUPercent(v *container.StatsResponse) float64 {
	previousCPU := v.PreCPUStats.CPUUsage.TotalUsage
	previousSystem := v.PreCPUStats.SystemUsage

	// First frame has zeroed precpu_stats — skip it
	if previousCPU == 0 && previousSystem == 0 {
		return 0.0
	}

	cpuDelta := float64(v.CPUStats.CPUUsage.TotalUsage - previousCPU)
	systemDelta := float64(v.CPUStats.SystemUsage - previousSystem)

	if systemDelta <= 0.0 || cpuDelta < 0.0 {
		return 0.0
	}

	numCPUs := float64(v.CPUStats.OnlineCPUs)
	if numCPUs == 0.0 {
		numCPUs = float64(len(v.CPUStats.CPUUsage.PercpuUsage))
	}
	if numCPUs == 0.0 {
		numCPUs = 1.0
	}

	cpuPercent := (cpuDelta / systemDelta) * 100.0
	if cpuPercent > 100.0 {
		cpuPercent = 100.0
	}

	return cpuPercent
}

// calculateMemoryUsage computes real memory usage, limit, and percentage.
// It handles cgroup v2 (inactive_file) with v1 fallback (cache), and raw usage as final fallback.
func calculateMemoryUsage(v *container.StatsResponse) (usage uint64, limit uint64, percent float64) {
	limit = v.MemoryStats.Limit
	raw := v.MemoryStats.Usage

	// Try cgroup v2: subtract inactive_file
	if inactiveFile, ok := v.MemoryStats.Stats["inactive_file"]; ok && inactiveFile > 0 {
		if raw > inactiveFile {
			usage = raw - inactiveFile
		} else {
			usage = raw
		}
	} else if cache, ok := v.MemoryStats.Stats["cache"]; ok && cache > 0 {
		// Fallback: cgroup v1
		if raw > cache {
			usage = raw - cache
		} else {
			usage = raw
		}
	} else {
		// Final fallback: raw usage
		usage = raw
	}

	if limit > 0 {
		percent = float64(usage) / float64(limit) * 100.0
	}

	return usage, limit, percent
}

// It returns a channel that receives ContainerStatsEntry values.
// The first Docker stats frame (with zeroed precpu_stats) is skipped.
// Cancel ctx to stop the stream; the channel will be closed.
func (dc *dockerClient) StreamContainerStats(ctx context.Context, containerID string) (<-chan ContainerStatsEntry, error) {
	resp, err := dc.cli.ContainerStats(ctx, containerID, true)
	if err != nil {
		return nil, fmt.Errorf("failed to open stats stream for container %s: %w", containerID, err)
	}

	entryCh := make(chan ContainerStatsEntry, 16)

	go func() {
		defer close(entryCh)
		defer resp.Body.Close()

		decoder := json.NewDecoder(resp.Body)
		isFirstFrame := true

		for {
			var statsJSON container.StatsResponse
			if err := decoder.Decode(&statsJSON); err != nil {
				if err == io.EOF || ctx.Err() != nil {
					return
				}
				return
			}

			cpuPercent := calculateCPUPercent(&statsJSON)

			// Skip the first frame (zeroed precpu_stats gives garbage CPU%)
			if isFirstFrame {
				isFirstFrame = false
				continue
			}

			memUsage, memLimit, memPercent := calculateMemoryUsage(&statsJSON)

			entry := ContainerStatsEntry{
				CPUPercent:    cpuPercent,
				MemoryUsage:   memUsage,
				MemoryLimit:   memLimit,
				MemoryPercent: memPercent,
				Timestamp:     time.Now(),
			}

			select {
			case entryCh <- entry:
			case <-ctx.Done():
				return
			}
		}
	}()

	return entryCh, nil
}
