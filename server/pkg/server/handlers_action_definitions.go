package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionexec"
	"github.com/friendsfriend/devenv/pkg/actionrun"
	"github.com/friendsfriend/devenv/pkg/resources"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"

	"github.com/google/uuid"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

func (s *Server) handleListActionDefinitions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	ident := r.PathValue("ident")
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "app"
	}
	if ident == "" {
		respondBadRequest(w, "ident path parameter required")
		return
	}
	if s.actionDefinitions == nil {
		respondJSON(w, map[string]any{"version": uint64(0), "actions": []actiondef.Action{}}, http.StatusOK)
		return
	}
	snapshot := s.actionDefinitions.Snapshot()
	definitions := snapshot.ForResource(actiondef.ResourceRef{Kind: kind, ID: ident})
	respondJSON(w, map[string]any{"version": snapshot.Version, "actions": definitions}, http.StatusOK)
}

type startActionRunRequest struct {
	ActionID actiondef.ActionID         `json:"actionId"`
	Inputs   map[string]json.RawMessage `json:"inputs"`
}

func (s *Server) handleStartActionRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	var request startActionRunRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		respondBadRequest(w, "invalid action run request")
		return
	}
	if s.actionDefinitions == nil {
		respondServiceUnavailable(w, "Action registry unavailable")
		return
	}
	definition, ok := s.actionDefinitions.Snapshot().Get(request.ActionID)
	if !ok {
		respondNotFound(w, "Action not found")
		return
	}
	if !definition.AvailabilityState.Available {
		respondErrorMessage(w, definition.AvailabilityState.Reason, http.StatusConflict)
		return
	}
	if err := s.dependencyStopBlocked(definition); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusConflict)
		return
	}
	if prepared, err := s.prepareInfrastructureDockerAction(definition); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusConflict)
		return
	} else {
		definition = prepared
	}
	allowed := map[string]bool{}
	for _, input := range definition.InputDefinitions {
		allowed[string(input.Key)] = true
		if input.Required {
			if _, ok := request.Inputs[string(input.Key)]; !ok && input.Default == nil {
				respondBadRequest(w, "missing required input: "+string(input.Key))
				return
			}
		}
	}
	for key := range request.Inputs {
		if !allowed[key] {
			respondBadRequest(w, "unknown input: "+key)
			return
		}
	}
	if definition.ActionRuntime == "git" || definition.ActionRuntime == "podman" || (definition.ActionRuntime == "docker" && (definition.Resource.Kind == "app" || definition.Resource.Kind == "infrastructure" || definition.Resource.Kind == "kubernetes")) || definition.ActionRuntime == "tmux" || definition.ActionRuntime == "shell" || strings.HasPrefix(string(definition.ActionRuntime), "command-") || definition.ActionRuntime == "systemshell" || definition.ActionRuntime == "powershell" || definition.ActionRuntime == "kubernetes" || definition.ActionRuntime == "kind" {
		runID, err := s.startEngineDefinition(definition, request.Inputs)
		if err != nil {
			respondErrorMessage(w, err.Error(), http.StatusConflict)
			return
		}
		respondJSON(w, map[string]any{"success": true, "actionId": definition.ActionID, "runId": runID, "registryVersion": s.actionDefinitions.Snapshot().Version}, http.StatusAccepted)
		return
	}
	if err := s.startCompatibilityAction(definition, request.Inputs); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusBadRequest)
		return
	}
	respondJSON(w, map[string]any{"success": true, "actionId": definition.ActionID, "registryVersion": s.actionDefinitions.Snapshot().Version}, http.StatusAccepted)
}

