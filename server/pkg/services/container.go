package services

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/build"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/git"
	"github.com/friendsfriend/devenv/pkg/logging"
	"github.com/friendsfriend/devenv/pkg/operations"
	"github.com/friendsfriend/devenv/pkg/provider"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/state"
	"github.com/friendsfriend/devenv/pkg/status"
)

func resolveConfigDir() string {
	return resources.ResolveConfigDir()
}

// multiAuthProvider implements git.AuthProvider and git.MultiAuthProvider,
// routing credentials via the provider store and app manager.
type multiAuthProvider struct {
	providers  provider.Store
	appManager app.Manager
}

func (m *multiAuthProvider) GetUsername() string {
	for _, p := range m.providers.List() {
		if p.Type == provider.TypeGitLab && p.HasCredentials() {
			return p.Username
		}
	}
	return ""
}

func (m *multiAuthProvider) GetToken() string {
	for _, p := range m.providers.List() {
		if p.Type == provider.TypeGitLab && p.HasCredentials() {
			return p.Token
		}
	}
	return ""
}

func (m *multiAuthProvider) CredentialsFor(repoURL string) (username, token string) {
	if m.appManager != nil {
		for _, a := range m.appManager.GetApps() {
			if a.RepositoryPath == repoURL {
				providerName := a.GetProviderName()
				if providerName != "" {
					return m.providers.CredentialsFor(providerName)
				}
			}
		}
	}

	for _, p := range m.providers.List() {
		if p.Type == provider.TypeGitHub && contains(repoURL, "github.com") && p.HasCredentials() {
			return p.Username, p.Token
		}
		if p.Type == provider.TypeGitLab && !contains(repoURL, "github.com") && p.HasCredentials() {
			return p.Username, p.Token
		}
	}

	return "", ""
}

func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// Container provides access to all service instances in the dependency injection container.
type Container interface {
	Logger() logging.Logger
	HomeDir() string
	ProviderStore() provider.Store
	DockerClient() docker.Client
	GitRepository() git.Repository
	StatusManager() status.Manager
	ResourcesManager() resources.Manager
	AppManager() app.Manager
	StateStore() state.Store
	Executor() *operations.Executor
	BuildService() build.Service
	OperationsService() operations.Service
}

type container struct {
	logger            logging.Logger
	homeDir           string
	providerStore     provider.Store
	dockerClient      docker.Client
	gitRepository     git.Repository
	statusManager     status.Manager
	resourcesManager  resources.Manager
	appManager        app.Manager
	stateStore        state.Store
	executor          *operations.Executor
	buildService      build.Service
	operationsService operations.Service
}

func (c *container) Logger() logging.Logger                { return c.logger }
func (c *container) HomeDir() string                       { return c.homeDir }
func (c *container) ProviderStore() provider.Store         { return c.providerStore }
func (c *container) DockerClient() docker.Client           { return c.dockerClient }
func (c *container) GitRepository() git.Repository         { return c.gitRepository }
func (c *container) StatusManager() status.Manager         { return c.statusManager }
func (c *container) ResourcesManager() resources.Manager   { return c.resourcesManager }
func (c *container) AppManager() app.Manager               { return c.appManager }
func (c *container) StateStore() state.Store               { return c.stateStore }
func (c *container) Executor() *operations.Executor        { return c.executor }
func (c *container) BuildService() build.Service           { return c.buildService }
func (c *container) OperationsService() operations.Service { return c.operationsService }

func NewContainer() (Container, error) {
	configDir := resolveConfigDir()
	homeDir, err := resources.ResolveHomeDir(configDir)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve home directory: %w", err)
	}
	if err := os.MkdirAll(homeDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create home directory: %w", err)
	}

	// Open the SQLite state database at $DEVENV_HOME/db/state.db.
	// Runtime state (current branch, active worktree) lives here, separate
	// from the static configuration in configDir.
	dbDir := filepath.Join(homeDir, "db")
	stateStore, err := state.Open(dbDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open state database: %w", err)
	}

	resourcesManager := resources.NewManager(configDir)
	envFilePath := filepath.Join(configDir, ".env")

	providerStore := provider.NewStore(filepath.Join(configDir, "providers"), envFilePath)
	if err := providerStore.Load(); err != nil {
		return nil, fmt.Errorf("failed to load providers: %w", err)
	}

	logger, err := logging.NewLogger(homeDir)
	if err != nil {
		return nil, fmt.Errorf("failed to create logger: %w", err)
	}

	containerRuntime := os.Getenv("DEVENV_CONTAINER_RUNTIME")
	if envFilePath != "" {
		if vars, loadErr := resources.LoadEnvFile(envFilePath); loadErr == nil {
			if vars["DEVENV_CONTAINER_RUNTIME"] != "" {
				containerRuntime = vars["DEVENV_CONTAINER_RUNTIME"]
			}
			if vars["DEVENV_PODMAN_HOST"] != "" && os.Getenv("DEVENV_PODMAN_HOST") == "" {
				_ = os.Setenv("DEVENV_PODMAN_HOST", vars["DEVENV_PODMAN_HOST"])
			}
		}
	}
	dockerClient, err := docker.NewClient(containerRuntime)
	if err != nil {
		return nil, fmt.Errorf("failed to create container runtime client: %w", err)
	}

	appManager := app.NewManager(homeDir, configDir, stateStore)

	authProvider := &multiAuthProvider{providers: providerStore, appManager: appManager}
	gitRepo := git.NewRepository(authProvider)

	executor := operations.NewExecutor(logger)
	statusManager := status.NewManagerWithLogger(logger, appManager)

	buildService := build.NewService(resourcesManager, executor, statusManager, homeDir)
	if waiter, ok := dockerClient.(build.HealthWaiter); ok {
		buildService.ConfigureDockerHealth(waiter, 0)
	}
	buildService.ConfigureStateStore(stateStore)
	operationsService := operations.NewService(dockerClient, executor, statusManager, resourcesManager, envFilePath)
	buildService.ConfigureRunDependencies(appManager, operationsService)

	return &container{
		logger:            logger,
		homeDir:           homeDir,
		providerStore:     providerStore,
		dockerClient:      dockerClient,
		gitRepository:     gitRepo,
		statusManager:     statusManager,
		resourcesManager:  resourcesManager,
		appManager:        appManager,
		stateStore:        stateStore,
		executor:          executor,
		buildService:      buildService,
		operationsService: operationsService,
	}, nil
}
