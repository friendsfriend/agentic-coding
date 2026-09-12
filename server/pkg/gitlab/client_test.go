package gitlab

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

func TestExtractProjectInfo(t *testing.T) {
	tests := []struct {
		name        string
		gitURL      string
		expected    *ProjectInfo
		expectError bool
	}{
		{
			name:   "SSH format with .git suffix",
			gitURL: "git@github.com:friendsfriend/devenv.git",
			expected: &ProjectInfo{
				Host:      "github.com",
				Namespace: "friendsfriend",
				Project:   "devenv",
			},
			expectError: false,
		},
		{
			name:   "SSH format without .git suffix",
			gitURL: "git@github.com:friendsfriend/devenv",
			expected: &ProjectInfo{
				Host:      "github.com",
				Namespace: "friendsfriend",
				Project:   "devenv",
			},
			expectError: false,
		},
		{
			name:   "HTTPS format with .git suffix",
			gitURL: "https://github.com/friendsfriend/devenv.git",
			expected: &ProjectInfo{
				Host:      "github.com",
				Namespace: "friendsfriend",
				Project:   "devenv",
			},
			expectError: false,
		},
		{
			name:   "HTTPS format without .git suffix",
			gitURL: "https://github.com/friendsfriend/devenv",
			expected: &ProjectInfo{
				Host:      "github.com",
				Namespace: "friendsfriend",
				Project:   "devenv",
			},
			expectError: false,
		},
		{
			name:   "HTTP format (should work)",
			gitURL: "http://github.com/friendsfriend/devenv.git",
			expected: &ProjectInfo{
				Host:      "github.com",
				Namespace: "friendsfriend",
				Project:   "devenv",
			},
			expectError: false,
		},
		{
			name:        "Empty URL",
			gitURL:      "",
			expected:    nil,
			expectError: true,
		},
		{
			name:        "Invalid SSH format",
			gitURL:      "git@hostname",
			expected:    nil,
			expectError: true,
		},
		{
			name:        "Invalid project path",
			gitURL:      "git@github.com:project-without-namespace",
			expected:    nil,
			expectError: true,
		},
		{
			name:        "Unsupported format",
			gitURL:      "ftp://github.com/project/repo.git",
			expected:    nil,
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ExtractProjectInfo(tt.gitURL)

			if tt.expectError {
				if err == nil {
					t.Errorf("ExtractProjectInfo(%q) expected error but got none", tt.gitURL)
				}
				return
			}

			if err != nil {
				t.Errorf("ExtractProjectInfo(%q) unexpected error: %v", tt.gitURL, err)
				return
			}

			if result == nil {
				t.Errorf("ExtractProjectInfo(%q) returned nil result", tt.gitURL)
				return
			}

			if result.Host != tt.expected.Host {
				t.Errorf("ExtractProjectInfo(%q) Host = %q, expected %q", tt.gitURL, result.Host, tt.expected.Host)
			}

			if result.Namespace != tt.expected.Namespace {
				t.Errorf("ExtractProjectInfo(%q) Namespace = %q, expected %q", tt.gitURL, result.Namespace, tt.expected.Namespace)
			}

			if result.Project != tt.expected.Project {
				t.Errorf("ExtractProjectInfo(%q) Project = %q, expected %q", tt.gitURL, result.Project, tt.expected.Project)
			}
		})
	}
}

