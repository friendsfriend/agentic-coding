package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/friendsfriend/devenv/pkg/gitlab"
)

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

// crReviewSession holds the context for one active CR review stream.
// It is registered when the stream starts and removed when it ends.
type crReviewSession struct {
	appIdent string
	crIID    int
	mu       sync.Mutex

	// CR diff versions – lazily fetched on the first comment callback
	versionsLoaded bool
	baseSHA        string
	headSHA        string
	startSHA       string
}

func generateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *Server) registerCRSession(token, appIdent string, crIID int) {
	s.crSessionsMu.Lock()
	defer s.crSessionsMu.Unlock()
	s.crSessions[token] = &crReviewSession{appIdent: appIdent, crIID: crIID}
}

func (s *Server) deregisterCRSession(token string) {
	s.crSessionsMu.Lock()
	defer s.crSessionsMu.Unlock()
	delete(s.crSessions, token)
}

func (s *Server) getCRSession(token string) *crReviewSession {
	s.crSessionsMu.Lock()
	defer s.crSessionsMu.Unlock()
	return s.crSessions[token]
}

// ensureCRVersions lazily fetches and caches the CR diff SHAs in the session.
func (s *Server) ensureCRVersions(sess *crReviewSession, gitlabClient gitlab.Client, projectInfo *gitlab.ProjectInfo) error {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.versionsLoaded {
		return nil
	}
	versions, err := gitlabClient.GetMRVersions(projectInfo, sess.crIID)
	if err != nil {
		return fmt.Errorf("fetch CR versions: %w", err)
	}
	if len(versions) == 0 {
		return fmt.Errorf("no CR versions found")
	}
	// First version is the latest diff
	v := versions[0]
	getString := func(key string) string {
		if val, ok := v[key].(string); ok {
			return val
		}
		return ""
	}
	sess.baseSHA = getString("base_commit_sha")
	sess.headSHA = getString("head_commit_sha")
	sess.startSHA = getString("start_commit_sha")
	if sess.baseSHA == "" || sess.headSHA == "" || sess.startSHA == "" {
		return fmt.Errorf("CR version SHAs missing (base=%q head=%q start=%q)", sess.baseSHA, sess.headSHA, sess.startSHA)
	}
	sess.versionsLoaded = true
	return nil
}