func (s *Server) prepareInfrastructureDockerAction(definition actiondef.Action) (actiondef.Action, error) {
	if definition.Resource.Kind != "infrastructure" || definition.ActionRuntime != "docker" {
		return definition, nil
	}
	service := s.findInfraServiceByIdent(definition.Resource.ID)
	if service == nil {
		return definition, fmt.Errorf("infrastructure %s not found", definition.Resource.ID)
	}
	composeFile, err := s.services.ResourcesManager().ResolveInfrastructureComposeFile(service.Ident)
	if err != nil {
		return definition, err
	}
	args := []string{"-p", "devenv"}
	if envFile, ok := s.services.ResourcesManager().EnvFilePath(); ok {
		args = append(args, "--env-file", envFile)
	}
	args = append(args, "-f", composeFile)
	if definition.ActionType == "start" {
		args = append(args, "up", "-d")
	} else if definition.ActionType == "stop" {
		args = append(args, "down", "--remove-orphans", "--volumes")
	} else {
		return definition, nil
	}
	children := make([]actiondef.Step, len(definition.RootStep.ChildSteps))
	copy(children, definition.RootStep.ChildSteps)
	for index, step := range children {
		if step.StepType != actiondef.StepKindOperation || !strings.HasPrefix(step.DisplayLabel, "Start ") && !strings.HasPrefix(step.DisplayLabel, "Terminate ") {
			continue
		}
		step.StepType = actiondef.StepKindCommand
		step.Handler = "docker"
		step.Configuration = map[string]any{"command": docker.ComposeCommand(), "args": append([]string(nil), args...)}
		children[index] = step
	}
	definition.RootStep.ChildSteps = children
	return definition, nil
}

type engineEventSink struct {
	projection actionexec.ActionRunProjection
	server     *Server
}

func (s engineEventSink) Emit(event actionexec.Event) {
	s.projection.Emit(event)
	props := map[string]any{"runId": string(event.RunID), "stepId": string(event.StepID), "label": event.Label, "outcome": event.Outcome}
	if event.Error != "" {
		props["error"] = event.Error
	}
	s.server.BroadcastEvent(Event{Type: "action." + event.Type, Properties: props, Timestamp: event.At})
}

type engineCommandSink struct {
	server *Server
	runID  string
}

func (s engineCommandSink) EmitCommand(event actionexec.CommandEvent) {
	props := map[string]any{"runId": s.runID, "stepId": string(event.StepID), "commandId": string(event.StepID) + "-command-0", "command": strings.TrimSpace(event.Command + " " + strings.Join(event.Args, " ")), "stream": event.Stream, "output": event.Chunk, "exitCode": event.ExitCode}
	if event.Error != "" {
		props["error"] = event.Error
	}
	s.server.BroadcastEvent(Event{Type: "action." + event.Type, Properties: props, Timestamp: time.Now()})
}

