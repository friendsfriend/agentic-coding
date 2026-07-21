import unittest

from herdr_workflow import tiering


class ReviewTierTest(unittest.TestCase):
    def test_lite_default(self):
        tier, roles = tiering.review_tier("5\t2\tsrc/foo.py\n", ["src/foo.py"])
        self.assertEqual(tier, "lite")
        self.assertEqual(set(roles), {"security-verifier", "agents-verifier", "quality-verifier", "openspec-verifier"})

    def test_sensitive_path_forces_full(self):
        tier, roles = tiering.review_tier("1\t1\tsrc/auth/login.py\n", ["src/auth/login.py"])
        self.assertEqual(tier, "full")
        self.assertEqual(set(roles), set(tiering.VERIFIER_ROLES))

    def test_more_than_50_files_forces_full(self):
        paths = [f"src/file{i}.py" for i in range(51)]
        tier, _ = tiering.review_tier("", paths)
        self.assertEqual(tier, "full")

    def test_more_than_100_lines_forces_full(self):
        tier, _ = tiering.review_tier("60\t50\tsrc/foo.py\n", ["src/foo.py"])
        self.assertEqual(tier, "full")

    def test_docs_only_under_10_lines_is_trivial(self):
        tier, roles = tiering.review_tier("3\t2\tREADME.md\n", ["README.md"])
        self.assertEqual(tier, "trivial")
        self.assertEqual(set(roles), {"quality-verifier", "openspec-verifier"})

    def test_docs_only_over_10_lines_is_lite_not_trivial(self):
        tier, _ = tiering.review_tier("30\t20\tREADME.md\n", ["README.md"])
        self.assertEqual(tier, "lite")

    def test_binary_rows_excluded_from_line_count(self):
        # git numstat uses "-\t-\tpath" for binary files
        tier, _ = tiering.review_tier("-\t-\tsrc/image.png\n", ["src/image.png"])
        self.assertEqual(tier, "lite")


class EligibleVerifierRolesTest(unittest.TestCase):
    def test_code_file_gets_quality(self):
        self.assertIn("quality-verifier", tiering.eligible_verifier_roles(["src/foo.py"]))

    def test_md_only_skips_quality(self):
        self.assertNotIn("quality-verifier", tiering.eligible_verifier_roles(["docs/readme.md"]))

    def test_security_path_triggers_security_verifier(self):
        self.assertIn("security-verifier", tiering.eligible_verifier_roles(["src/security/token.py"]))

    def test_agents_md_triggers_agents_verifier(self):
        self.assertIn("agents-verifier", tiering.eligible_verifier_roles(["skills/AGENTS.md"]))

    def test_openspec_path_triggers_openspec_verifier(self):
        self.assertIn("openspec-verifier", tiering.eligible_verifier_roles(["openspec/changes/x/tasks.md"]))

    def test_performance_keyword_triggers_performance_verifier(self):
        self.assertIn("performance-verifier", tiering.eligible_verifier_roles(["src/cache/query_batch.py"]))

    def test_unrelated_file_triggers_nothing_extra(self):
        roles = tiering.eligible_verifier_roles(["docs/readme.md"])
        self.assertEqual(roles, [])


class FileManifestTest(unittest.TestCase):
    def test_manifest_includes_stats_and_hunks(self):
        numstat = "3\t1\tsrc/foo.py\n"
        diff = "diff --git a/src/foo.py b/src/foo.py\n+++ b/src/foo.py\n@@ -1,2 +1,3 @@\n+new line\n"
        manifest = tiering.file_manifest(numstat, diff, ["src/foo.py"])
        self.assertEqual(manifest[0]["path"], "src/foo.py")
        self.assertEqual(manifest[0]["added"], "3")
        self.assertEqual(manifest[0]["removed"], "1")
        self.assertEqual(len(manifest[0]["hunks"]), 1)

    def test_manifest_caps_hunks_at_8(self):
        diff = "+++ b/src/foo.py\n" + "".join(f"@@ -{i},0 +{i},1 @@\n" for i in range(12))
        manifest = tiering.file_manifest("", diff, ["src/foo.py"])
        self.assertEqual(len(manifest[0]["hunks"]), 8)

    def test_missing_stats_default_to_unknown(self):
        manifest = tiering.file_manifest("", "", ["src/new.py"])
        self.assertEqual(manifest[0]["added"], "?")
        self.assertEqual(manifest[0]["removed"], "?")


class ApplicableInstructionsTest(unittest.TestCase):
    def test_finds_agents_md_up_the_tree(self, tmp=None):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "src" / "pkg").mkdir(parents=True)
            (root / "src" / "AGENTS.md").write_text("rules")
            found = tiering.applicable_instructions(root, ["src/pkg/mod.py"])
            self.assertEqual(found, ["src/AGENTS.md"])

    def test_no_instructions_found(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "src").mkdir()
            found = tiering.applicable_instructions(root, ["src/mod.py"])
            self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
