package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInstanceTokenMiddlewareRejectsMissingToken(t *testing.T) {
	t.Setenv("DEVENV_INSTANCE_TOKEN", "secret-token")
	s := &Server{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := s.instanceTokenMiddleware(next)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/apps", nil))
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: got %d", res.Code)
	}

	res = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	req.Header.Set("X-Instance-Token", "wrong")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("forged token: got %d", res.Code)
	}

	res = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	req.Header.Set("X-Instance-Token", "secret-token")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("valid token: got %d", res.Code)
	}
}

func TestInstanceTokenMiddlewareLeavesHealthOpen(t *testing.T) {
	t.Setenv("DEVENV_INSTANCE_TOKEN", "secret-token")
	s := &Server{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := s.instanceTokenMiddleware(next)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("health should stay reachable: got %d", res.Code)
	}
}

func TestInstanceTokenMiddlewareDisabledWithoutToken(t *testing.T) {
	t.Setenv("DEVENV_INSTANCE_TOKEN", "")
	s := &Server{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := s.instanceTokenMiddleware(next)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/apps", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("tokenless dev mode should pass: got %d", res.Code)
	}
}

func TestCorsMiddlewareEchoesOnlyLoopbackOrigin(t *testing.T) {
	s := &Server{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := s.corsMiddleware(next)

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	handler.ServeHTTP(res, req)
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("loopback origin not echoed: %q", got)
	}

	res = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	req.Header.Set("Origin", "https://evil.example")
	handler.ServeHTTP(res, req)
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("foreign origin should not be allowed: %q", got)
	}
}
