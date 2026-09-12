package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type ScriptNode struct {
	Name         string                      `json:"name"`
	RelativePath string                      `json:"relativePath"`
	AbsolutePath string                      `json:"absolutePath"`
	NodeType     string                      `json:"nodeType"` // folder | script
	Interpreter  string                      `json:"interpreter,omitempty"`
	Parameters   []resources.ScriptParameter `json:"parameters,omitempty"`
	Children     []ScriptNode                `json:"children,omitempty"`
}

type executeScriptRequest struct {
	RelativePath string   `json:"relativePath"`
	Args         []string `json:"args,omitempty"`
}

type executeScriptResponse struct {
	Success      bool   `json:"success"`
	RelativePath string `json:"relativePath"`
	Interpreter  string `json:"interpreter"`
	Output       string `json:"output,omitempty"`
}

type scriptArgsHistoryRequest struct {
	RelativePath string            `json:"relativePath"`
	Values       map[string]string `json:"values"`
}

type scriptArgsHistoryResponse struct {
	RelativePath string              `json:"relativePath"`
	Entries      []map[string]string `json:"entries"`
}

type createScriptRequest struct {
	TargetPath string `json:"targetPath"`
}

type linkScriptRequest struct {
	TargetPath string `json:"targetPath"`
	SourcePath string `json:"sourcePath"`
}

type deleteScriptRequest struct {
	RelativePath string `json:"relativePath"`
}

type scriptMutationResponse struct {
	Success      bool   `json:"success"`
	Operation    string `json:"operation"`
	RelativePath string `json:"relativePath"`
	AbsolutePath string `json:"absolutePath"`
}

func (s *Server) handleScripts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListScripts(w, r)
	case http.MethodPost:
		s.handleExecuteScript(w, r)
	default:
		respondMethodNotAllowed(w)
	}
}

func (s *Server) handleScriptArgsHistory(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetScriptArgsHistory(w, r)
	case http.MethodPost:
		s.handleAddScriptArgsHistory(w, r)
	default:
		respondMethodNotAllowed(w)
	}
}

func (s *Server) handleCreateScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	var req createScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}

	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	rel, abs, err := resources.CreateScriptFile(scriptsDir, req.TargetPath, defaultNewScriptTemplate)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	respondJSON(w, scriptMutationResponse{
		Success:      true,
		Operation:    "create",
		RelativePath: rel,
		AbsolutePath: abs,
	}, http.StatusOK)
}

func (s *Server) handleLinkScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	var req linkScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}

	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	rel, abs, err := resources.LinkScriptFile(scriptsDir, req.TargetPath, req.SourcePath)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	respondJSON(w, scriptMutationResponse{
		Success:      true,
		Operation:    "link",
		RelativePath: rel,
		AbsolutePath: abs,
	}, http.StatusOK)
}

func (s *Server) handleDeleteScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	var req deleteScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}

	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	rel, abs, err := resources.DeleteScriptTarget(scriptsDir, req.RelativePath)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	respondJSON(w, scriptMutationResponse{
		Success:      true,
		Operation:    "delete",
		RelativePath: rel,
		AbsolutePath: abs,
	}, http.StatusOK)
}

func (s *Server) handleListScripts(w http.ResponseWriter, r *http.Request) {
	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	scripts, err := resources.DiscoverScripts(scriptsDir)
	if err != nil {
		respondInternalError(w, err)
		return
	}

	// Extract metadata concurrently with a bounded worker pool (10 workers).
	// This avoids O(N) sequential fork+exec overhead for large script collections.
	const maxWorkers = 10
	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup

	for i := range scripts {
		wg.Add(1)
		go func(idx int, path string) {
			sem <- struct{}{}        // acquire
			defer func() { <-sem }() // release
			defer wg.Done()
			scripts[idx].Parameters = s.fetchScriptMetadata(path)
		}(i, scripts[i].AbsolutePath)
	}

	wg.Wait()

	respondJSON(w, map[string]interface{}{
		"scripts": buildScriptTree(scripts),
	}, http.StatusOK)
}

