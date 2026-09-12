package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GetPipelines fetches pipelines for a given project
func (c *client) GetPipelines(projectInfo *ProjectInfo, limit int) ([]Pipeline, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/pipelines", c.baseURL, projectPath)

	// Add query parameters
	limit = clampProviderLimit(limit)
	params := url.Values{}
	params.Set("per_page", fmt.Sprintf("%d", limit))
	params.Set("order_by", "id")
	params.Set("sort", "desc") // Get newest first

	if len(params) > 0 {
		apiURL += "?" + params.Encode()
	}

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	switch resp.StatusCode {
	case http.StatusOK:
		// Success, continue processing
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden - token may lack permissions for project %s/%s", projectInfo.Namespace, projectInfo.Project)
	case http.StatusNotFound:
		return nil, fmt.Errorf("project not found: %s/%s - check if the project exists and you have access", projectInfo.Namespace, projectInfo.Project)
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("GitLab API rate limit exceeded - please try again later")
	case http.StatusInternalServerError:
		return nil, fmt.Errorf("GitLab server error - please try again later")
	default:
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse JSON response
	var pipelines []Pipeline
	if err := json.Unmarshal(body, &pipelines); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	return pipelines, nil
}

// GetChangeRequests fetches change requests for the project (used for MR pipeline detection)
// GetPipelineJobs fetches jobs for a specific pipeline
func (c *client) GetPipelineJobs(projectInfo *ProjectInfo, pipelineID int) ([]Job, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/pipelines/%d/jobs", c.baseURL, projectPath, pipelineID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	switch resp.StatusCode {
	case http.StatusOK:
		// Success, continue processing
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden - token may lack permissions for project %s/%s", projectInfo.Namespace, projectInfo.Project)
	case http.StatusNotFound:
		return nil, fmt.Errorf("pipeline or project not found: pipeline %d in %s/%s", pipelineID, projectInfo.Namespace, projectInfo.Project)
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("GitLab API rate limit exceeded - please try again later")
	case http.StatusInternalServerError:
		return nil, fmt.Errorf("GitLab server error - please try again later")
	default:
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse JSON response
	var jobs []Job
	if err := json.Unmarshal(body, &jobs); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	return jobs, nil
}

// GetJobLogs fetches the log/trace for a specific job
func (c *client) GetJobLogs(projectInfo *ProjectInfo, jobID int) (string, error) {
	return c.GetJobLogsContext(c.requestContext(), projectInfo, jobID)
}

func (c *client) GetJobLogsContext(ctx context.Context, projectInfo *ProjectInfo, jobID int) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if projectInfo == nil {
		return "", fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for job trace
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/jobs/%d/trace", c.baseURL, projectPath, jobID)

	// Create request
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "text/plain")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusOK:
		// Read the job logs
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", fmt.Errorf("failed to read job logs: %w", err)
		}
		return string(body), nil
	case http.StatusNotFound:
		return "", fmt.Errorf("job not found or logs not available")
	case http.StatusUnauthorized:
		return "", fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return "", fmt.Errorf("access forbidden - token may lack permissions for project %s/%s", projectInfo.Namespace, projectInfo.Project)
	default:
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

func (c *client) StreamJobLogs(ctx context.Context, projectInfo *ProjectInfo, jobID int) (chan string, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/jobs/%d/trace", c.baseURL, projectPath, jobID)

	lineCh := make(chan string, 64)

	go func() {
		defer close(lineCh)

		var offset int64
		pollInterval := 3 * time.Second

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
			if err != nil {
				log.Printf("[ERROR] StreamJobLogs: failed to create request: %v", err)
				return
			}
			req.Header.Set("PRIVATE-TOKEN", c.token)
			req.Header.Set("User-Agent", "devenv-cli")
			req.Header.Set("Accept", "text/plain")
			if offset > 0 {
				req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
			}

			resp, err := c.httpClient.Do(req)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("[ERROR] StreamJobLogs: request failed: %v", err)
				return
			}

			if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
				resp.Body.Close()
				select {
				case <-ctx.Done():
					return
				case <-time.After(pollInterval):
					continue
				}
			}

			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
				resp.Body.Close()
				log.Printf("[ERROR] StreamJobLogs: unexpected status %d", resp.StatusCode)
				return
			}

			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("[ERROR] StreamJobLogs: failed to read body: %v", err)
				return
			}

			if len(body) > 0 {
				offset += int64(len(body))
				chunk := string(body)
				lines := strings.Split(chunk, "\n")
				for _, line := range lines {
					if line == "" {
						continue
					}
					select {
					case lineCh <- line:
					case <-ctx.Done():
						return
					}
				}
			}

			if interval := resp.Header.Get("X-GitLab-Trace-Update-Interval"); interval != "" {
				if secs, err := strconv.Atoi(interval); err == nil && secs > 0 {
					pollInterval = time.Duration(secs) * time.Second
				}
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(pollInterval):
			}
		}
	}()

	return lineCh, nil
}

