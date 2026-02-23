//! Invokes the polkadot-referenda-tester CLI as a subprocess and captures output.

use anyhow::{Context, Result};
use std::process::Stdio;
use std::time::Duration;

use super::config::TOOL_EXECUTION_TIMEOUT_SECS;

/// Arguments for `yarn cli test`.
#[derive(Default)]
pub struct ToolArgs {
    pub governance_chain_url: Option<String>,
    pub fellowship_chain_url: Option<String>,
    pub additional_chains: Option<String>,
    pub referendum: Option<String>,
    pub fellowship: Option<String>,
    pub port: Option<u16>,
    pub pre_call: Option<String>,
    pub pre_origin: Option<String>,
    pub call_to_create_governance_referendum: Option<String>,
    pub call_to_note_preimage_for_governance_referendum: Option<String>,
    pub call_to_create_fellowship_referendum: Option<String>,
    pub call_to_note_preimage_for_fellowship_referendum: Option<String>,
    pub verbose: bool,
}

/// Captured output from a tool invocation.
pub struct ToolOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ToolOutput {
    // === Panicking assertions (for standalone tests) ===

    /// Assert the tool exited successfully (code 0).
    pub fn assert_success(&self) {
        assert_eq!(
            self.exit_code, 0,
            "Tool exited with code {}.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.exit_code, self.stdout, self.stderr
        );
    }

    /// Assert the tool exited with failure (non-zero code).
    pub fn assert_failure(&self) {
        assert_ne!(
            self.exit_code, 0,
            "Expected tool to fail but it exited with code 0.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.stdout, self.stderr
        );
    }

    /// Assert stdout contains a substring (case-insensitive).
    pub fn assert_stdout_contains(&self, pattern: &str) {
        let lower_stdout = self.stdout.to_lowercase();
        let lower_pattern = pattern.to_lowercase();
        assert!(
            lower_stdout.contains(&lower_pattern),
            "Expected stdout to contain '{}', but it didn't.\n--- stdout ---\n{}",
            pattern,
            self.stdout,
        );
    }

    /// Assert stdout contains a blockchain event like "Section.Method".
    pub fn assert_event_present(&self, section: &str, method: &str) {
        let pattern = format!("{}.{}", section, method);
        assert!(
            self.stdout.contains(&pattern),
            "Expected event '{}.{}' in stdout, but not found.\n--- stdout ---\n{}",
            section,
            method,
            self.stdout,
        );
    }

    // === Fallible checks (for test suites — return Result instead of panicking) ===

    /// Check the tool exited successfully (code 0).
    pub fn check_success(&self) -> Result<()> {
        anyhow::ensure!(
            self.exit_code == 0,
            "Tool exited with code {}.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.exit_code,
            self.stdout,
            self.stderr
        );
        Ok(())
    }

    /// Check the tool exited with failure (non-zero code).
    pub fn check_failure(&self) -> Result<()> {
        anyhow::ensure!(
            self.exit_code != 0,
            "Expected tool to fail but it exited with code 0.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.stdout,
            self.stderr
        );
        Ok(())
    }

    /// Check stdout contains a substring (case-insensitive).
    pub fn check_stdout_contains(&self, pattern: &str) -> Result<()> {
        let lower_stdout = self.stdout.to_lowercase();
        let lower_pattern = pattern.to_lowercase();
        anyhow::ensure!(
            lower_stdout.contains(&lower_pattern),
            "Expected stdout to contain '{}', but it didn't.\n--- stdout ---\n{}",
            pattern,
            self.stdout,
        );
        Ok(())
    }

    /// Check either stdout or stderr contains a substring (case-insensitive).
    pub fn check_any_output_contains(&self, pattern: &str) -> Result<()> {
        let lower_pattern = pattern.to_lowercase();
        let in_stdout = self.stdout.to_lowercase().contains(&lower_pattern);
        let in_stderr = self.stderr.to_lowercase().contains(&lower_pattern);
        anyhow::ensure!(
            in_stdout || in_stderr,
            "Expected output to contain '{}', but not found.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            pattern,
            self.stdout,
            self.stderr,
        );
        Ok(())
    }
}

// ── Test suite infrastructure ────────────────────────────────────────────────

