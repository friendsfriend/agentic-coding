package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
	"github.com/friendsfriend/devenv/pkg/gitlab"
)

type ghWorkflowRun struct {
	ID         int       `json:"id"`
	Name       string    `json:"name"`
	Status     string    `json:"status"`
	Conclusion string    `json:"conclusion"`
	HTMLURL    string    `json:"html_url"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	HeadSHA    string    `json:"head_sha"`
	HeadBranch string    `json:"head_branch"`
}

type ghActionJob struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion"`
	StartedAt   time.Time `json:"started_at"`
	CompletedAt time.Time `json:"completed_at"`
	HTMLURL     string    `json:"html_url"`
	RunID       int       `json:"run_id"`
}

type ghCheckRun struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Output struct {
		Summary string `json:"summary"`
	} `json:"output"`
}

// mapRunStatusToGitLab maps a GitHub Actions workflow run's status/conclusion to
// a GitLab-compatible pipeline status string.
func mapRunStatusToGitLab(run ghWorkflowRun) string {
	switch run.Status {
	case "queued", "waiting", "pending":
		return "pending"
	case "in progress":
		return "running"
	case "completed":
		switch run.Conclusion {
		case "success", "neutral", "skipped":
			return "success"
		case "failure", "timed_out":
			return "failed"
		case "cancelled":
			return "canceled"
		default:
			return "running"
		}
	default:
		return "running"
	}
}

// convertActionJob converts a ghActionJob into the GitLab Job shape that the TUI expects.
// workflowName is used as the "stage" field.
func convertActionJob(job ghActionJob, workflowName string) gitlab.Job {
	stage := strings.TrimSpace(workflowName)
	if stage == "" {
		stage = "Default"
	}

	run := ghWorkflowRun{Status: job.Status, Conclusion: job.Conclusion}
	status := mapRunStatusToGitLab(run)

	startedAt := job.StartedAt
	finishedAt := job.CompletedAt

	var duration *float64
	if !job.StartedAt.IsZero() && !job.CompletedAt.IsZero() {
		d := job.CompletedAt.Sub(job.StartedAt).Seconds()
		duration = &d
	}

	return gitlab.Job{
		ID:         job.ID,
		Name:       job.Name,
		Stage:      stage,
		Status:     status,
		WebURL:     job.HTMLURL,
		StartedAt:  &startedAt,
		FinishedAt: &finishedAt,
		Duration:   duration,
		Pipeline: struct {
			ID int `json:"id"`
		}{ID: job.RunID},
	}
}

// GetLatestRunForSHA fetches the most recent workflow run for a given commit SHA.
// Returns nil (no error) when no runs exist for that SHA.
func (c *client) GetLatestRunForSHA(info *RepoInfo, sha string) (*ghWorkflowRun, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	params := url.Values{}
	params.Set("head_sha", sha)
	params.Set("per_page", "1")
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs?%s",
		info.Owner, info.Repo, params.Encode())

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch workflow runs: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		TotalCount   int             `json:"total_count"`
		WorkflowRuns []ghWorkflowRun `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse workflow runs: %w", err)
	}

	if len(result.WorkflowRuns) == 0 {
		return nil, nil
	}
	run := result.WorkflowRuns[0]
	return &run, nil
}

func (c *client) GetActionJob(info *changerequest.RepoInfo, jobID int) (*ghActionJob, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/jobs/%d",
		ghInfo.Owner, ghInfo.Repo, jobID)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch job: %w", err)
	}
	defer resp.Body.Close()

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var job ghActionJob
	if err := json.Unmarshal(body, &job); err != nil {
		return nil, fmt.Errorf("failed to parse job: %w", err)
	}

	return &job, nil
}

// GetRunJobs fetches all jobs for a given workflow run ID.
func (c *client) GetRunJobs(info *RepoInfo, runID int) ([]ghActionJob, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs/%d/jobs?per_page=100",
		info.Owner, info.Repo, runID)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch run jobs: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		TotalCount int           `json:"total_count"`
		Jobs       []ghActionJob `json:"jobs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse run jobs: %w", err)
	}

	return result.Jobs, nil
}

// GetJobLogs implements changerequest.Client.GetJobLogs.
func (c *client) GetJobLogs(info *changerequest.RepoInfo, jobID int) (string, error) {
	return c.GetJobLogsContext(c.requestContext(), info, jobID)
}

func (c *client) GetJobLogsContext(ctx context.Context, info *changerequest.RepoInfo, jobID int) (string, error) {
	if ctx == nil {
		ctx = c.requestContext()
	}
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return "", err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/jobs/%d/logs",
		ghInfo.Owner, ghInfo.Repo, jobID)

	noRedirectClient := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: c.httpClient.Transport,
		Timeout:   c.httpClient.Timeout,
	}

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.token))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "devenv-cli")

	resp, err := noRedirectClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to fetch job logs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusFound || resp.StatusCode == http.StatusMovedPermanently {
		location := resp.Header.Get("Location")
		if location == "" {
			return "", fmt.Errorf("redirect with no Location header")
		}
		redirectReq, err := http.NewRequestWithContext(ctx, "GET", location, nil)
		if err != nil {
			return "", fmt.Errorf("failed to create redirect request: %w", err)
		}
		redirectResp, err := http.DefaultClient.Do(redirectReq)
		if err != nil {
			return "", fmt.Errorf("failed to fetch logs from redirect: %w", err)
		}
		defer redirectResp.Body.Close()
		body, err := io.ReadAll(redirectResp.Body)
		if err != nil {
			return "", fmt.Errorf("failed to read logs: %w", err)
		}
		return string(body), nil
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read logs: %w", err)
	}
	return string(body), nil
}

// GetRunJobsAsGitLabJobs fetches jobs for a workflow run and converts them to the
// GitLab Job shape consumed by the TUI.
func (c *client) GetRunJobsAsGitLabJobs(info *RepoInfo, runID int, workflowName string) ([]gitlab.Job, error) {
	rawJobs, err := c.GetRunJobs(info, runID)
	if err != nil {
		return nil, err
	}

	jobs := make([]gitlab.Job, 0, len(rawJobs))
	for _, j := range rawJobs {
		jobs = append(jobs, convertActionJob(j, workflowName))
	}
	return jobs, nil
}