func (s *Server) startEngineDefinition(definition actiondef.Action, rawInputs map[string]json.RawMessage) (string, error) {
	runID := "action-" + uuid.NewString()
	now := time.Now()
	snapshot := actionrun.DefinitionSnapshot(definition)
	run := actionrun.Run{
		ID:                 runID,
		Title:              definition.DisplayLabel,
		AppIdent:           definition.Resource.ID,
		Action:             string(definition.ActionType),
		Profile:            string(definition.ActionRuntime),
		TargetLabel:        definition.DisplayLabel,
		Status:             actionrun.StatusActive,
		Steps:              []actionrun.Step{},
		StartedAt:          &now,
		RegistryVersion:    s.actionDefinitions.Snapshot().Version,
		DefinitionSnapshot: &snapshot,
	}
	s.actionRuns.Start(run, definition.Resource.ID, string(definition.ActionType), nil)
	s.BroadcastEvent(Event{Type: "action.started", Properties: map[string]any{"run": run}, Timestamp: time.Now()})
	inputs := map[actiondef.ValueKey]actiondef.Value{}
	for key, raw := range rawInputs {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", err
		}
		inputs[actiondef.ValueKey(key)] = actiondef.Value{Type: "string", Visibility: actiondef.VisibilityPublic, Data: value}
	}
	events := engineEventSink{projection: actionexec.ActionRunProjection{Registry: s.actionRuns}, server: s}
	commands := engineCommandSink{server: s, runID: runID}
	commandHandler := actionexec.CommandHandler{Runner: actionexec.OSCommandRunner{}, Events: commands}
	processHandler := actionexec.ProcessHandler{Store: s.actionProcesses, Events: commands}
	runtimeCmd := docker.RuntimeCommand()
	if string(definition.ActionRuntime) == "podman" {
		runtimeCmd = docker.RuntimeCommandForRuntime("podman")
	}
	readinessHandler := actionexec.ReadinessHandler{Factory: actionexec.StandardProbeFactory{Processes: s.actionProcesses, Compose: func(step actiondef.Step) actionexec.ReadinessProbe {
		command, _ := step.Configuration["command"].(string)
		args, _ := step.Configuration["args"].([]string)
		return actionexec.ComposeReadinessProbe{Runner: actionexec.OSCommandRunner{}, Name: command, Args: args, Interval: time.Second}
	}, Container: func(id string) actionexec.ReadinessProbe {
		return actionexec.ContainerHealthProbe{Runner: actionexec.OSCommandRunner{}, Runtime: runtimeCmd, Container: id}
	}, Kubernetes: func(step actiondef.Step) actionexec.ReadinessProbe {
		contextName, _ := step.Configuration["context"].(string)
		namespace, _ := step.Configuration["namespace"].(string)
		release, _ := step.Configuration["resource"].(string)
		timeout, _ := step.Configuration["timeout"].(string)
		if timeout == "" {
			timeout = "5m"
		}
		return actionexec.KubernetesPodReadinessProbe{Runner: actionexec.OSCommandRunner{}, Context: contextName, Namespace: namespace, Selector: "app.kubernetes.io/instance=" + release, Timeout: timeout}
	}}}
	operationHandler := actionexec.OperationHandler{Run: func(_ actiondef.StepContext, step actiondef.StepDefinition) actiondef.StepResult {
		return s.executeInfrastructureOperation(definition, step)
	}}
	engine := actionexec.Engine{Handlers: actionexec.HandlerRegistry{actiondef.StepKindCommand: commandHandler, actiondef.StepKindCleanup: commandHandler, actiondef.StepKindProcess: processHandler, actiondef.StepKindReadiness: readinessHandler, actiondef.StepKindOperation: operationHandler}, Events: events, Coordinator: s.actionCoordinator}
	runContext, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	s.actionCancelMu.Lock()
	s.actionCancels[runID] = cancel
	s.actionCancelMu.Unlock()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[ERROR] action %s panicked: %v", runID, r)
				s.finishAction(runID, actionrun.StatusFailed)
				s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]any{"runId": runID, "appIdent": definition.Resource.ID, "resourceKind": definition.Resource.Kind, "status": actionrun.StatusFailed, "error": fmt.Sprint(r)}, Timestamp: time.Now()})
			}
			s.actionCancelMu.Lock()
			delete(s.actionCancels, runID)
			s.actionCancelMu.Unlock()
		}()
		result := engine.Run(runContext, actiondef.RunID(runID), definition, inputs)
		status := actionrun.StatusCompleted
		if result.Err != nil {
			status = actionrun.StatusFailed
		}
		if runContext.Err() != nil {
			status = actionrun.Status("canceled")
		}
		s.finishAction(runID, status)
		if status == actionrun.StatusCompleted {
			s.recordCompletedRunTarget(definition)
			s.broadcastAppStatus(definition.Resource.ID)
			if definition.ActionType == "run" {
				s.leaseDependencies(definition, runID)
			}
			if definition.ActionType == "stop" {
				s.releaseLeasesForOwner(definition.Resource.ID)
			}
		}
		s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]any{"runId": runID, "appIdent": definition.Resource.ID, "resourceKind": definition.Resource.Kind, "status": status}, Timestamp: time.Now()})
	}()
	return runID, nil
}

func (s *Server) recordCompletedRunTarget(definition actiondef.Action) {
	if definition.Resource.Kind != "app" || string(definition.ActionType) != string(resources.AppActionRun) || s.services == nil || s.services.BuildService() == nil {
		return
	}
	targetApp := s.findAppByIdent(definition.Resource.ID)
	if targetApp == nil {
		return
	}
	targets, err := s.services.ResourcesManager().DiscoverActionTargets(definition.Resource.ID, targetApp.LocalDirectoryPath, resources.AppActionRun)
	if err != nil {
		return
	}
	parts := strings.Split(string(definition.ActionID), "/")
	profile := ""
	if len(parts) > 0 {
		profile = parts[len(parts)-1]
	}
	for _, target := range targets {
		targetProfile := target.Profile
		if targetProfile == "" {
			targetProfile = "default"
		}
		if targetProfile != profile {
			continue
		}
		if target.Runtime == resources.ActionRuntimeDocker && definition.ActionRuntime == "podman" {
			target.Provider = resources.ContainerProviderPodman
			target.ID = string(definition.ActionID)
		} else if string(target.Runtime) != string(definition.ActionRuntime) {
			continue
		}
		s.services.BuildService().SetRunTargetInfo(definition.Resource.ID, target)
		s.services.BuildService().SetLastRunRuntime(definition.Resource.ID, target.Runtime)
		return
	}
}