func TestFailedTestGrouping(t *testing.T) {
	// Create mock test suites data with various failing tests
	testSuites := []TestSuite{
		{
			Name: "UserServiceTests",
			TestCases: []TestCase{
				{Name: "testCreateUser", Classname: "com.example.service.UserService", Status: "failed"},
				{Name: "testDeleteUser", Classname: "com.example.service.UserService", Status: "failed"},
				{Name: "testUpdateUser", Classname: "com.example.service.UserService", Status: "success"},
			},
		},
		{
			Name: "AuthControllerTests",
			TestCases: []TestCase{
				{Name: "testLogin", Classname: "com.example.controller.AuthController", Status: "error"},
				{Name: "testLogout", Classname: "com.example.controller.AuthController", Status: "success"},
			},
		},
		{
			Name: "UtilsTests",
			TestCases: []TestCase{
				{Name: "testStringUtils", Classname: "Utils", Status: "failed"}, // Simple class name
			},
		},
	}

	// Simulate the logic from GetTestSummary for grouping failed tests
	classToFailedTests := make(map[string][]string)

	for _, suite := range testSuites {
		for _, testCase := range suite.TestCases {
			if testCase.Status == "failed" || testCase.Status == "error" {
				// Determine the class name without package prefix
				className := testCase.Classname
				if className == "" {
					className = suite.Name
					if className == "" {
						className = "Unknown"
					}
				}

				// Extract just the class name from full package path
				if strings.Contains(className, ".") {
					parts := strings.Split(className, ".")
					className = parts[len(parts)-1] // Take the last part
				}

				// Get the test method name
				methodName := testCase.Name

				// Group by class name
				classToFailedTests[className] = append(classToFailedTests[className], methodName)
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

	// Verify the groupings
	if len(failedTestGroups) != 3 {
		t.Errorf("Expected 3 failed test groups, got %d", len(failedTestGroups))
	}

	// Create a map for easier testing
	groupMap := make(map[string][]string)
	for _, group := range failedTestGroups {
		groupMap[group.ClassName] = group.TestMethods
	}

	// Verify UserService group
	userServiceMethods, exists := groupMap["UserService"]
	if !exists {
		t.Error("Expected UserService group not found")
	} else if len(userServiceMethods) != 2 {
		t.Errorf("Expected 2 methods in UserService group, got %d", len(userServiceMethods))
	} else {
		expectedMethods := map[string]bool{"testCreateUser": true, "testDeleteUser": true}
		for _, method := range userServiceMethods {
			if !expectedMethods[method] {
				t.Errorf("Unexpected method %s in UserService group", method)
			}
		}
	}

	// Verify AuthController group
	authControllerMethods, exists := groupMap["AuthController"]
	if !exists {
		t.Error("Expected AuthController group not found")
	} else if len(authControllerMethods) != 1 {
		t.Errorf("Expected 1 method in AuthController group, got %d", len(authControllerMethods))
	} else if authControllerMethods[0] != "testLogin" {
		t.Errorf("Expected testLogin in AuthController group, got %s", authControllerMethods[0])
	}

	// Verify Utils group (simple class name)
	utilsMethods, exists := groupMap["Utils"]
	if !exists {
		t.Error("Expected Utils group not found")
	} else if len(utilsMethods) != 1 {
		t.Errorf("Expected 1 method in Utils group, got %d", len(utilsMethods))
	} else if utilsMethods[0] != "testStringUtils" {
		t.Errorf("Expected testStringUtils in Utils group, got %s", utilsMethods[0])
	}

	t.Logf("Successfully grouped %d failing tests into %d classes", 4, len(failedTestGroups))
}

func TestGetChangeRequestsWithOptions_SkipDetails(t *testing.T) {
	// Track API calls
	var listCalls, detailCalls, approvalsCalls int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check approvals endpoint first (it's a sub-path of merge_requests)
		if strings.Contains(r.URL.Path, "/approvals") {
			approvalsCalls++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(MergeRequestApprovals{})
			return
		}
		// Single MR detail call
		if strings.Contains(r.URL.Path, "/merge_requests/") {
			detailCalls++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(ChangeRequest{
				ID:    1,
				IID:   42,
				Title: "Test MR",
			})
			return
		}

		// List MRs endpoint
		listCalls++
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]ChangeRequest{
			{
				ID:    1,
				IID:   42,
				Title: "Test MR",
				State: "opened",
			},
			{
				ID:    2,
				IID:   43,
				Title: "Test MR 2",
				State: "opened",
			},
		})
	}))
	defer srv.Close()

	c := &client{
		baseURL:    srv.URL,
		token:      "test-token",
		username:   "test-user",
		httpClient: srv.Client(),
	}

	projectInfo := &ProjectInfo{
		Host:      "gitlab.example.com",
		Namespace: "group",
		Project:   "project",
	}

	// Test with SkipDetails=true — should only make the list call
	listCalls = 0
	detailCalls = 0
	approvalsCalls = 0

	result, err := c.GetChangeRequestsWithOptions(projectInfo, &changerequest.ChangeRequestListOptions{
		SkipDetails: true,
		PerPage:     50,
	})
	if err != nil {
		t.Fatalf("GetChangeRequestsWithOptions (SkipDetails=true): %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.ChangeRequests) != 2 {
		t.Errorf("expected 2 MRs, got %d", len(result.ChangeRequests))
	}
	if detailCalls > 0 {
		t.Errorf("expected 0 detail calls with SkipDetails=true, got %d", detailCalls)
	}
	if approvalsCalls > 0 {
		t.Errorf("expected 0 approvals calls with SkipDetails=true, got %d", approvalsCalls)
	}
	if listCalls != 1 {
		t.Errorf("expected 1 list call, got %d", listCalls)
	}

	// Test with SkipDetails=false — should make detail calls per MR (approvals fetched inside GetChangeRequest)
	listCalls = 0
	detailCalls = 0
	approvalsCalls = 0

	result, err = c.GetChangeRequestsWithOptions(projectInfo, &changerequest.ChangeRequestListOptions{
		SkipDetails: false,
		PerPage:     50,
	})
	if err != nil {
		t.Fatalf("GetChangeRequestsWithOptions (SkipDetails=false): %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.ChangeRequests) != 2 {
		t.Errorf("expected 2 MRs, got %d", len(result.ChangeRequests))
	}
	if detailCalls != 2 {
		t.Errorf("expected 2 detail calls with SkipDetails=false, got %d", detailCalls)
	}
}

func TestGetChangeRequestsWithOptions_Pagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the query params
		if r.URL.Query().Get("page") != "2" {
			t.Errorf("expected page=2, got %s", r.URL.Query().Get("page"))
		}
		if r.URL.Query().Get("per_page") != "25" {
			t.Errorf("expected per_page=25, got %s", r.URL.Query().Get("per_page"))
		}
		if r.URL.Query().Get("state") != "opened" {
			t.Errorf("expected state=opened, got %s", r.URL.Query().Get("state"))
		}

		// Return pagination headers
		w.Header().Set("X-Total", "100")
		w.Header().Set("X-Total-Pages", "4")
		w.Header().Set("X-Page", "2")
		w.Header().Set("Content-Type", "application/json")

		// Return empty list for this test
		json.NewEncoder(w).Encode([]ChangeRequest{})
	}))
	defer srv.Close()

	c := &client{
		baseURL:    srv.URL,
		token:      "test-token",
		username:   "test-user",
		httpClient: srv.Client(),
	}

	projectInfo := &ProjectInfo{
		Host:      "gitlab.example.com",
		Namespace: "group",
		Project:   "project",
	}

	result, err := c.GetChangeRequestsWithOptions(projectInfo, &changerequest.ChangeRequestListOptions{
		Page:    2,
		PerPage: 25,
		State:   "opened",
	})
	if err != nil {
		t.Fatalf("GetChangeRequestsWithOptions: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.TotalCount != 100 {
		t.Errorf("TotalCount: got %d, want 100", result.TotalCount)
	}
	if result.TotalPages != 4 {
		t.Errorf("TotalPages: got %d, want 4", result.TotalPages)
	}
	if result.CurrentPage != 2 {
		t.Errorf("CurrentPage: got %d, want 2", result.CurrentPage)
	}
	if result.PerPage != 25 {
		t.Errorf("PerPage: got %d, want 25", result.PerPage)
	}
}

func TestGetChangeRequestsWithOptions_MissingHeaders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Return no pagination headers (GitLab behavior when total > 10,000)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]ChangeRequest{})
	}))
	defer srv.Close()

	c := &client{
		baseURL:    srv.URL,
		token:      "test-token",
		username:   "test-user",
		httpClient: srv.Client(),
	}

	projectInfo := &ProjectInfo{
		Host:      "gitlab.example.com",
		Namespace: "group",
		Project:   "project",
	}

	result, err := c.GetChangeRequestsWithOptions(projectInfo, &changerequest.ChangeRequestListOptions{
		Page:    1,
		PerPage: 50,
		State:   "opened",
	})
	if err != nil {
		t.Fatalf("GetChangeRequestsWithOptions: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.TotalCount != -1 {
		t.Errorf("TotalCount: got %d, want -1 (unknown)", result.TotalCount)
	}
	if result.TotalPages != -1 {
		t.Errorf("TotalPages: got %d, want -1 (unknown)", result.TotalPages)
	}
	if result.CurrentPage != 1 {
		t.Errorf("CurrentPage: got %d, want 1", result.CurrentPage)
	}
}