/// A single sub-test result: name + outcome.
pub type SubTestResult = (&'static str, Result<()>);

/// Report all sub-test results. Logs each, then panics if any failed.
pub fn report_results(results: &[SubTestResult]) {
    let mut failures = Vec::new();
    for (name, result) in results {
        match result {
            Ok(()) => log::info!("  PASS: {}", name),
            Err(e) => {
                log::error!("  FAIL: {} -- {:#}", name, e);
                failures.push(*name);
            }
        }
    }
    if !failures.is_empty() {
        panic!(
            "{}/{} sub-tests failed: {:?}",
            failures.len(),
            results.len(),
            failures
        );
    }
    log::info!(
        "All {}/{} sub-tests passed!",
        results.len(),
        results.len()
    );
}

/// Runs the polkadot-referenda-tester CLI tool as a child process.
pub struct ToolRunner {
    project_dir: String,
}

impl ToolRunner {
    /// Create a new ToolRunner. Discovers the project root by walking up from the
    /// integration-tests directory.
    pub fn new() -> Self {
        let project_dir = std::env::var("TOOL_PROJECT_DIR").unwrap_or_else(|_| {
            // Default: assume we're running from integration-tests/
            let cwd = std::env::current_dir().expect("cannot get cwd");
            let parent = cwd.parent().unwrap_or(&cwd);
            parent.to_string_lossy().to_string()
        });
        Self { project_dir }
    }

    /// Run `yarn cli test` with the given arguments.
    pub async fn run_test_referendum(&self, args: ToolArgs) -> Result<ToolOutput> {
        let mut cmd = tokio::process::Command::new("yarn");
        cmd.current_dir(&self.project_dir)
            .arg("cli")
            .arg("test");

        if let Some(ref url) = args.governance_chain_url {
            cmd.arg("--governance-chain-url").arg(url);
        }
        if let Some(ref url) = args.fellowship_chain_url {
            cmd.arg("--fellowship-chain-url").arg(url);
        }
        if let Some(ref chains) = args.additional_chains {
            cmd.arg("--additional-chains").arg(chains);
        }
        if let Some(ref id) = args.referendum {
            cmd.arg("--referendum").arg(id);
        }
        if let Some(ref id) = args.fellowship {
            cmd.arg("--fellowship").arg(id);
        }
        if let Some(port) = args.port {
            cmd.arg("--port").arg(port.to_string());
        }
        if let Some(ref hex) = args.pre_call {
            cmd.arg("--pre-call").arg(hex);
        }
        if let Some(ref origin) = args.pre_origin {
            cmd.arg("--pre-origin").arg(origin);
        }
        if let Some(ref hex) = args.call_to_create_governance_referendum {
            cmd.arg("--call-to-create-governance-referendum").arg(hex);
        }
        if let Some(ref hex) = args.call_to_note_preimage_for_governance_referendum {
            cmd.arg("--call-to-note-preimage-for-governance-referendum")
                .arg(hex);
        }
        if let Some(ref hex) = args.call_to_create_fellowship_referendum {
            cmd.arg("--call-to-create-fellowship-referendum").arg(hex);
        }
        if let Some(ref hex) = args.call_to_note_preimage_for_fellowship_referendum {
            cmd.arg("--call-to-note-preimage-for-fellowship-referendum")
                .arg(hex);
        }
        if args.verbose {
            cmd.arg("--verbose");
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        log::info!("Running tool: {:?}", cmd);

        let child = cmd.spawn().context("Failed to spawn yarn cli process")?;

        let output = tokio::time::timeout(
            Duration::from_secs(TOOL_EXECUTION_TIMEOUT_SECS),
            child.wait_with_output(),
        )
        .await
        .context("Tool execution timed out")?
        .context("Tool process failed")?;

        let tool_output = ToolOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        };

        log::info!("Tool exit code: {}", tool_output.exit_code);
        if !tool_output.stdout.is_empty() {
            log::debug!("Tool stdout:\n{}", tool_output.stdout);
        }
        if !tool_output.stderr.is_empty() {
            log::debug!("Tool stderr:\n{}", tool_output.stderr);
        }

        Ok(tool_output)
    }
}
