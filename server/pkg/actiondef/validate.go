package actiondef

import (
	"fmt"
	"strings"
)

type HandlerRegistry interface{ Has(StepKind) bool }

type HandlerSet map[StepKind]StepHandler

func (h HandlerSet) Has(kind StepKind) bool { _, ok := h[kind]; return ok }

// Validate rejects definitions that cannot execute deterministically.
func Validate(action ActionDefinition, handlers HandlerRegistry) error {
	if action.ID() == "" {
		return fmt.Errorf("action id is required")
	}
	if action.Owner().ID == "" {
		return fmt.Errorf("action %s: owner id is required", action.ID())
	}
	root := action.Root()
	if root == nil {
		return fmt.Errorf("action %s: root step is required", action.ID())
	}

	available := map[ValueKey]PortDefinition{}
	for _, input := range action.Inputs() {
		if input.Key == "" || input.Type == "" {
			return fmt.Errorf("action %s: input key and type are required", action.ID())
		}
		if _, exists := available[input.Key]; exists {
			return fmt.Errorf("action %s: duplicate input %s", action.ID(), input.Key)
		}
		available[input.Key] = input.PortDefinition
	}
	ids := map[StepDefinitionID]bool{}
	visiting := map[StepDefinitionID]bool{}
	var walk func(StepDefinition) error
	walk = func(step StepDefinition) error {
		if step.ID() == "" {
			return fmt.Errorf("action %s: step id is required", action.ID())
		}
		if visiting[step.ID()] {
			return fmt.Errorf("action %s: cycle at step %s", action.ID(), step.ID())
		}
		if ids[step.ID()] {
			return fmt.Errorf("action %s: duplicate step id %s", action.ID(), step.ID())
		}
		ids[step.ID()], visiting[step.ID()] = true, true
		defer delete(visiting, step.ID())
		if step.Kind() == "" {
			return fmt.Errorf("step %s: kind is required", step.ID())
		}
		if step.Kind() != StepKindComposite && handlers != nil && !handlers.Has(step.Kind()) {
			return fmt.Errorf("step %s: no handler for kind %s", step.ID(), step.Kind())
		}
		for _, in := range step.Consumes() {
			producer, ok := available[in.Key]
			if !ok && in.Required {
				return fmt.Errorf("step %s: missing producer for %s", step.ID(), in.Key)
			}
			if ok && producer.Type != in.Type {
				return fmt.Errorf("step %s: value %s type %s does not match %s", step.ID(), in.Key, producer.Type, in.Type)
			}
		}
		for _, out := range step.Produces() {
			if previous, ok := available[out.Key]; ok && out.Scope != ScopeStep {
				return fmt.Errorf("step %s: duplicate output %s previously %s", step.ID(), out.Key, previous.Type)
			}
			if previous, ok := available[out.Key]; ok && previous.Visibility == VisibilitySecret && out.Visibility == VisibilityPublic {
				return fmt.Errorf("step %s: secret value %s cannot become public", step.ID(), out.Key)
			}
			available[out.Key] = out
		}
		for _, child := range step.Children() {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return err
	}
	return nil
}

func StableID(parts ...string) string {
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), "/")
		if part != "" {
			clean = append(clean, part)
		}
	}
	return strings.Join(clean, "/")
}