// Script metadata cache
type scriptMetadataEntry struct {
	Parameters []resources.ScriptParameter `json:"parameters"`
	FileMtime  time.Time
}

var (
	metadataCache   = map[string]*scriptMetadataEntry{}
	metadataCacheMu sync.RWMutex
)

func (s *Server) handleScriptMetadata(w http.ResponseWriter, r *http.Request) {
	relativePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if relativePath == "" {
		respondBadRequest(w, "path query parameter is required")
		return
	}

	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	absPath := filepath.Join(scriptsDir, filepath.FromSlash(relativePath))

	absPath, err := filepath.Abs(absPath)
	if err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid path: %v", err))
		return
	}

	fi, err := os.Stat(absPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			respondNotFound(w, "Script not found")
			return
		}
		respondInternalError(w, err)
		return
	}
	if fi.IsDir() {
		respondBadRequest(w, "path must be a file, not a directory")
		return
	}

	// Check cache
	cacheKey := sha256Hex(absPath)
	metadataCacheMu.RLock()
	cached, ok := metadataCache[cacheKey]
	metadataCacheMu.RUnlock()
	if ok && !cached.FileMtime.Before(fi.ModTime()) {
		respondJSON(w, map[string]interface{}{
			"parameters": cached.Parameters,
		}, http.StatusOK)
		return
	}

	// Cache miss or stale: run --devenv-metadata
	params := s.fetchScriptMetadata(absPath)

	metadataCacheMu.Lock()
	metadataCache[cacheKey] = &scriptMetadataEntry{
		Parameters: params,
		FileMtime:  fi.ModTime(),
	}
	metadataCacheMu.Unlock()

	respondJSON(w, map[string]interface{}{
		"parameters": params,
	}, http.StatusOK)
}

func (s *Server) fetchScriptMetadata(scriptPath string) []resources.ScriptParameter {
	// Check cache first using file mtime
	cacheKey := sha256Hex(scriptPath)
	fi, err := os.Stat(scriptPath)
	if err == nil {
		metadataCacheMu.RLock()
		cached, ok := metadataCache[cacheKey]
		metadataCacheMu.RUnlock()
		if ok && !cached.FileMtime.Before(fi.ModTime()) {
			return cached.Parameters
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, scriptPath, "--devenv-metadata")
	configureMetadataCommand(cmd)
	output, execErr := cmd.Output()
	if execErr != nil {
		killMetadataProcess(cmd)
	}

	params := parseMetadataOutput(output)

	// Update cache
	if err == nil {
		metadataCacheMu.Lock()
		metadataCache[cacheKey] = &scriptMetadataEntry{
			Parameters: params,
			FileMtime:  fi.ModTime(),
		}
		metadataCacheMu.Unlock()
	}

	return params
}

func parseMetadataOutput(output []byte) []resources.ScriptParameter {
	if len(output) == 0 {
		return []resources.ScriptParameter{}
	}

	var params []resources.ScriptParameter
	if err := json.Unmarshal(output, &params); err == nil {
		if params == nil {
			params = []resources.ScriptParameter{}
		}
		return params
	}

	var wrapped struct {
		Parameters []resources.ScriptParameter `json:"parameters"`
	}
	if err := json.Unmarshal(output, &wrapped); err == nil && wrapped.Parameters != nil {
		return wrapped.Parameters
	}

	var single resources.ScriptParameter
	if err := json.Unmarshal(output, &single); err == nil {
		return []resources.ScriptParameter{single}
	}

	return []resources.ScriptParameter{}
}

func (s *Server) handleScriptMetadataRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.handleScriptMetadata(w, r)
		return
	}
	respondMethodNotAllowed(w)
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h)
}

