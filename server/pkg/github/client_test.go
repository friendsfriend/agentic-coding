package github

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

func TestExtractRepoInfo(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantOwner string
		wantRepo  string
		wantErr   bool
	}{
		{
			name:      "HTTPS with .git suffix",
			input:     "https://github.com/owner/repo.git",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "HTTPS without .git suffix",
			input:     "https://github.com/owner/repo",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "SSH format",
			input:     "git@github.com:owner/repo.git",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "SSH format without .git",
			input:     "git@github.com:owner/repo",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:    "Empty URL",
			input:   "",
			wantErr: true,
		},
		{
			name:    "Non-GitHub URL",
			input:   "https://gitlab.com/owner/repo.git",
			wantErr: true,
		},
		{
			name:    "Missing repo",
			input:   "https://github.com/owner",
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info, err := ExtractRepoInfo(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Errorf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if info.Owner != tc.wantOwner {
				t.Errorf("owner: got %q, want %q", info.Owner, tc.wantOwner)
			}
			if info.Repo != tc.wantRepo {
				t.Errorf("repo: got %q, want %q", info.Repo, tc.wantRepo)
			}
		})
	}
}

func TestGetChangeRequests(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/pulls":
			prs := []ghPR{
				{
					ID:        1,
					Number:    42,
					Title:     "Test PR",
					Body:      "Description",
					State:     "open",
					HTMLURL:   "https://github.com/owner/repo/pull/42",
					CreatedAt: now,
					UpdatedAt: now,
					User:      ghUser{Login: "testuser"},
					Head:      ghPRBranch{Ref: "feature/test"},
					Base:      ghPRBranch{Ref: "main"},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(prs)
		case "/repos/owner/repo/pulls/42/reviews":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]ghReview{})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &changerequest.RepoInfo{Owner: "owner", Repo: "repo"}
	result, err := c.GetChangeRequests(info, nil)
	if err != nil {
		t.Fatalf("GetChangeRequests: %v", err)
	}
	if len(result.ChangeRequests) != 1 {
		t.Fatalf("expected 1 PR, got %d", len(result.ChangeRequests))
	}
	prs := result.ChangeRequests
	if prs[0].IID != 42 {
		t.Errorf("IID: got %d, want 42", prs[0].IID)
	}
	if prs[0].Title != "Test PR" {
		t.Errorf("Title: got %q, want %q", prs[0].Title, "Test PR")
	}
	if prs[0].SourceBranch != "feature/test" {
		t.Errorf("SourceBranch: got %q, want %q", prs[0].SourceBranch, "feature/test")
	}
	if prs[0].State != "opened" {
		t.Errorf("State: got %q, want opened", prs[0].State)
	}
}

func TestGetChangeRequestsNilInfo(t *testing.T) {
	c := newClient("token", "user", nil)
	_, err := c.GetChangeRequests(nil, nil)
	if err == nil {
		t.Fatal("expected error for nil info")
	}
}

