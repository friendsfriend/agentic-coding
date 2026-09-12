package gitlab

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// CreateMRDiffComment creates a new diff comment on a change request
func (c *client) CreateMRDiffComment(projectInfo *ProjectInfo, mrIID int, body string, position *DiffPosition) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for creating MR discussion
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/discussions", c.baseURL, projectPath, mrIID)

	// Prepare request payload
	payload := map[string]interface{}{
		"body": body,
	}

	// Add position if provided (for diff comments)
	if position != nil {
		posMap := map[string]interface{}{
			"base_sha":      position.BaseSHA,
			"head_sha":      position.HeadSHA,
			"start_sha":     position.StartSHA,
			"position_type": position.PositionType,
			"new_path":      position.NewPath,
			"old_path":      position.OldPath,
		}
		if position.NewLine != nil {
			posMap["new_line"] = *position.NewLine
		}
		if position.OldLine != nil {
			posMap["old_line"] = *position.OldLine
		}
		payload["position"] = posMap
	}

	// Marshal payload to JSON
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request payload: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusCreated:
		// Comment successfully created
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to comment on this change request")
	case http.StatusBadRequest:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cannot create comment: %s", string(body))
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// GetMRDiscussions fetches all discussions (comment threads) for a change request
func (c *client) GetMRDiscussions(projectInfo *ProjectInfo, mrIID int) ([]Discussion, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for fetching discussions
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/discussions", c.baseURL, projectPath, mrIID)

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
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Read and parse response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var discussions []Discussion
	if err := json.Unmarshal(body, &discussions); err != nil {
		return nil, fmt.Errorf("failed to unmarshal discussions: %w", err)
	}

	debugLog("Fetched %d discussions for MR %d", len(discussions), mrIID)
	return discussions, nil
}

// ReplyToDiscussion adds a reply note to an existing discussion
func (c *client) ReplyToDiscussion(projectInfo *ProjectInfo, mrIID int, discussionID string, body string) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for adding note to discussion
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/discussions/%s/notes",
		c.baseURL, projectPath, mrIID, discussionID)

	// Prepare request payload
	payload := map[string]interface{}{
		"body": body,
	}

	// Marshal payload to JSON
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request payload: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	debugLog("Reply added to discussion %s for MR %d", discussionID, mrIID)
	return nil
}

// ResolveDiscussion resolves or unresolves a discussion thread
func (c *client) ResolveDiscussion(projectInfo *ProjectInfo, mrIID int, discussionID string, resolved bool) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for resolving discussion
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/discussions/%s",
		c.baseURL, projectPath, mrIID, discussionID)

	// Prepare request payload
	payload := map[string]interface{}{
		"resolved": resolved,
	}

	// Marshal payload to JSON
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request payload: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "PUT", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	action := "resolved"
	if !resolved {
		action = "unresolved"
	}
	debugLog("Discussion %s %s for MR %d", discussionID, action, mrIID)
	return nil
}

// GetMRVersions fetches the diff versions for a change request (needed for getting SHAs)
// Falls back to MR details if versions endpoint is not available
func (c *client) GetMRVersions(projectInfo *ProjectInfo, mrIID int) ([]map[string]interface{}, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Try the versions endpoint first
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/versions", c.baseURL, projectPath, mrIID)

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

		var versions []map[string]interface{}
		if err := json.Unmarshal(body, &versions); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}

		return versions, nil
	case http.StatusNotFound:
		// Versions endpoint not available - fall back to MR details
		return c.getMRVersionsFromDetails(projectInfo, mrIID)
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden - you may not have permission to view this change request")
	default:
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// getMRVersionsFromDetails fallback: gets SHAs from MR details endpoint
func (c *client) getMRVersionsFromDetails(projectInfo *ProjectInfo, mrIID int) ([]map[string]interface{}, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d", c.baseURL, projectPath, mrIID)

	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch MR details (status %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var mr map[string]interface{}
	if err := json.Unmarshal(body, &mr); err != nil {
		return nil, fmt.Errorf("failed to parse MR details: %w", err)
	}

	// Extract SHAs from MR details
	diffRefs, ok := mr["diff_refs"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("diff_refs not found in MR details")
	}

	baseSHA, _ := diffRefs["base_sha"].(string)
	headSHA, _ := diffRefs["head_sha"].(string)
	startSHA, _ := diffRefs["start_sha"].(string)

	// Create a fake "version" object that matches the structure expected by the frontend
	version := map[string]interface{}{
		"base_commit_sha":  baseSHA,
		"head_commit_sha":  headSHA,
		"start_commit_sha": startSHA,
	}

	return []map[string]interface{}{version}, nil
}
