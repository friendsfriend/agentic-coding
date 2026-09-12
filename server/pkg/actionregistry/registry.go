package actionregistry

import (
	"context"
	"fmt"
	"sort"
	"sync/atomic"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type Snapshot struct {
	Version     uint64             `json:"version"`
	Definitions []actiondef.Action `json:"definitions"`
	Diagnostics []string           `json:"diagnostics,omitempty"`
	byID        map[actiondef.ActionID]actiondef.Action
}

func newSnapshot(version uint64, definitions []actiondef.Action) *Snapshot {
	copied := make([]actiondef.Action, len(definitions))
	byID := make(map[actiondef.ActionID]actiondef.Action, len(definitions))
	for i, definition := range definitions {
		copied[i] = actiondef.NewAction(definition)
		byID[copied[i].ActionID] = copied[i]
	}
	sort.Slice(copied, func(i, j int) bool { return copied[i].ActionID < copied[j].ActionID })
	return &Snapshot{Version: version, Definitions: copied, byID: byID}
}

func (s *Snapshot) Get(id actiondef.ActionID) (actiondef.Action, bool) {
	definition, ok := s.byID[id]
	return actiondef.NewAction(definition), ok
}

func (s *Snapshot) ForResource(owner actiondef.ResourceRef) []actiondef.Action {
	out := []actiondef.Action{}
	for _, definition := range s.Definitions {
		if definition.Resource == owner {
			out = append(out, actiondef.NewAction(definition))
		}
	}
	return out
}

type Provider interface {
	Name() string
	Compile(context.Context) ([]actiondef.Action, error)
}

type ProviderFunc struct {
	ProviderName string
	CompileFunc  func(context.Context) ([]actiondef.Action, error)
}

func (p ProviderFunc) Name() string { return p.ProviderName }
func (p ProviderFunc) Compile(ctx context.Context) ([]actiondef.Action, error) {
	return p.CompileFunc(ctx)
}

type Registry struct {
	current atomic.Pointer[Snapshot]
}

func New() *Registry {
	r := &Registry{}
	r.current.Store(newSnapshot(0, nil))
	return r
}

func (r *Registry) Snapshot() *Snapshot { return r.current.Load() }

// Rebuild compiles every provider before atomically publishing one complete snapshot.
func (r *Registry) Rebuild(ctx context.Context, providers []Provider, handlers actiondef.HandlerRegistry) (*Snapshot, error) {
	definitions := []actiondef.Action{}
	seen := map[actiondef.ActionID]string{}
	for _, provider := range providers {
		compiled, err := provider.Compile(ctx)
		if err != nil {
			return r.Snapshot(), fmt.Errorf("provider %s: %w", provider.Name(), err)
		}
		for _, definition := range compiled {
			if previous, ok := seen[definition.ActionID]; ok {
				return r.Snapshot(), fmt.Errorf("duplicate action id %s from providers %s and %s; resource=%s action=%s runtime=%s", definition.ActionID, previous, provider.Name(), definition.Resource, definition.ActionType, definition.ActionRuntime)
			}
			if err := actiondef.Validate(definition, handlers); err != nil {
				return r.Snapshot(), fmt.Errorf("provider %s action %s: %w", provider.Name(), definition.ActionID, err)
			}
			seen[definition.ActionID] = provider.Name()
			definitions = append(definitions, actiondef.NewAction(definition))
		}
	}
	next := newSnapshot(r.Snapshot().Version+1, definitions)
	r.current.Store(next)
	return next, nil
}
