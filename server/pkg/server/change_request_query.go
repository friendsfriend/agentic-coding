package server

import (
	"net/http"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

type changeRequestListQuery struct {
	AppIdent     string
	AllBranches  bool
	State        string
	PageParam    string
	PerPageParam string
	Options      changerequest.ChangeRequestListOptions
}

func parseChangeRequestListQuery(r *http.Request) changeRequestListQuery {
	q := r.URL.Query()
	pageParam := q.Get("page")
	perPageParam := q.Get("perPage")
	state := q.Get("state")
	if state == "" {
		state = "opened"
	}

	return changeRequestListQuery{
		AppIdent:     q.Get("appIdent"),
		AllBranches:  q.Get("allBranches") == "true",
		State:        state,
		PageParam:    pageParam,
		PerPageParam: perPageParam,
		Options: changerequest.ChangeRequestListOptions{
			State:         state,
			Page:          parsePage(pageParam),
			PerPage:       parsePerPage(perPageParam),
			Search:        q.Get("search"),
			Labels:        splitCSV(q.Get("labels")),
			SortBy:        q.Get("sort"),
			SortDirection: q.Get("direction"),
			SkipDetails:   pageParam != "" || perPageParam != "",
		},
	}
}
