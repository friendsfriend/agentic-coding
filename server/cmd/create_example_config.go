package cmd

import (
	"github.com/friendsfriend/devenv/pkg/exampleconfig"
	"github.com/spf13/cobra"
)

var createExampleConfigCmd = &cobra.Command{
	Use:   "create-example-config",
	Short: "Create a first-time runnable example config",
	RunE: func(cmd *cobra.Command, args []string) error {
		generator, err := exampleconfig.New()
		if err != nil {
			return err
		}
		if err := generator.Generate(); err != nil {
			return err
		}
		cmd.Printf("Created example config in %s and scripts in %s/scripts\n", generator.ConfigDir, generator.HomeDir)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(createExampleConfigCmd)
}
