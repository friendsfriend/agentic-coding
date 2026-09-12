package server

import (
	"net/http/httptest"
	"testing"
)

func TestParseChangeRequestListQuery(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/gitlab/merge-requests?appIdent=app&allBranches=true&page=2&perPage=500&search=bug&sort=updated&direction=asc&labels=bug,%20ui", nil)
	query := parseChangeRequestListQuery(req)

	if query.AppIdent != "app" {
		t.Fatalf("AppIdent = %q, want app", query.AppIdent)
	}
	if !query.AllBranches {
		t.Fatalf("AllBranches = false, want true")
	}
	if query.Options.State != "opened" {
		t.Fatalf("State = %q, want opened", query.Options.State)
	}
	if query.Options.Page != 2 {
		t.Fatalf("Page = %d, want 2", query.Options.Page)
	}
	if query.Options.PerPage != maxPerPage {
		t.Fatalf("PerPage = %d, want %d", query.Options.PerPage, maxPerPage)
	}
	if query.Options.Search != "bug" || query.Options.SortBy != "updated" || query.Options.SortDirection != "asc" {
		t.Fatalf("unexpected search/sort options: %+v", query.Options)
	}
	if len(query.Options.Labels) != 2 || query.Options.Labels[0] != "bug" || query.Options.Labels[1] != "ui" {
		t.Fatalf("Labels = %#v, want [bug ui]", query.Options.Labels)
	}
	if !query.Options.SkipDetails {
		t.Fatalf("SkipDetails = false, want true")
	}
}

func TestParseChangeRequestListQueryExplicitState(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/github/pull-requests?state=closed", nil)
	query := parseChangeRequestListQuery(req)

	if query.Options.State != "closed" {
		t.Fatalf("State = %q, want closed", query.Options.State)
	}
	if query.Options.SkipDetails {
		t.Fatalf("SkipDetails = true, want false")
	}
}
