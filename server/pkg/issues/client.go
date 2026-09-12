// Package issues provides a unified interface for issue operations
// across different Git providers (GitHub, GitLab, etc.).
package issues

import "github.com/friendsfriend/devenv/pkg/changerequest"

// IssueListOptions holds pagination and filter options for listing issues.
type IssueListOptions struct {
	Scope         string
	State         string
	Search        string
	Labels        []string
	SortBy        string
	SortDirection string
	Page          int
	PerPage       int
}

// RepoInfo holds repository identification for a Git provider.
type RepoInfo struct {
	Owner     string
	Repo      string
	Host      string
	Namespace string
	Project   string
}

// Client is the unified interface for issue operations across providers.
type Client interface {
	GetIssues(info *RepoInfo, options *IssueListOptions) (*IssueListResult, error)
	GetIssue(info *RepoInfo, number int) (*Issue, error)
	GetIssueComments(info *RepoInfo, number int) (*IssueCommentListResult, error)

	// Mutations
	CloseIssue(info *RepoInfo, number int, reason string) (*Issue, error)
	ReopenIssue(info *RepoInfo, number int) (*Issue, error)
	SetLabels(info *RepoInfo, number int, labels []string) (*Issue, error)
	AddAssignee(info *RepoInfo, number int, assignee string) (*Issue, error)
	RemoveAssignee(info *RepoInfo, number int) (*Issue, error)

	// Comments
	AddComment(info *RepoInfo, number int, body string) (*IssueComment, error)

	// Repo queries for mutation pickers
	GetRepoLabels(info *RepoInfo) ([]string, error)
	GetRepoCollaborators(info *RepoInfo) ([]string, error)

	// GetIssueLinkedChangeRequests returns change requests linked to an issue.
	GetIssueLinkedChangeRequests(info *RepoInfo, number int) ([]changerequest.ChangeRequest, error)
}
