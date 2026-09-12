package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/friendsfriend/devenv/pkg/resources"
)

const (
	TypeGitHub = "github"
	TypeGitLab = "gitlab"
)

// Provider represents a named git provider configuration.
type Provider struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Username    string   `json:"username"`
	Token       string   `json:"token"`
	MissingVars []string `json:"missing_vars,omitempty"`
}

// HasCredentials returns true when both username and token are non-empty.
func (p Provider) HasCredentials() bool {
	return p.Username != "" && p.Token != ""
}

// Store provides access to provider credentials.
type Store interface {
	Dir() string
	Load() error
	Get(name string) (Provider, bool)
	List() []Provider
	InvalidProviders() []InvalidProvider
	Save(p Provider) error
	Delete(name string) error
	CredentialsFor(name string) (username, token string)
}

type InvalidProvider struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	File    string `json:"file"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type store struct {
	dir         string
	envFilePath string
	mu          sync.RWMutex
	providers   map[string]Provider
	invalid     map[string]InvalidProvider
}

func NewStore(dir string, envFilePath string) Store {
	return &store{
		dir:         dir,
		envFilePath: envFilePath,
		providers:   make(map[string]Provider),
		invalid:     make(map[string]InvalidProvider),
	}
}

func (s *store) Dir() string {
	return s.dir
}

func (s *store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return fmt.Errorf("failed to create providers directory %s: %w", s.dir, err)
	}

	var envVars map[string]string
	if s.envFilePath != "" {
		loaded, err := resources.LoadEnvFile(s.envFilePath)
		if err == nil {
			envVars = loaded
		}
	}

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return fmt.Errorf("failed to read providers directory %s: %w", s.dir, err)
	}

	s.providers = make(map[string]Provider)
	s.invalid = make(map[string]InvalidProvider)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		if err != nil {
			return fmt.Errorf("failed to read provider file %s: %w", entry.Name(), err)
		}

		var raw Provider
		if err := json.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("failed to parse provider file %s: %w", entry.Name(), err)
		}
		if err := validateProviderFileCredentials(entry.Name(), raw); err != nil {
			name := raw.Name
			if name == "" {
				name = strings.TrimSuffix(entry.Name(), ".json")
			}
			s.invalid[name] = InvalidProvider{
				Name:    name,
				Type:    raw.Type,
				File:    entry.Name(),
				Reason:  "clear-text-credentials",
				Message: err.Error(),
			}
			continue
		}

		var missingVars []string
		if envVars != nil {
			substituted, missing := resources.SubstituteVarsWithWarnings(string(data), envVars)
			data = []byte(substituted)
			missingVars = missing
		}

		var p Provider
		if err := json.Unmarshal(data, &p); err != nil {
			return fmt.Errorf("failed to parse provider file %s: %w", entry.Name(), err)
		}

		if isEnvPlaceholder(p.Username) {
			p.Username = ""
		}
		if isEnvPlaceholder(p.Token) {
			p.Token = ""
		}

		if p.Name == "" {
			p.Name = strings.TrimSuffix(entry.Name(), ".json")
		}

		p.MissingVars = missingVars

		s.providers[p.Name] = p
	}

	return nil
}

// Get returns a provider by name.
func (s *store) Get(name string) (Provider, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.providers[name]
	return p, ok
}

// List returns all providers sorted by name.
func (s *store) List() []Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]Provider, 0, len(s.providers))
	for _, p := range s.providers {
		result = append(result, p)
	}
	return result
}

func (s *store) InvalidProviders() []InvalidProvider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]InvalidProvider, 0, len(s.invalid))
	for _, p := range s.invalid {
		result = append(result, p)
	}
	return result
}

// Save persists a provider to disk and updates the in-memory cache.
// If a provider with the same name already exists, it is overwritten.
func (s *store) Save(p Provider) error {
	if err := validateProvider(p); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for name := range s.providers {
		if name != p.Name && sanitizeProviderEnvName(name) == sanitizeProviderEnvName(p.Name) {
			return fmt.Errorf("provider name %q collides with existing provider %q for env credential keys", p.Name, name)
		}
	}

	if p.Token == "" {
		if existing, ok := s.providers[p.Name]; ok {
			p.Token = existing.Token
		}
	}

	s.providers[p.Name] = p
	delete(s.invalid, p.Name)
	return s.saveProviderLocked(p)
}

// Delete removes a provider by name from disk and the in-memory cache.
func (s *store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	fileName := name + ".json"
	if _, exists := s.providers[name]; !exists {
		invalidProvider, invalid := s.invalid[name]
		if !invalid {
			return fmt.Errorf("provider %q not found", name)
		}
		if invalidProvider.File != "" {
			fileName = invalidProvider.File
		}
	}

	filePath := filepath.Join(s.dir, fileName)
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete provider file %s: %w", filePath, err)
	}

	if s.envFilePath != "" {
		if err := resources.RemoveEnvFileKeys(s.envFilePath, providerCredentialEnvKeys(name)); err != nil {
			return fmt.Errorf("failed to remove provider credential env entries: %w", err)
		}
	}

	delete(s.providers, name)
	delete(s.invalid, name)
	return nil
}

// CredentialsFor looks up the provider by name and returns its credentials.
// Returns empty strings if the provider is not found.
func (s *store) CredentialsFor(name string) (username, token string) {
	p, ok := s.Get(name)
	if !ok {
		return "", ""
	}
	return p.Username, p.Token
}

// saveProviderLocked writes a single provider to disk.
// Caller must hold s.mu.
func (s *store) saveProviderLocked(p Provider) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return fmt.Errorf("failed to create providers directory: %w", err)
	}

	toWrite := p
	if s.envFilePath != "" {
		keys := providerCredentialEnvKeys(p.Name)
		if err := resources.UpsertEnvFile(s.envFilePath, map[string]string{
			keys[0]: p.Username,
			keys[1]: p.Token,
		}); err != nil {
			return fmt.Errorf("failed to write provider credentials to env file: %w", err)
		}
		toWrite.Username = "${" + keys[0] + "}"
		toWrite.Token = "${" + keys[1] + "}"
	}

	data, err := json.MarshalIndent(toWrite, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal provider %s: %w", p.Name, err)
	}

	filePath := filepath.Join(s.dir, p.Name+".json")
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write provider file %s: %w", filePath, err)
	}

	return nil
}

// validateProvider checks that a provider has valid required fields.
func providerCredentialEnvKeys(name string) []string {
	base := "DEVENV_PROVIDER_" + sanitizeProviderEnvName(name)
	return []string{base + "_USERNAME", base + "_TOKEN"}
}

func sanitizeProviderEnvName(name string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range strings.ToUpper(name) {
		valid := (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if valid {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}

func validateProviderFileCredentials(fileName string, p Provider) error {
	if p.Username != "" && !isEnvPlaceholder(p.Username) {
		return fmt.Errorf("provider file %s contains clear-text username; move credentials to .env and use ${...} placeholders", fileName)
	}
	if p.Token != "" && !isEnvPlaceholder(p.Token) {
		return fmt.Errorf("provider file %s contains clear-text token; move credentials to .env and use ${...} placeholders", fileName)
	}
	return nil
}

func isEnvPlaceholder(value string) bool {
	return strings.HasPrefix(value, "${") && strings.HasSuffix(value, "}") && len(value) > 3
}

func validateProvider(p Provider) error {
	if p.Name == "" {
		return fmt.Errorf("provider name is required")
	}
	if p.Type != TypeGitHub && p.Type != TypeGitLab {
		return fmt.Errorf("provider type must be %q or %q, got %q", TypeGitHub, TypeGitLab, p.Type)
	}
	// Name must be filesystem-safe (no slashes, etc.)
	if strings.ContainsAny(p.Name, `/\:*?"<>|`) {
		return fmt.Errorf("provider name contains invalid characters")
	}
	if sanitizeProviderEnvName(p.Name) == "" {
		return fmt.Errorf("provider name must contain a letter or number")
	}
	return nil
}