func (s *Server) handleGetScriptArgsHistory(w http.ResponseWriter, r *http.Request) {
	relativePath := strings.TrimSpace(r.URL.Query().Get("relativePath"))
	if relativePath == "" {
		respondBadRequest(w, "relativePath is required")
		return
	}

	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			respondBadRequest(w, "limit must be a positive integer")
			return
		}
		if parsed > 200 {
			parsed = 200
		}
		limit = parsed
	}

	entries, err := s.services.StateStore().GetScriptArgsHistory(relativePath, limit)
	if err != nil {
		respondInternalError(w, err)
		return
	}

	respondJSON(w, scriptArgsHistoryResponse{
		RelativePath: relativePath,
		Entries:      entries,
	}, http.StatusOK)
}

func (s *Server) handleAddScriptArgsHistory(w http.ResponseWriter, r *http.Request) {
	var req scriptArgsHistoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}
	if strings.TrimSpace(req.RelativePath) == "" {
		respondBadRequest(w, "relativePath is required")
		return
	}
	if req.Values == nil {
		req.Values = map[string]string{}
	}

	if err := s.services.StateStore().AddScriptArgsHistory(req.RelativePath, req.Values, 50); err != nil {
		respondInternalError(w, err)
		return
	}

	respondJSON(w, map[string]bool{"success": true}, http.StatusOK)
}

func (s *Server) handleExecuteScript(w http.ResponseWriter, r *http.Request) {
	var req executeScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}
	if strings.TrimSpace(req.RelativePath) == "" {
		respondBadRequest(w, "relativePath is required")
		return
	}

	scriptsDir := resources.ScriptsDir(s.services.HomeDir())
	scripts, err := resources.DiscoverScripts(scriptsDir)
	if err != nil {
		respondInternalError(w, err)
		return
	}

	scriptFile, ok := findScriptByRelativePath(scripts, req.RelativePath)
	if !ok {
		respondNotFound(w, "Script not found")
		return
	}

	plan, err := resolveScriptExecutionPlan(scriptFile, req.Args, runtime.GOOS, exec.LookPath)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	opIdent := "script:" + scriptFile.RelativePath
	command := strings.Join(append([]string{plan.Command}, plan.Args...), " ")
	runErr, output := s.runScriptAction(opIdent, "Run task "+scriptFile.RelativePath, command, func() (error, string, string) {
		return s.services.Executor().RunCommandDetailed(opIdent, plan.Command, plan.Args, []string{}, plan.WorkingDir)
	})
	if runErr != nil {
		respondJSON(w, executeScriptResponse{
			Success:      false,
			RelativePath: scriptFile.RelativePath,
			Interpreter:  plan.Command,
			Output:       output,
		}, http.StatusOK)
		return
	}

	respondJSON(w, executeScriptResponse{
		Success:      true,
		RelativePath: scriptFile.RelativePath,
		Interpreter:  plan.Command,
		Output:       output,
	}, http.StatusOK)
}

const defaultNewScriptTemplate = `#!/usr/bin/env bash
# DevEnv metadata: run './script --devenv-metadata' to see the parameter schema.
# Example: uncomment and customize the lines below to declare parameters.
# # --- devenv-metadata ---
# echo '{"parameters":['
# echo '  {"name":"environment","type":"enum","required":true,"choices":["dev","test","prod"],"desc":"Target environment","flag":"--env"},'
# echo '  {"name":"dry-run","type":"bool","required":false,"desc":"Run without applying changes","flag":"--dry-run"}'
# echo ']}'
# exit 0
# # --- end metadata ---

set -euo pipefail

echo "Hello from your new DevEnv script"
`

type scriptExecutionPlan struct {
	Command    string
	Args       []string
	WorkingDir string
}