func (s *Server) executeInfrastructureOperation(definition actiondef.Action, step actiondef.StepDefinition) actiondef.StepResult {
	if definition.Resource.Kind != "infrastructure" || definition.ActionType != "stop" {
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}
	if strings.HasPrefix(step.Label(), "Verify") {
		if _, ok := s.actionProcesses.Get(definition.Resource.ID); ok {
			return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: fmt.Errorf("process still running")}
		}
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}
	handle, ok := s.actionProcesses.Get(definition.Resource.ID)
	if !ok {
		return actiondef.StepResult{Outcome: actiondef.OutcomeAlreadyRunning}
	}
	process, err := os.FindProcess(handle.PID)
	if err == nil {
		err = process.Kill()
	}
	if err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	s.actionProcesses.Delete(definition.Resource.ID)
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
}

func (s *Server) startCompatibilityAction(definition actiondef.Action, inputs map[string]json.RawMessage) error {
	switch definition.Resource.Kind {
	case "app":
		target := s.findAppByIdent(definition.Resource.ID)
		if target == nil {
			return fmt.Errorf("app %s not found", definition.Resource.ID)
		}
		targetID := definitionTargetID(definition)
		switch definition.ActionType {
		case "build":
			s.services.BuildService().BuildAppTargetWithStatus(target, targetID)
		case "test":
			s.services.BuildService().TestAppTargetWithStatus(target, targetID)
		case "run":
			s.services.BuildService().RunAppTargetWithStatus(target, targetID)
		default:
			return fmt.Errorf("action %s is not migrated to compatibility execution", definition.ActionType)
		}
		return nil
	case "infrastructure":
		service := s.findInfraServiceByIdent(definition.Resource.ID)
		if service == nil {
			return fmt.Errorf("infrastructure %s not found", definition.Resource.ID)
		}
		operations := s.services.OperationsService()
		if definition.ActionType == "stop" {
			if service.Type == app.InfraServiceTypeKubernetes {
				return operations.StopKubernetesInfrastructureServiceWithStatus(*service)
			}
			if service.Type == app.InfraServiceTypeScript {
				return operations.StopScriptInfrastructureServiceWithStatus(service.Ident)
			}
			operations.StopInfrastructureServiceWithStatus(*service)
			return nil
		}
		runner := string(definition.ActionRuntime)
		if raw := inputs["runner"]; len(raw) > 0 {
			_ = json.Unmarshal(raw, &runner)
		}
		switch service.Type {
		case app.InfraServiceTypeKubernetes:
			return operations.StartKubernetesInfrastructureServiceWithStatus(*service)
		case app.InfraServiceTypeScript:
			return operations.StartScriptInfrastructureServiceWithStatus(*service, runner)
		default:
			operations.StartInfrastructureServiceWithStatus(*service)
			return nil
		}
	default:
		return fmt.Errorf("resource kind %s is not executable", definition.Resource.Kind)
	}
}

func definitionTargetID(definition actiondef.Action) string {
	for _, child := range definition.RootStep.ChildSteps {
		if value, ok := child.Configuration["targetId"].(string); ok {
			return value
		}
	}
	return ""
}

func (s *Server) handleActionRegistryStatus(w http.ResponseWriter, r *http.Request) {
	snapshot := s.actionDefinitions.Snapshot()
	var errorStr string
	if s.actionRegistryError != nil {
		errorStr = s.actionRegistryError.Error()
	}
	respondJSON(w, map[string]interface{}{
		"version":      snapshot.Version,
		"actionsCount": len(snapshot.Definitions),
		"error":        errorStr,
		"available":    s.actionRegistryError == nil && snapshot.Version > 0,
	}, http.StatusOK)
}

func (s *Server) handleGetActionDefinition(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	id := actiondef.ActionID(r.URL.Query().Get("id"))
	if id == "" {
		respondBadRequest(w, "id query parameter required")
		return
	}
	if s.actionDefinitions == nil {
		respondNotFound(w, "Action not found")
		return
	}
	definition, ok := s.actionDefinitions.Snapshot().Get(id)
	if !ok {
		respondNotFound(w, "Action not found")
		return
	}
	respondJSON(w, definition, http.StatusOK)
}