// ---------------------------------------------------------------------------
// POST /api/ai/cr-comment-callback/{token}
// ---------------------------------------------------------------------------
// Called by a pi session (via curl) during a review to post an inline diff
// comment or a top-level CR note.  Request body:
//
//	{ "file": "src/foo.ts", "line": 42, "comment": "Null check missing" }
//
// Omit "file"/"line" for a general (top-level) comment.
func (s *Server) handleCRCommentCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	token := strings.TrimPrefix(r.URL.Path, "/api/ai/cr-comment-callback/")
	if token == "" {
		respondBadRequest(w, "missing token in path")
		return
	}

	sess := s.getCRSession(token)
	if sess == nil {
		respondErrorMessage(w, "unknown or expired review session token", http.StatusUnauthorized)
		return
	}

	var req struct {
		File    string `json:"file"`
		Line    *int   `json:"line"`
		Comment string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, "invalid request body")
		return
	}
	if req.Comment == "" {
		respondBadRequest(w, "comment field required")
		return
	}

	targetApp := s.findAppByIdent(sess.appIdent)
	if targetApp == nil {
		respondErrorMessage(w, "app not found", http.StatusNotFound)
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("GitLab client error: %v", err), http.StatusBadGateway)
		return
	}

	// Prepend AI attribution
	body := "> 🤖 *AI Review — auto-generated. Please verify before acting.*\n\n" + req.Comment

	var position *gitlab.DiffPosition

	if req.File != "" && req.Line != nil {
		// Inline diff comment — need CR SHAs
		if err := s.ensureCRVersions(sess, gitlabClient, projectInfo); err != nil {
			log.Printf("[CR AI Callback] version load failed: %v", err)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		position = &gitlab.DiffPosition{
			BaseSHA:      sess.baseSHA,
			HeadSHA:      sess.headSHA,
			StartSHA:     sess.startSHA,
			PositionType: "text",
			NewPath:      req.File,
			OldPath:      req.File,
			NewLine:      req.Line,
		}
	}

	if err := gitlabClient.CreateMRDiffComment(projectInfo, sess.crIID, body, position); err != nil {
		log.Printf("[CR AI Callback] comment post failed (file=%q line=%v): %v", req.File, req.Line, err)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}

	log.Printf("[CR AI Callback] posted comment (file=%q line=%v)", req.File, req.Line)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// ---------------------------------------------------------------------------
// POST /api/ai/cr-review-stream
// ---------------------------------------------------------------------------

func (s *Server) handleAICRReviewStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	var req struct {
		AppIdent     string `json:"appIdent"`
		CRIID        int    `json:"crIID"`
		SourceBranch string `json:"sourceBranch"`
		TargetBranch string `json:"targetBranch"`
		Prompt       string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}
	if req.AppIdent == "" {
		respondBadRequest(w, "appIdent field required")
		return
	}
	if req.SourceBranch == "" {
		respondBadRequest(w, "sourceBranch field required")
		return
	}
	if req.TargetBranch == "" {
		req.TargetBranch = "dev"
	}
	if req.Prompt == "" {
		respondBadRequest(w, "prompt field required")
		return
	}
	targetApp := s.findAppByIdent(req.AppIdent)
	if targetApp == nil {
		respondErrorMessage(w, fmt.Sprintf("app not found: %s", req.AppIdent), http.StatusNotFound)
		return
	}
	if targetApp.LocalDirectoryPath == "" {
		respondErrorMessage(w, "app has no local directory path", http.StatusUnprocessableEntity)
		return
	}

	// --- SSE setup ---
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	sendError := func(msg string) {
		escaped, _ := json.Marshal(msg)
		fmt.Fprintf(w, "data: {\"error\":%s}\n\n", escaped)
		flusher.Flush()
	}

	// --- Register per-review session for the comment callback ---
	token, err := generateToken()
	if err != nil {
		sendError("failed to generate session token")
		return
	}
	if req.CRIID > 0 {
		s.registerCRSession(token, req.AppIdent, req.CRIID)
		defer s.deregisterCRSession(token)
	}

	// --- Create temp worktree ---
	worktreeID := fmt.Sprintf("cr-review-%d", time.Now().UnixNano())
	worktreePath := filepath.Join(os.TempDir(), worktreeID)

	if err := crWorktreeAdd(targetApp.LocalDirectoryPath, req.SourceBranch, worktreePath); err != nil {
		log.Printf("[CR AI Review] worktree add failed: %v", err)
		sendError(fmt.Sprintf("Could not check out branch %q: %v", req.SourceBranch, err))
		return
	}
	defer func() {
		if err := crWorktreeRemove(targetApp.LocalDirectoryPath, worktreePath); err != nil {
			log.Printf("[CR AI Review] worktree cleanup failed: %v", err)
		}
	}()

	log.Printf("[CR AI Review] worktree ready at %s (branch: %s, agent: pi)", worktreePath, req.SourceBranch)

	// --- Build the full prompt with callback instructions appended ---
	callbackURL := fmt.Sprintf("http://127.0.0.1:%d/api/ai/cr-comment-callback/%s", s.port, token)
	fullPrompt := req.Prompt + buildCallbackInstructions(callbackURL, req.CRIID > 0)

	// --- Spawn pi and stream ---
	streamMRReviewPi(ctx, w, flusher, worktreePath, fullPrompt, sendError)
}