func resolveScriptExecutionPlan(script resources.ScriptFile, extraArgs []string, goos string, lookPath func(string) (string, error)) (scriptExecutionPlan, error) {
	workingDir := script.Directory
	if workingDir == "" {
		workingDir = filepath.Dir(script.AbsolutePath)
	}

	if goos == "windows" {
		cmd, args, err := resources.ResolveInterpreter(script.AbsolutePath)
		if err != nil {
			return scriptExecutionPlan{}, err
		}
		// Verify the interpreter is available
		if _, err := lookPath(cmd); err != nil {
			return scriptExecutionPlan{}, fmt.Errorf("interpreter %q not available: %w", cmd, err)
		}
		args = append(args, extraArgs...)
		return scriptExecutionPlan{Command: cmd, Args: args, WorkingDir: workingDir}, nil
	}

	// Unix: direct execution via shebang
	return scriptExecutionPlan{Command: script.AbsolutePath, Args: extraArgs, WorkingDir: workingDir}, nil
}

func findScriptByRelativePath(scripts []resources.ScriptFile, relativePath string) (resources.ScriptFile, bool) {
	normalized := filepath.ToSlash(strings.TrimPrefix(relativePath, "/"))
	for _, script := range scripts {
		if script.RelativePath == normalized {
			return script, true
		}
	}
	return resources.ScriptFile{}, false
}

type mutableScriptNode struct {
	name         string
	relativePath string
	absolutePath string
	nodeType     string
	interpreter  string
	parameters   []resources.ScriptParameter
	folders      map[string]*mutableScriptNode
	scripts      []*mutableScriptNode
}

func buildScriptTree(scripts []resources.ScriptFile) []ScriptNode {
	root := &mutableScriptNode{folders: map[string]*mutableScriptNode{}, scripts: []*mutableScriptNode{}}

	for _, script := range scripts {
		parts := strings.Split(script.RelativePath, "/")
		cursor := root
		prefix := ""
		scriptRoot := strings.TrimSuffix(script.AbsolutePath, filepath.FromSlash(script.RelativePath))
		for i, part := range parts {
			if i == len(parts)-1 {
				cursor.scripts = append(cursor.scripts, &mutableScriptNode{
					name:         script.Name,
					relativePath: script.RelativePath,
					absolutePath: script.AbsolutePath,
					nodeType:     "script",
					interpreter:  script.Interpreter,
					parameters:   script.Parameters,
				})
				break
			}
			if prefix == "" {
				prefix = part
			} else {
				prefix = prefix + "/" + part
			}
			child, ok := cursor.folders[part]
			if !ok {
				child = &mutableScriptNode{
					name:         part,
					relativePath: prefix,
					absolutePath: filepath.Join(scriptRoot, filepath.FromSlash(prefix)),
					nodeType:     "folder",
					folders:      map[string]*mutableScriptNode{},
					scripts:      []*mutableScriptNode{},
				}
				cursor.folders[part] = child
			}
			cursor = child
		}
	}

	return toScriptNodes(root)
}

func toScriptNodes(root *mutableScriptNode) []ScriptNode {
	out := make([]ScriptNode, 0, len(root.folders)+len(root.scripts))
	folderNames := make([]string, 0, len(root.folders))
	for name := range root.folders {
		folderNames = append(folderNames, name)
	}
	sort.Strings(folderNames)

	for _, name := range folderNames {
		folder := root.folders[name]
		out = append(out, ScriptNode{
			Name:         folder.name,
			RelativePath: folder.relativePath,
			AbsolutePath: folder.absolutePath,
			NodeType:     "folder",
			Children:     toScriptNodes(folder),
		})
	}

	sort.Slice(root.scripts, func(i, j int) bool {
		return root.scripts[i].relativePath < root.scripts[j].relativePath
	})
	for _, script := range root.scripts {
		out = append(out, ScriptNode{
			Name:         script.name,
			RelativePath: script.relativePath,
			AbsolutePath: script.absolutePath,
			NodeType:     "script",
			Interpreter:  script.interpreter,
			Parameters:   script.parameters,
		})
	}

	return out
}
