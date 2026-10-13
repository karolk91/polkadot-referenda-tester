use anyhow::{Context, Result};
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use crate::calls::ReferendumCalls;

pub const TOOL_TIMEOUT: Duration = Duration::from_secs(600);
const TOOL_PROJECT_DIR_ENV: &str = "TOOL_PROJECT_DIR";
const TOOL_FAILURE_EXIT_CODE: i32 = 1;
const THEN_FLAG: &str = "--then";

#[derive(Clone, Debug, Default)]
pub struct StepArgs {
    pub referendum: Option<String>,
    pub fellowship: Option<String>,
    pub pre_call: Option<String>,
    pub pre_origin: Option<String>,
    pub call_to_create_governance_referendum: Option<String>,
    pub call_to_note_preimage_for_governance_referendum: Option<String>,
    pub call_to_create_fellowship_referendum: Option<String>,
    pub call_to_note_preimage_for_fellowship_referendum: Option<String>,
    pub post_test: Option<String>,
    pub post_test_args: Option<String>,
}

impl StepArgs {
    pub fn governance_referendum(mut self, id: u32) -> Self {
        self.referendum = Some(id.to_string());
        self
    }

    pub fn fellowship_referendum(mut self, id: u32) -> Self {
        self.fellowship = Some(id.to_string());
        self
    }

    pub fn governance_creation(mut self, calls: &ReferendumCalls) -> Self {
        self.call_to_create_governance_referendum = Some(calls.submit.clone());
        self.call_to_note_preimage_for_governance_referendum = calls.preimage.clone();
        self
    }

    pub fn fellowship_creation(mut self, calls: &ReferendumCalls) -> Self {
        self.call_to_create_fellowship_referendum = Some(calls.submit.clone());
        self.call_to_note_preimage_for_fellowship_referendum = calls.preimage.clone();
        self
    }

    pub fn pre_call(mut self, call: String, origin: &str) -> Self {
        self.pre_call = Some(call);
        self.pre_origin = Some(origin.to_string());
        self
    }

    pub fn post_test(mut self, module: &str, args: Option<&str>) -> Self {
        self.post_test = Some(module.to_string());
        self.post_test_args = args.map(str::to_string);
        self
    }

