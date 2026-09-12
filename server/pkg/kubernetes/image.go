package kubernetes

import (
	"path/filepath"
	"strings"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type ImageBuildPlan struct {
	Command    Command
	Image      string
	Repository string
	Tag        string
	PullPolicy string
}

func ResolveImageBuild(appIdent, appDir string, cfg *resources.KubernetesImageConfig, runtimeCommand string) (ImageBuildPlan, bool) {
	if cfg == nil || cfg.Build == nil || (cfg.Build.Enabled != nil && !*cfg.Build.Enabled) {
		return ImageBuildPlan{}, false
	}
	repo := cfg.Repository
	if repo == "" {
		repo = appIdent
	}
	if runtimeCommand == "podman" && isShortImageName(repo) {
		repo = "localhost/" + repo
	}
	tag := cfg.Tag
	if tag == "" {
		tag = "dev"
	}
	ctx := cfg.Build.Context
	if ctx == "" {
		ctx = appDir
	}
	dockerfile := cfg.Build.Dockerfile
	if dockerfile == "" {
		dockerfile = filepath.Join(appDir, "Dockerfile")
	}
	image := repo + ":" + tag
	pullPolicy := cfg.PullPolicy
	if pullPolicy == "" {
		pullPolicy = "IfNotPresent"
	}
	return ImageBuildPlan{Command: Command{Name: runtimeCommand, Args: []string{"build", "-f", dockerfile, "-t", image, ctx}}, Image: image, Repository: repo, Tag: tag, PullPolicy: pullPolicy}, true
}

func ResolveImageReference(appIdent string, cfg *resources.KubernetesImageConfig, runtimeCommand string) (ImageBuildPlan, bool) {
	if cfg == nil {
		return ImageBuildPlan{}, false
	}
	repo := cfg.Repository
	if repo == "" {
		repo = appIdent
	}
	if runtimeCommand == "podman" && isShortImageName(repo) {
		repo = "localhost/" + repo
	}
	tag := cfg.Tag
	if tag == "" {
		tag = "latest"
	}
	pullPolicy := cfg.PullPolicy
	if pullPolicy == "" {
		pullPolicy = "IfNotPresent"
	}
	return ImageBuildPlan{Image: repo + ":" + tag, Repository: repo, Tag: tag, PullPolicy: pullPolicy}, true
}

func isShortImageName(repo string) bool {
	return !strings.Contains(repo, "/") && !strings.Contains(repo, ".") && !strings.Contains(repo, ":")
}

func HelmImageOverrides(cfg resources.KubernetesImageConfig, plan ImageBuildPlan) []string {
	var args []string
	add := func(path, value string) {
		if path != "" && value != "" {
			args = append(args, "--set-string", path+"="+value)
		}
	}
	add(cfg.ValuePaths.Repository, plan.Repository)
	add(cfg.ValuePaths.Tag, plan.Tag)
	add(cfg.ValuePaths.PullPolicy, plan.PullPolicy)
	return args
}