func (c *client) GetTestSummary(projectInfo *ProjectInfo, pipelineID int) (*TestSummary, error) {
	// Build API URL for test reports
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/pipelines/%d/test_report",
		c.baseURL,
		url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project)),
		pipelineID)

	// Create request with shorter timeout for test reports
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Be more specific about timeout errors
		if strings.Contains(err.Error(), "timeout") {
			return nil, fmt.Errorf("test report request timed out - API may not be available")
		}
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusOK:
		// Parse the test report response
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to read test report response: %w", err)
		}

		// GitLab test report has this structure
		var testReport struct {
			TotalTime    float64     `json:"total_time"`
			TotalCount   int         `json:"total_count"`
			SuccessCount int         `json:"success_count"`
			FailedCount  int         `json:"failed_count"`
			SkippedCount int         `json:"skipped_count"`
			ErrorCount   int         `json:"error_count"`
			TestSuites   []TestSuite `json:"test_suites"`
		}

		if err := json.Unmarshal(body, &testReport); err != nil {
			return nil, fmt.Errorf("failed to parse test report JSON: %w", err)
		}

		// Group failing tests by class name
		classToFailedTests := make(map[string][]string)
		var failedTests []string // Keep legacy field for backward compatibility
		maxFailingTests := 3

		for _, suite := range testReport.TestSuites {
			for _, testCase := range suite.TestCases {
				if testCase.Status == "failed" || testCase.Status == "error" {
					// Determine the class name without package prefix
					className := testCase.Classname
					if className == "" {
						// If no classname, use suite name or "Unknown"
						className = suite.Name
						if className == "" {
							className = "Unknown"
						}
					}

					// Extract just the class name from full package path (e.g., com.example.TestClass -> TestClass)
					if strings.Contains(className, ".") {
						parts := strings.Split(className, ".")
						className = parts[len(parts)-1] // Take the last part
					}

					// Get the test method name
					methodName := testCase.Name

					// Group by class name
					classToFailedTests[className] = append(classToFailedTests[className], methodName)

					// Also maintain legacy failedTests list (first 3 for backward compatibility)
					if len(failedTests) < maxFailingTests {
						failedTests = append(failedTests, methodName)
					}
				}
			}
		}

		// Convert map to FailedTestGroup slice
		var failedTestGroups []FailedTestGroup
		for className, methods := range classToFailedTests {
			failedTestGroups = append(failedTestGroups, FailedTestGroup{
				ClassName:   className,
				TestMethods: methods,
			})
		}

		// Sort groups by class name for consistent display
		sort.Slice(failedTestGroups, func(i, j int) bool {
			return failedTestGroups[i].ClassName < failedTestGroups[j].ClassName
		})

		return &TestSummary{
			Total:            testReport.TotalCount,
			Success:          testReport.SuccessCount,
			Failed:           testReport.FailedCount,
			Skipped:          testReport.SkippedCount,
			Error:            testReport.ErrorCount,
			TestSuites:       testReport.TestSuites,
			FailedTests:      failedTests,      // Legacy field
			FailedTestGroups: failedTestGroups, // New grouped tests
		}, nil
	case http.StatusNotFound:
		// No test report available - this is normal for pipelines without tests
		return nil, nil
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden - token may lack permissions for project %s/%s", projectInfo.Namespace, projectInfo.Project)
	case http.StatusNotImplemented:
		// Some GitLab instances might not support test reports API
		return nil, nil
	default:
		// For unknown errors, return nil instead of error to avoid blocking UI
		// This makes test reports a nice-to-have feature rather than required
		return nil, nil
	}
}

// RestartJob restarts/retries a specific job
func (c *client) RestartJob(projectInfo *ProjectInfo, jobID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for job retry
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/jobs/%d/retry", c.baseURL, projectPath, jobID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "POST", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusCreated:
		// Job restart was successful
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("job not found or cannot be restarted")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to restart jobs in project %s/%s", projectInfo.Namespace, projectInfo.Project)
	case http.StatusBadRequest:
		return fmt.Errorf("job cannot be restarted (may already be running or in a non-restartable state)")
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// CancelJob cancels/aborts a specific job
func (c *client) CancelJob(projectInfo *ProjectInfo, jobID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for job cancel
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/jobs/%d/cancel", c.baseURL, projectPath, jobID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "POST", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusCreated:
		// Job cancel was successful
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("job not found or cannot be cancelled")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to cancel jobs in project %s/%s", projectInfo.Namespace, projectInfo.Project)
	case http.StatusBadRequest:
		return fmt.Errorf("job cannot be cancelled (may already be finished or in a non-cancellable state)")
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}
