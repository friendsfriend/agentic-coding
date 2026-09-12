package actionexec

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type CommandSpec struct {
	Name        string
	Args        []string
	DisplayArgs []string
	Dir         string
	Env         []string
}
type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Err      error
}
type CommandRunner interface {
	Run(context.Context, CommandSpec, func(stream, chunk string)) CommandResult
}

type OSCommandRunner struct{}

func (OSCommandRunner) Run(ctx context.Context, spec CommandSpec, output func(string, string)) CommandResult {
	cmd := exec.CommandContext(ctx, spec.Name, spec.Args...)
	cmd.Dir = spec.Dir
	if len(spec.Env) > 0 {
		// Merge step-specific env vars on top of current process environment
		// so PATH and other inherited vars aren't lost.
		merged := append(os.Environ(), spec.Env...)
		cmd.Env = merged
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := CommandResult{Stdout: stdout.String(), Stderr: stderr.String(), Err: err}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	} else if err != nil {
		result.ExitCode = -1
	}
	if output != nil {
		if result.Stdout != "" {
			output("stdout", result.Stdout)
		}
		if result.Stderr != "" {
			output("stderr", result.Stderr)
		}
	}
	return result
}

type CommandEvent struct {
	Type     string
	StepID   actiondef.StepDefinitionID
	Command  string
	Args     []string
	Stream   string
	Chunk    string
	ExitCode int
	Error    string
}
type CommandEventSink interface{ EmitCommand(CommandEvent) }

type CommandHandler struct {
	Runner CommandRunner
	Events CommandEventSink
}

func (h CommandHandler) Supports(kind actiondef.StepKind) bool {
	return kind == actiondef.StepKindCommand
}
func (h CommandHandler) Execute(ctx actiondef.StepContext, definition actiondef.StepDefinition) actiondef.StepResult {
	step, ok := definition.(actiondef.Step)
	if !ok {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: fmt.Errorf("command step %s has unsupported descriptor", definition.ID())}
	}
	spec, err := commandSpec(step.Configuration)
	if err == nil {
		spec.Args, err = resolveValueTemplates(ctx, spec.Args)
		if err == nil {
			spec.Env, err = resolveValueTemplates(ctx, spec.Env)
		}
	}
	if err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	display := spec.DisplayArgs
	if display == nil {
		display = spec.Args
	}
	if h.Events != nil {
		h.Events.EmitCommand(CommandEvent{Type: "command.started", StepID: definition.ID(), Command: spec.Name, Args: append([]string(nil), display...)})
	}
	result := h.Runner.Run(ctx.Context(), spec, func(stream, chunk string) {
		if h.Events != nil {
			h.Events.EmitCommand(CommandEvent{Type: "command.output", StepID: definition.ID(), Stream: stream, Chunk: chunk})
		}
	})
	if h.Events != nil {
		event := CommandEvent{Type: "command.completed", StepID: definition.ID(), ExitCode: result.ExitCode}
		if result.Err != nil {
			event.Type = "command.failed"
			event.Error = result.Err.Error()
		}
		h.Events.EmitCommand(event)
	}
	if exports, ok := step.Configuration["endpointExports"].([]actiondef.EndpointValue); ok && result.Err == nil {
		for _, endpoint := range exports {
			if err := ctx.Set(actiondef.ValueKey("endpoint."+endpoint.Name), actiondef.Value{Type: actiondef.ValueTypeEndpoint, Visibility: actiondef.VisibilityPublic, Data: endpoint}); err != nil {
				result.Err = err
				break
			}
		}
	}
	if values, ok := step.Configuration["setValues"].(map[string]any); ok && result.Err == nil {
		for key, data := range values {
			if err := ctx.Set(actiondef.ValueKey(key), actiondef.Value{Type: "string", Visibility: actiondef.VisibilityInternal, Data: data}); err != nil {
				result.Err = err
				break
			}
		}
	}
	if label, ok := step.Configuration["captureJSONLabel"].(string); ok && label != "" && result.Err == nil {
		var labels map[string]string
		if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &labels); err != nil {
			result.Err = err
		} else if key, ok := step.Configuration["captureKey"].(string); ok {
			result.Err = ctx.Set(actiondef.ValueKey(key), actiondef.Value{Type: "path", Visibility: actiondef.VisibilityInternal, Data: labels[label]})
		}
	}
	if key, ok := step.Configuration["captureStdout"].(string); ok && key != "" && result.Err == nil {
		valueType, _ := step.Configuration["captureType"].(string)
		if valueType == "" {
			valueType = "string"
		}
		if err := ctx.Set(actiondef.ValueKey(key), actiondef.Value{Type: actiondef.ValueType(valueType), Visibility: actiondef.VisibilityInternal, Data: strings.TrimSpace(result.Stdout)}); err != nil {
			result.Err = err
		}
	}
	exit := result.ExitCode
	if result.Err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, ExitCode: &exit, Err: result.Err}
	}
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted, ExitCode: &exit}
}

func commandSpec(configuration map[string]any) (CommandSpec, error) {
	name, _ := configuration["command"].(string)
	if name == "" {
		return CommandSpec{}, fmt.Errorf("command is required")
	}
	spec := CommandSpec{Name: name}
	spec.Args = stringSlice(configuration["args"])
	spec.DisplayArgs = stringSlice(configuration["displayArgs"])
	spec.Dir, _ = configuration["dir"].(string)
	spec.Env = stringSlice(configuration["env"])
	return spec, nil
}
func resolveValueTemplates(ctx actiondef.StepContext, args []string) ([]string, error) {
	resolved := append([]string(nil), args...)
	for i, arg := range resolved {
		for {
			start := strings.Index(arg, "${")
			if start < 0 {
				break
			}
			end := strings.Index(arg[start+2:], "}")
			if end < 0 {
				return nil, fmt.Errorf("invalid value template %q", arg)
			}
			end += start + 2
			key := actiondef.ValueKey(arg[start+2 : end])
			value, err := ctx.Require(key)
			if err != nil {
				return nil, err
			}
			arg = arg[:start] + formatValue(value) + arg[end+1:]
		}
		resolved[i] = arg
	}
	return resolved, nil
}

func formatValue(value actiondef.Value) string {
	if value.Type == actiondef.ValueTypeEndpoint {
		if endpoint, ok := value.Data.(actiondef.EndpointValue); ok {
			return fmt.Sprintf("%s://%s:%d", endpoint.Protocol, endpoint.Host, endpoint.Port)
		}
		if endpoint, ok := value.Data.(map[string]any); ok {
			return fmt.Sprintf("%s://%v:%v", endpoint["protocol"], endpoint["host"], endpoint["port"])
		}
	}
	return fmt.Sprint(value.Data)
}

func stringSlice(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		out := make([]string, 0, len(values))
		for _, v := range values {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
