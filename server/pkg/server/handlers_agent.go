package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type agentSessionInfo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	TimeCreated int64  `json:"timeCreated"`
	TimeUpdated int64  `json:"timeUpdated"`
}

type agentGroup struct {
	Name     string             `json:"name"`
	Model    string             `json:"model"`
	Sessions []agentSessionInfo `json:"sessions"`
}

func slugify(s string) string {
	s = strings.ToLower(s)
	reg := regexp.MustCompile(`[^a-z0-9]+`)
	s = reg.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	return s
}

func extractHostFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

// queryPiSessions reads pi session files from the pi agent sessions directory
// and returns them grouped by CWD slug as AgentGroup entries.
// Respects the PI_CODING_AGENT_DIR environment variable (default: ~/.pi/agent).
func queryPiSessions() ([]agentGroup, error) {
	if _, err := exec.LookPath("pi"); err != nil {
		return []agentGroup{}, nil
	}

	// Respect PI_CODING_AGENT_DIR env var, fall back to ~/.pi/agent
	agentDir := os.Getenv("PI_CODING_AGENT_DIR")
	if agentDir == "" {
		homedir, err := os.UserHomeDir()
		if err != nil {
			return []agentGroup{}, nil
		}
		agentDir = filepath.Join(homedir, ".pi", "agent")
	}
	sessionsBase := filepath.Join(agentDir, "sessions")

	entries, err := os.ReadDir(sessionsBase)
	if err != nil {
		// Sessions dir doesn't exist yet — not an error
		return []agentGroup{}, nil
	}

	groupsByName := make(map[string][]agentSessionInfo)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dirPath := filepath.Join(sessionsBase, entry.Name())
		files, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}

		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			filePath := filepath.Join(dirPath, f.Name())
			info, cwd, err := parsePiSessionFile(filePath)
			if err != nil {
				continue
			}
			// Use the last path component of the actual cwd as the group name.
			// Fall back to the directory slug if cwd is missing.
			groupName := filepath.Base(cwd)
			if groupName == "." || groupName == "" {
				groupName = entry.Name()
			}
			groupsByName[groupName] = append(groupsByName[groupName], info)
		}
	}

	groups := make([]agentGroup, 0, len(groupsByName))
	for name, sessions := range groupsByName {
		groups = append(groups, agentGroup{Name: name, Sessions: sessions})
	}
	return groups, nil
}

// parsePiSessionFile reads a pi session JSONL file and extracts the session
// metadata plus the first user message as the title.
// The session "id" is set to the full file path so the TUI can pass it
// directly to `pi --session <path>`.
func parsePiSessionFile(filePath string) (agentSessionInfo, string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return agentSessionInfo{}, "", err
	}
	defer f.Close()

	type sessionHeader struct {
		Timestamp string `json:"timestamp"`
		Cwd       string `json:"cwd"`
	}
	type messageContent struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type innerMessage struct {
		Role    string           `json:"role"`
		Content []messageContent `json:"content"`
	}
	type entry struct {
		Type    string       `json:"type"`
		Message innerMessage `json:"message"`
	}

	var header sessionHeader
	var firstUserText string

	scanner := bufio.NewScanner(f)
	// Cap individual line reads at 1 MB to avoid OOM on large tool-call lines.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// Peek at "type" without full decode
		var peek struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &peek); err != nil {
			continue
		}

		switch peek.Type {
		case "session":
			json.Unmarshal(line, &header) //nolint:errcheck
		case "message":
			if firstUserText != "" {
				break
			}
			var e entry
			if err := json.Unmarshal(line, &e); err != nil {
				continue
			}
			if e.Message.Role == "user" {
				for _, part := range e.Message.Content {
					if part.Type == "text" && part.Text != "" {
						firstUserText = part.Text
						break
					}
				}
			}
		}

		// Stop once we have both pieces
		if header.Timestamp != "" && firstUserText != "" {
			break
		}
	}

	if header.Timestamp == "" {
		return agentSessionInfo{}, "", fmt.Errorf("no session header found in %s", filePath)
	}

	t, _ := time.Parse(time.RFC3339Nano, header.Timestamp)
	tMs := t.UnixMilli()

	// Build a human title: first user message (truncated) or timestamp fallback
	title := firstUserText
	if title == "" {
		title = t.Format("2006-01-02 15:04")
	} else if len([]rune(title)) > 60 {
		runes := []rune(title)
		title = string(runes[:57]) + "..."
	}
	// Collapse newlines / tabs to spaces
	title = strings.Join(strings.Fields(title), " ")

	return agentSessionInfo{
		ID:          filePath,
		Title:       title,
		TimeCreated: tMs,
		TimeUpdated: tMs,
	}, header.Cwd, nil
}

func (s *Server) handleGetPiSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	groups, err := queryPiSessions()
	if err != nil {
		log.Printf("[WARN] Failed to query pi sessions: %v", err)
		respondJSON(w, map[string]interface{}{"agents": []agentGroup{}}, http.StatusOK)
		return
	}
	if groups == nil {
		groups = []agentGroup{}
	}
	respondJSON(w, map[string]interface{}{"agents": groups}, http.StatusOK)
}
