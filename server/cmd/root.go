package cmd

import (
	"log"

	"github.com/friendsfriend/devenv/pkg/version"
	"github.com/spf13/cobra"
)

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:     "devenv",
	Short:   "Contains commands to start and manage a local development environment",
	Long:    "Contains commands to start and manage a local development environment",
	Version: version.Version,
	Run: func(cmd *cobra.Command, args []string) {
		// The TUI is now a separate TypeScript binary that spawns this server
		// Use 'devenv server' to start the HTTP API server directly
		cmd.PrintErrln("Use 'devenv server' to start the HTTP API server")
		cmd.PrintErrln("Or use the OpenTUI binary to start the interactive interface")
	},
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		log.Panic(err)
	}
}

func init() {
	// Here you will define your flags and configuration settings.
	// Cobra supports persistent flags, which, if defined here,
	// will be global for your application.

	// rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is $HOME/devenv-cli.yaml)")

	// Cobra also supports local flags, which will only run
	// when this action is called directly.
	rootCmd.Flags().BoolP("toggle", "t", false, "Help message for toggle")
}
