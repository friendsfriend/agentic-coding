package gitlab

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// CloseChangeRequest closes a change request
func (c *client) CloseChangeRequest(projectInfo *ProjectInfo, mrIID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL with state_event parameter
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d", c.baseURL, projectPath, mrIID)

	// Create request body with state_event=close
	reqBody := strings.NewReader("state_event=close")

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "PUT", apiURL, reqBody)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Handle different response codes
	switch resp.StatusCode {
	case http.StatusOK:
		// MR successfully closed
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to close this change request")
	case http.StatusBadRequest:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cannot close change request: %s", string(body))
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// RebaseChangeRequest triggers a rebase operation on a change request
func (c *client) RebaseChangeRequest(projectInfo *ProjectInfo, mrIID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for rebasing MR
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/rebase", c.baseURL, projectPath, mrIID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "PUT", apiURL, nil)
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
	case http.StatusOK, http.StatusAccepted:
		// Rebase successfully triggered (202 Accepted means it's queued)
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to rebase this change request")
	case http.StatusBadRequest:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cannot rebase change request: %s", string(body))
	case http.StatusConflict:
		return fmt.Errorf("rebase already in progress")
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// ApproveChangeRequest approves a change request
func (c *client) ApproveChangeRequest(projectInfo *ProjectInfo, mrIID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for approving MR
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/approve", c.baseURL, projectPath, mrIID)

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
	case http.StatusOK, http.StatusCreated:
		// Approval successfully added
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		return fmt.Errorf("access forbidden - you may not have permission to approve this change request")
	case http.StatusConflict:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cannot approve change request: %s", string(body))
	case http.StatusBadRequest:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cannot approve change request: %s", string(body))
	default:
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// UnapproveChangeRequest removes an approval from a change request
func (c *client) UnapproveChangeRequest(projectInfo *ProjectInfo, mrIID int) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for unapproving MR
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/unapprove", c.baseURL, projectPath, mrIID)

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
	case http.StatusOK, http.StatusCreated:
		// Approval successfully removed
		debugLog("UnapproveChangeRequest: Success (status %d)", resp.StatusCode)
		return nil
	case http.StatusNotFound:
		debugLog("UnapproveChangeRequest: NotFound (status 404)")
		return fmt.Errorf("change request not found")
	case http.StatusUnauthorized:
		debugLog("UnapproveChangeRequest: Unauthorized (status 401)")
		return fmt.Errorf("GitLab authentication failed - check your token")
	case http.StatusForbidden:
		debugLog("UnapproveChangeRequest: Forbidden (status 403)")
		return fmt.Errorf("access forbidden - you may not have permission to unapprove this change request")
	case http.StatusConflict:
		body, _ := io.ReadAll(resp.Body)
		debugLog("UnapproveChangeRequest: Conflict (status 409): %s", string(body))
		return fmt.Errorf("cannot unapprove change request: %s", string(body))
	case http.StatusBadRequest:
		body, _ := io.ReadAll(resp.Body)
		debugLog("UnapproveChangeRequest: BadRequest (status 400): %s", string(body))
		return fmt.Errorf("cannot unapprove change request: %s", string(body))
	default:
		body, _ := io.ReadAll(resp.Body)
		debugLog("UnapproveChangeRequest: Unknown status %d: %s", resp.StatusCode, string(body))
		return fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}
}

// ToggleMRApproval toggles the approval status of a change request
// If the user has already approved, it removes the approval; otherwise it adds it
func (c *client) ToggleMRApproval(projectInfo *ProjectInfo, mrIID int, currentUsername string) error {
	if projectInfo == nil {
		return fmt.Errorf("project info is nil")
	}

	// Get current MR details to check approval status
	mr, err := c.GetChangeRequest(projectInfo, mrIID)
	if err != nil {
		return fmt.Errorf("failed to get change request details: %w", err)
	}

	// Debug: Log approval details
	debugLog("ToggleMRApproval: currentUsername=%s", currentUsername)
	if mr.Approvals != nil {
		debugLog("MR has %d approvals", len(mr.Approvals.ApprovedBy))
		for i, approval := range mr.Approvals.ApprovedBy {
			debugLog("Approval[%d]: username=%s, name=%s", i, approval.User.Username, approval.User.Name)
		}
	} else {
		debugLog("MR Approvals is nil")
	}

	// Check if current user has already approved
	// Compare against both username (login ID like "F19918") and name (display name like "Kellner, Fabian")
	alreadyApproved := false
	if mr.Approvals != nil {
		for _, approval := range mr.Approvals.ApprovedBy {
			if approval.User.Username == currentUsername || approval.User.Name == currentUsername {
				debugLog("Match found: comparing '%s' with username='%s' or name='%s'",
					currentUsername, approval.User.Username, approval.User.Name)
				alreadyApproved = true
				break
			}
		}
	}

	debugLog("alreadyApproved=%v", alreadyApproved)

	// Toggle based on current state
	if alreadyApproved {
		debugLog("Calling UnapproveChangeRequest")
		return c.UnapproveChangeRequest(projectInfo, mrIID)
	}
	debugLog("Calling ApproveChangeRequest")
	return c.ApproveChangeRequest(projectInfo, mrIID)
}