func TestGetPRApprovals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reviews := []ghReview{
			{ID: 1, User: ghUser{Login: "alice"}, State: "APPROVED"},
			{ID: 2, User: ghUser{Login: "bob"}, State: "CHANGES_REQUESTED"},
			{ID: 3, User: ghUser{Login: "alice"}, State: "DISMISSED"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(reviews)
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &RepoInfo{Owner: "owner", Repo: "repo"}
	approvals, err := c.GetPRApprovals(info, 1)
	if err != nil {
		t.Fatalf("GetPRApprovals: %v", err)
	}
	if len(approvals.ApprovedBy) != 0 {
		t.Errorf("expected 0 approvals (alice's was dismissed), got %d", len(approvals.ApprovedBy))
	}
	if approvals.ApprovalsLeft != 1 {
		t.Errorf("expected 1 approval left, got %d", approvals.ApprovalsLeft)
	}
}

func TestGetChangeRequestChanges(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		files := []ghPRFile{
			{
				Filename:  "README.md",
				Status:    "modified",
				Additions: 3,
				Deletions: 1,
				Patch:     "@@ -1,3 +1,5 @@\n context\n-old line\n+new line\n+added line\n context",
			},
			{
				Filename: "new_file.go",
				Status:   "added",
				Patch:    "@@ -0,0 +1,2 @@\n+package main\n+",
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(files)
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &changerequest.RepoInfo{Owner: "owner", Repo: "repo"}
	changes, err := c.GetChangeRequestChanges(info, 1)
	if err != nil {
		t.Fatalf("GetChangeRequestChanges: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("expected 2 changes, got %d", len(changes))
	}
	if changes[1].NewFile != true {
		t.Errorf("expected NewFile=true for added file")
	}
	if len(changes[0].DiffLines) == 0 {
		t.Errorf("expected non-empty DiffLines for patched file")
	}
}

func TestGetDiscussions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/pulls/1/comments":
			comments := []ghPRReviewComment{
				{
					ID:   10,
					Body: "Root comment",
					User: ghUser{Login: "alice"},
					Path: "main.go",
				},
				{
					ID:          11,
					Body:        "Reply comment",
					User:        ghUser{Login: "bob"},
					InReplyToID: intPtr(10),
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(comments)
		case "/repos/owner/repo/issues/1/comments":
			comments := []ghIssueComment{
				{
					ID:   20,
					Body: "Top level comment",
					User: ghUser{Login: "carol"},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(comments)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &changerequest.RepoInfo{Owner: "owner", Repo: "repo"}
	discussions, err := c.GetDiscussions(info, 1)
	if err != nil {
		t.Fatalf("GetDiscussions: %v", err)
	}
	if len(discussions) != 2 {
		t.Fatalf("expected 2 discussions (1 thread + 1 issue comment), got %d", len(discussions))
	}
	thread := discussions[0]
	if len(thread.Notes) != 2 {
		t.Errorf("expected thread to have 2 notes (root + reply), got %d", len(thread.Notes))
	}
	if discussions[1].IndividualNote != true {
		t.Errorf("expected issue comment to be IndividualNote=true")
	}
}

func TestParseDiffLines(t *testing.T) {
	patch := "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+added line\n context2"
	lines := parseDiffLinesToChangeRequest(patch, "foo.go")

	if len(lines) == 0 {
		t.Fatal("expected parsed diff lines, got none")
	}

	var hasNew, hasOld, hasMatch bool
	for _, l := range lines {
		switch l.Type {
		case "new":
			hasNew = true
		case "old":
			hasOld = true
		case "match":
			hasMatch = true
		}
	}

	if !hasNew {
		t.Error("expected at least one 'new' diff line")
	}
	if !hasOld {
		t.Error("expected at least one 'old' diff line")
	}
	if !hasMatch {
		t.Error("expected at least one 'match' diff line")
	}
}

func TestStateConversions(t *testing.T) {
	openPR := ghPR{State: "open"}
	if prStateToChangeRequestState(openPR) != "opened" {
		t.Errorf("open PR should map to 'opened'")
	}

	closedPR := ghPR{State: "closed"}
	if prStateToChangeRequestState(closedPR) != "closed" {
		t.Errorf("closed PR should map to 'closed'")
	}

	mergedPR := ghPR{State: "closed", Merged: true}
	if prStateToChangeRequestState(mergedPR) != "merged" {
		t.Errorf("merged PR should map to 'merged'")
	}
}

func intPtr(v int) *int { return &v }

func TestMapRunStatus(t *testing.T) {
	cases := []struct {
		name       string
		status     string
		conclusion string
		want       string
	}{
		{name: "in progress", status: "in progress", conclusion: "", want: "running"},
		{name: "queued", status: "queued", conclusion: "", want: "pending"},
		{name: "waiting", status: "waiting", conclusion: "", want: "pending"},
		{name: "pending", status: "pending", conclusion: "", want: "pending"},
		{name: "success", status: "completed", conclusion: "success", want: "success"},
		{name: "failure", status: "completed", conclusion: "failure", want: "failed"},
		{name: "cancelled", status: "completed", conclusion: "cancelled", want: "canceled"},
		{name: "timed_out", status: "completed", conclusion: "timed_out", want: "failed"},
		{name: "neutral", status: "completed", conclusion: "neutral", want: "success"},
		{name: "skipped", status: "completed", conclusion: "skipped", want: "success"},
		{name: "unknown", status: "completed", conclusion: "something_else", want: "running"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := ghWorkflowRun{Status: tc.status, Conclusion: tc.conclusion}
			got := mapRunStatusToGitLab(run)
			if got != tc.want {
				t.Errorf("mapRunStatusToGitLab({status:%q, conclusion:%q}) = %q, want %q",
					tc.status, tc.conclusion, got, tc.want)
			}
		})
	}
}

func TestConvertActionJobToJob(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	job := ghActionJob{
		ID:          99,
		Name:        "build",
		Status:      "completed",
		Conclusion:  "success",
		StartedAt:   now,
		CompletedAt: now.Add(30 * time.Second),
		HTMLURL:     "https://github.com/owner/repo/actions/runs/1/jobs/99",
		RunID:       1,
	}

	converted := convertActionJob(job, "CI / CD")

	if converted.ID != 99 {
		t.Errorf("ID: got %d, want 99", converted.ID)
	}
	if converted.Name != "build" {
		t.Errorf("Name: got %q, want %q", converted.Name, "build")
	}
	if converted.Stage != "CI / CD" {
		t.Errorf("Stage: got %q, want %q", converted.Stage, "CI / CD")
	}
	if converted.Status != "success" {
		t.Errorf("Status: got %q, want %q", converted.Status, "success")
	}
	if converted.WebURL != "https://github.com/owner/repo/actions/runs/1/jobs/99" {
		t.Errorf("WebURL: got %q", converted.WebURL)
	}
	if converted.Pipeline.ID != 1 {
		t.Errorf("Pipeline.ID: got %d, want 1", converted.Pipeline.ID)
	}
}

func TestGetLatestRunForSHA(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/owner/repo/actions/runs" && r.URL.Query().Get("head_sha") == "abc123" {
			result := struct {
				TotalCount   int             `json:"total_count"`
				WorkflowRuns []ghWorkflowRun `json:"workflow_runs"`
			}{
				TotalCount: 1,
				WorkflowRuns: []ghWorkflowRun{
					{
						ID:         42,
						Name:       "CI",
						Status:     "completed",
						Conclusion: "success",
						HTMLURL:    "https://github.com/owner/repo/actions/runs/42",
						CreatedAt:  now,
						HeadSHA:    "abc123",
						HeadBranch: "main",
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(result)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &RepoInfo{Owner: "owner", Repo: "repo"}
	run, err := c.GetLatestRunForSHA(info, "abc123")
	if err != nil {
		t.Fatalf("GetLatestRunForSHA: %v", err)
	}
	if run == nil {
		t.Fatal("expected non-nil run")
	}
	if run.ID != 42 {
		t.Errorf("run.ID: got %d, want 42", run.ID)
	}
	if run.Status != "completed" {
		t.Errorf("run.Status: got %q, want %q", run.Status, "completed")
	}
	if run.Conclusion != "success" {
		t.Errorf("run.Conclusion: got %q, want %q", run.Conclusion, "success")
	}
}

func TestGetLatestRunForSHANotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := struct {
			TotalCount   int             `json:"total_count"`
			WorkflowRuns []ghWorkflowRun `json:"workflow_runs"`
		}{TotalCount: 0, WorkflowRuns: []ghWorkflowRun{}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &RepoInfo{Owner: "owner", Repo: "repo"}
	run, err := c.GetLatestRunForSHA(info, "deadbeef")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run != nil {
		t.Errorf("expected nil run when no results, got %+v", run)
	}
}

func TestGetRunJobs(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/owner/repo/actions/runs/42/jobs" {
			result := struct {
				TotalCount int           `json:"total_count"`
				Jobs       []ghActionJob `json:"jobs"`
			}{
				TotalCount: 2,
				Jobs: []ghActionJob{
					{
						ID:          101,
						Name:        "lint",
						Status:      "completed",
						Conclusion:  "success",
						StartedAt:   now,
						CompletedAt: now.Add(10 * time.Second),
						HTMLURL:     "https://github.com/owner/repo/actions/runs/42/jobs/101",
						RunID:       42,
					},
					{
						ID:          102,
						Name:        "test",
						Status:      "completed",
						Conclusion:  "failure",
						StartedAt:   now,
						CompletedAt: now.Add(60 * time.Second),
						HTMLURL:     "https://github.com/owner/repo/actions/runs/42/jobs/102",
						RunID:       42,
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(result)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &RepoInfo{Owner: "owner", Repo: "repo"}
	jobs, err := c.GetRunJobs(info, 42)
	if err != nil {
		t.Fatalf("GetRunJobs: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("expected 2 jobs, got %d", len(jobs))
	}
	if jobs[0].ID != 101 {
		t.Errorf("jobs[0].ID: got %d, want 101", jobs[0].ID)
	}
	if jobs[1].Status != "completed" {
		t.Errorf("jobs[1].Status: got %q, want %q", jobs[1].Status, "completed")
	}
	if jobs[1].Conclusion != "failure" {
		t.Errorf("jobs[1].Conclusion: got %q, want %q", jobs[1].Conclusion, "failure")
	}
}

func TestGetChangeRequestsPopulatesHeadPipeline(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	const headSHA = "sha123abc"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/pulls":
			prs := []ghPR{
				{
					ID:        1,
					Number:    7,
					Title:     "feat: add workflows",
					State:     "open",
					HTMLURL:   "https://github.com/owner/repo/pull/7",
					CreatedAt: now,
					UpdatedAt: now,
					User:      ghUser{Login: "dev"},
					Head:      ghPRBranch{Ref: "feature/wf", SHA: headSHA},
					Base:      ghPRBranch{Ref: "main"},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(prs)
		case "/repos/owner/repo/pulls/7/reviews":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]ghReview{})
		case "/repos/owner/repo/actions/runs":
			result := struct {
				TotalCount   int             `json:"total_count"`
				WorkflowRuns []ghWorkflowRun `json:"workflow_runs"`
			}{
				TotalCount: 1,
				WorkflowRuns: []ghWorkflowRun{
					{
						ID:         55,
						Name:       "CI",
						Status:     "completed",
						Conclusion: "success",
						HTMLURL:    "https://github.com/owner/repo/actions/runs/55",
						CreatedAt:  now,
						HeadSHA:    headSHA,
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(result)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: srv.URL, inner: http.DefaultTransport}},
	}

	info := &changerequest.RepoInfo{Owner: "owner", Repo: "repo"}
	result, err := c.GetChangeRequests(info, nil)
	if err != nil {
		t.Fatalf("GetChangeRequests: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.ChangeRequests) != 1 {
		t.Fatalf("expected 1 PR, got %d", len(result.ChangeRequests))
	}
	pr := result.ChangeRequests[0]
	if pr.HeadPipeline == nil {
		t.Fatal("expected HeadPipeline to be populated, got nil")
	}
	if pr.HeadPipeline.ID != 55 {
		t.Errorf("HeadPipeline.ID: got %d, want 55", pr.HeadPipeline.ID)
	}
	if pr.HeadPipeline.Status != "success" {
		t.Errorf("HeadPipeline.Status: got %q, want %q", pr.HeadPipeline.Status, "success")
	}
}

func TestGetJobLogs(t *testing.T) {
	const expectedLogs = "2024-01-01T00:00:00Z ##[group]Run echo hello\necho hello\nhello\n"

	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			http.Error(w, "unexpected Authorization header on redirect", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(expectedLogs))
	}))
	defer redirectTarget.Close()

	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/owner/repo/actions/jobs/101/logs" {
			http.Redirect(w, r, redirectTarget.URL+"/logs", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	defer apiSrv.Close()

	c := &client{
		token:      "test-token",
		username:   "test-user",
		httpClient: &http.Client{Transport: rewriteTransport{base: apiSrv.URL, inner: http.DefaultTransport}},
	}

	info := &changerequest.RepoInfo{Owner: "owner", Repo: "repo"}
	logs, err := c.GetJobLogs(info, 101)
	if err != nil {
		t.Fatalf("GetJobLogs: unexpected error: %v", err)
	}
	if logs != expectedLogs {
		t.Errorf("GetJobLogs: got %q, want %q", logs, expectedLogs)
	}
}

func TestGetJobLogsNilInfo(t *testing.T) {
	c := newClient("token", "user", nil)
	_, err := c.GetJobLogs(nil, 1)
	if err == nil {
		t.Fatal("expected error for nil repo info, got nil")
	}
}

type rewriteTransport struct {
	base  string
	inner http.RoundTripper
}

func (rt rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req2 := req.Clone(req.Context())
	req2.URL.Scheme = "http"
	req2.URL.Host = rt.base[len("http://"):]
	return rt.inner.RoundTrip(req2)
}

func TestParseLinkHeaderForPagination(t *testing.T) {
	tests := []struct {
		name           string
		linkHeader     string
		currentPage    int
		wantPage       int
		wantTotalPages int
	}{
		{
			name:           "no link header - single page",
			linkHeader:     "",
			currentPage:    1,
			wantPage:       1,
			wantTotalPages: 1,
		},
		{
			name:           "middle page with next and last",
			linkHeader:     `<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next", <https://api.github.com/repos/owner/repo/pulls?page=5>; rel="last"`,
			currentPage:    1,
			wantPage:       1,
			wantTotalPages: 5,
		},
		{
			name:           "last page - no next link",
			linkHeader:     `<https://api.github.com/repos/owner/repo/pulls?page=1>; rel="prev", <https://api.github.com/repos/owner/repo/pulls?page=3>; rel="last"`,
			currentPage:    3,
			wantPage:       3,
			wantTotalPages: 3,
		},
		{
			name:           "first page with last only",
			linkHeader:     `<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next", <https://api.github.com/repos/owner/repo/pulls?page=10>; rel="last"`,
			currentPage:    1,
			wantPage:       1,
			wantTotalPages: 10,
		},
		{
			name:           "second page with prev, next, last",
			linkHeader:     `<https://api.github.com/repos/owner/repo/pulls?page=1>; rel="prev", <https://api.github.com/repos/owner/repo/pulls?page=3>; rel="next", <https://api.github.com/repos/owner/repo/pulls?page=5>; rel="last"`,
			currentPage:    2,
			wantPage:       2,
			wantTotalPages: 5,
		},
		{
			name:           "no last link - set to current page by default",
			linkHeader:     `<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"`,
			currentPage:    1,
			wantPage:       1,
			wantTotalPages: -1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, totalPages := parseLinkHeaderForPagination(tt.linkHeader, tt.currentPage)
			if page != tt.wantPage {
				t.Errorf("page: got %d, want %d", page, tt.wantPage)
			}
			if totalPages != tt.wantTotalPages {
				t.Errorf("totalPages: got %d, want %d", totalPages, tt.wantTotalPages)
			}
		})
	}
}