    fn flags(&self) -> [(&'static str, &Option<String>); 10] {
        [
            ("--referendum", &self.referendum),
            ("--fellowship", &self.fellowship),
            ("--pre-call", &self.pre_call),
            ("--pre-origin", &self.pre_origin),
            (
                "--call-to-create-governance-referendum",
                &self.call_to_create_governance_referendum,
            ),
            (
                "--call-to-note-preimage-for-governance-referendum",
                &self.call_to_note_preimage_for_governance_referendum,
            ),
            (
                "--call-to-create-fellowship-referendum",
                &self.call_to_create_fellowship_referendum,
            ),
            (
                "--call-to-note-preimage-for-fellowship-referendum",
                &self.call_to_note_preimage_for_fellowship_referendum,
            ),
            ("--post-test", &self.post_test),
            ("--post-test-args", &self.post_test_args),
        ]
    }
}

fn push_flags(args: &mut Vec<String>, flags: &[(&str, &Option<String>)]) {
    for (flag, value) in flags {
        if let Some(value) = value {
            args.push(flag.to_string());
            args.push(value.clone());
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ToolArgs {
    pub governance_chain_url: Option<String>,
    pub fellowship_chain_url: Option<String>,
    pub additional_chains: Option<String>,
    pub asset_hub_polkadot_url: Option<String>,
    pub bridge_hub_polkadot_url: Option<String>,
    pub bridge_hub_kusama_url: Option<String>,
    pub steps: Vec<StepArgs>,
}

impl ToolArgs {
    fn run_flags(&self) -> [(&'static str, &Option<String>); 6] {
        [
            ("--governance-chain-url", &self.governance_chain_url),
            ("--fellowship-chain-url", &self.fellowship_chain_url),
            ("--additional-chains", &self.additional_chains),
            ("--asset-hub-polkadot-url", &self.asset_hub_polkadot_url),
            ("--bridge-hub-polkadot-url", &self.bridge_hub_polkadot_url),
            ("--bridge-hub-kusama-url", &self.bridge_hub_kusama_url),
        ]
    }

    fn cli_args(&self) -> Vec<String> {
        let mut args = vec!["test".to_string(), "--verbose".to_string()];
        push_flags(&mut args, &self.run_flags());
        for (index, step) in self.steps.iter().enumerate() {
            if index > 0 {
                args.push(THEN_FLAG.to_string());
            }
            push_flags(&mut args, &step.flags());
        }
        args
    }
}

pub struct ToolOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl ToolOutput {
    fn transcript(&self) -> String {
        format!(
            "--- stdout ---\n{}\n--- stderr ---\n{}",
            self.stdout, self.stderr
        )
    }

    fn output_contains(&self, pattern: &str) -> bool {
        let pattern = pattern.to_lowercase();
        self.stdout.to_lowercase().contains(&pattern)
            || self.stderr.to_lowercase().contains(&pattern)
    }

    pub fn check_success(&self) -> Result<()> {
        anyhow::ensure!(
            self.exit_code == Some(0),
            "tool exit code {:?}\n{}",
            self.exit_code,
            self.transcript()
        );
        Ok(())
    }

    pub fn check_executed(&self) -> Result<()> {
        self.check_success()?;
        self.check_stdout_contains("executed successfully")
    }

    pub fn check_failure(&self) -> Result<()> {
        anyhow::ensure!(
            self.exit_code == Some(TOOL_FAILURE_EXIT_CODE),
            "tool exit code {:?} instead of {TOOL_FAILURE_EXIT_CODE}\n{}",
            self.exit_code,
            self.transcript()
        );
        Ok(())
    }

    pub fn check_stdout_contains(&self, pattern: &str) -> Result<()> {
        anyhow::ensure!(
            self.stdout.to_lowercase().contains(&pattern.to_lowercase()),
            "no '{pattern}' in stdout\n--- stdout ---\n{}",
            self.stdout
        );
        Ok(())
    }

    pub fn check_output_contains(&self, pattern: &str) -> Result<()> {
        anyhow::ensure!(
            self.output_contains(pattern),
            "no '{pattern}' in the output\n{}",
            self.transcript()
        );
        Ok(())
    }

    pub fn check_output_does_not_contain(&self, pattern: &str) -> Result<()> {
        anyhow::ensure!(
            !self.output_contains(pattern),
            "'{pattern}' in the output\n{}",
            self.transcript()
        );
        Ok(())
    }
}

pub struct ToolRunner {
    project_dir: PathBuf,
}

impl Default for ToolRunner {
    fn default() -> Self {
        let project_dir = std::env::var(TOOL_PROJECT_DIR_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(".."));
        Self { project_dir }
    }
}

impl ToolRunner {
    pub async fn run(&self, args: &ToolArgs) -> Result<ToolOutput> {
        self.run_with_timeout(args, TOOL_TIMEOUT).await
    }

    pub async fn run_with_timeout(&self, args: &ToolArgs, timeout: Duration) -> Result<ToolOutput> {
        let mut command = tokio::process::Command::new("npm");
        command
            .current_dir(&self.project_dir)
            .args(["run", "--silent", "cli", "--"])
            .args(args.cli_args())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        log::info!("running tool: {command:?}");

        let output = tokio::time::timeout(timeout, command.spawn()?.wait_with_output())
            .await
            .with_context(|| format!("tool run exceeded {timeout:?}"))?
            .context("tool process failed")?;
        let tool_output = ToolOutput {
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        };
        log::info!("tool exit code: {:?}", tool_output.exit_code);
        log::debug!("{}", tool_output.transcript());
        Ok(tool_output)
    }
}

pub async fn sub_test(label: &str, outcome: impl Future<Output = Result<()>>) {
    log::info!(">>> {label}");
    match outcome.await {
        Ok(()) => log::info!("PASS: {label}"),
        Err(error) => {
            log::error!("FAIL: {label}: {error:#}");
            panic!("FAIL: {label}: {error:#}");
        }
    }
}
