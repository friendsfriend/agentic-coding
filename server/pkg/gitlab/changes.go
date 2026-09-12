package gitlab

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// GetChangeRequestChanges fetches the list of changed files in a change request
func (c *client) GetChangeRequestChanges(projectInfo *ProjectInfo, mrIID int) ([]ChangeRequestChange, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for MR changes
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/changes", c.baseURL, projectPath, mrIID)

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

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusOK:
		// Parse response
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to read response body: %w", err)
		}

		// The API returns a single MR object with changes array and diff_refs
		var mrWithChanges struct {
			Changes  []ChangeRequestChange `json:"changes"`
			DiffRefs struct {
				BaseSHA  string `json:"base_sha"`
				HeadSHA  string `json:"head_sha"`
				StartSHA string `json:"start_sha"`
			} `json:"diff_refs"`
		}

		if err := json.Unmarshal(body, &mrWithChanges); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}

		// Calculate lines added/deleted and parse diff lines with line codes for each change
		for i := range mrWithChanges.Changes {
			mrWithChanges.Changes[i].calculateLineStats()
			mrWithChanges.Changes[i].parseDiffLines(mrWithChanges.DiffRefs.BaseSHA)
			debugLog("Parsed %d diff lines for %s (base_sha: %s)",
				len(mrWithChanges.Changes[i].DiffLines),
				mrWithChanges.Changes[i].NewPath,
				mrWithChanges.DiffRefs.BaseSHA)
		}

		return mrWithChanges.Changes, nil
	case http.StatusNotFound:
		return nil, fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden - you may not have permission to view this change request")
	default:
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}