// buildCallbackInstructions appends inline-comment curl instructions to the
// agent prompt.  When crIID is 0 (not a GitLab change request), the section is omitted.
func buildCallbackInstructions(callbackURL string, isGitLab bool) string {
	if !isGitLab {
		return ""
	}
	return fmt.Sprintf(`

---
INLINE COMMENT TOOL:
As you identify specific code issues, post them as inline GitLab comments using curl.
This creates real comments directly on the diff lines in the CR.

For a line-specific comment (preferred when you have a precise file + line):
  curl -s -X POST '%s' \
    -H 'Content-Type: application/json' \
    -d '{"file":"<new_path>","line":<new_line_number>,"comment":"<your comment text>"}'

For a general comment not tied to a specific line:
  curl -s -X POST '%s' \
    -H 'Content-Type: application/json' \
    -d '{"comment":"<your comment text>"}'

Rules:
- "file" is the path as it appears in the diff (new_path after the change)
- "line" is the new file line number (from the file content, not the diff +/- counter)
- The endpoint returns {"ok":true} on success or {"ok":false,"error":"..."} on failure
- If a line number is wrong and GitLab rejects it, skip that inline comment and note it in your summary instead
- Post inline comments as you find issues, then write a concise overall summary to stdout at the end
- Keep your stdout clean — it is shown to the developer in a review overlay`, callbackURL, callbackURL)
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

func crWorktreeAdd(repoDir, branch, worktreePath string) error {
	fetchCtx, fetchCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer fetchCancel()
	exec.CommandContext(fetchCtx, "git", "-C", repoDir, "fetch", "origin", branch).Run() //nolint:errcheck

	// Try detached HEAD at origin/<branch> first
	cmd := exec.Command("git", "-C", repoDir, "worktree", "add", "--detach", worktreePath, "origin/"+branch)
	if out, err := cmd.CombinedOutput(); err == nil {
		return nil
	} else {
		log.Printf("[CR AI Review] origin/%s worktree failed (%v: %s), trying local branch", branch, err, strings.TrimSpace(string(out)))
	}

	// Fallback: local branch
	cmd = exec.Command("git", "-C", repoDir, "worktree", "add", worktreePath, branch)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func crWorktreeRemove(repoDir, worktreePath string) error {
	out, err := exec.Command("git", "-C", repoDir, "worktree", "remove", "--force", worktreePath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Agent spawn helpers
// ---------------------------------------------------------------------------

// streamMRReviewPi starts pi in RPC mode (--mode rpc) inside the worktree,
// sends the review prompt via stdin, and streams JSONL events back as SSE deltas.
// RPC mode emits events as they happen (true streaming), unlike --print which
// buffers all output until the agent finishes.
func streamMRReviewPi(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, worktreePath, prompt string, sendError func(string)) {
	if _, err := exec.LookPath("pi"); err != nil {
		sendError("pi not found in PATH")
		return
	}

	promptFile := filepath.Join(worktreePath, "REVIEW_PROMPT.md")
	if err := os.WriteFile(promptFile, []byte(prompt), 0644); err != nil {
		sendError(fmt.Sprintf("failed to write prompt file: %v", err))
		return
	}
	defer os.Remove(promptFile)

	cmd := exec.CommandContext(ctx, "pi",
		"--mode", "rpc",
		"--no-session",
		"--tools", "bash,read,grep,find",
		"--thinking", "low",
	)
	cmd.Dir = worktreePath

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		sendError(fmt.Sprintf("failed to open pi stdin: %v", err))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendError(fmt.Sprintf("failed to open pi stdout: %v", err))
		return
	}
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		sendError(fmt.Sprintf("failed to start pi: %v", err))
		return
	}

	// Send the review prompt as the first RPC command
	promptContent, _ := os.ReadFile(promptFile)
	promptCmd, _ := json.Marshal(map[string]interface{}{
		"type":    "prompt",
		"message": string(promptContent),
	})
	stdinPipe.Write(append(promptCmd, '\n'))

	// Read JSONL events from pi via a goroutine so ctx cancellation is non-blocking
	type rpcLine struct {
		data []byte
		done bool
	}
	linesCh := make(chan rpcLine, 128)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1 MB line buffer for large tool outputs
		for scanner.Scan() {
			b := scanner.Bytes()
			cp := make([]byte, len(b))
			copy(cp, b)
			linesCh <- rpcLine{data: cp}
		}
		linesCh <- rpcLine{done: true}
	}()

	sendDelta := func(text string) {
		if text == "" {
			return
		}
		escaped, _ := json.Marshal(text)
		fmt.Fprintf(w, "data: {\"delta\":%s}\n\n", escaped)
		flusher.Flush()
	}

	hadOutput := false

	for {
		select {
		case <-ctx.Done():
			stdinPipe.Close()
			cmd.Wait()
			sendError("review timed out after 5 minutes")
			return

		case evt := <-linesCh:
			if evt.done {
				goto streamDone
			}

			var e struct {
				Type                  string `json:"type"`
				AssistantMessageEvent *struct {
					Type  string `json:"type"`
					Delta string `json:"delta"`
				} `json:"assistantMessageEvent"`
				ToolName string          `json:"toolName"`
				Args     json.RawMessage `json:"args"`
				Command  string          `json:"command"`
				Success  *bool           `json:"success"`
				Error    string          `json:"error"`
			}
			if err := json.Unmarshal(evt.data, &e); err != nil {
				continue
			}

			switch e.Type {
			case "message_update":
				if e.AssistantMessageEvent == nil {
					continue
				}
				switch e.AssistantMessageEvent.Type {
				case "text_delta":
					sendDelta(e.AssistantMessageEvent.Delta)
					hadOutput = true
				case "thinking_delta":
					// Show thinking inline with a muted prefix
					sendDelta(e.AssistantMessageEvent.Delta)
					hadOutput = true
				}

			case "tool_execution_start":
				// Show which tool is being called
				var argsMap map[string]interface{}
				json.Unmarshal(e.Args, &argsMap)
				if cmd, ok := argsMap["command"].(string); ok && e.ToolName == "bash" {
					sendDelta(fmt.Sprintf("\n> `%s`\n", cmd))
				} else {
					sendDelta(fmt.Sprintf("\n> running %s…\n", e.ToolName))
				}
				hadOutput = true

			case "agent_end":
				goto streamDone

			case "response":
				// RPC command response — check for errors
				if e.Success != nil && !*e.Success && e.Error != "" {
					log.Printf("[CR AI RPC] command %q failed: %s", e.Command, e.Error)
				}
			}
		}
	}

streamDone:
	stdinPipe.Close()
	waitErr := cmd.Wait()
	if waitErr != nil && ctx.Err() == context.DeadlineExceeded {
		sendError("review timed out after 5 minutes")
		return
	}
	if !hadOutput {
		errMsg := strings.TrimSpace(stderrBuf.String())
		if errMsg == "" {
			errMsg = "pi produced no output"
		}
		sendError(fmt.Sprintf("pi error: %s", errMsg))
		return
	}
	fmt.Fprintf(w, "data: {\"done\":true}\n\n")
	flusher.Flush()
}
