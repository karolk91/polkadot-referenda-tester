// Shared test infrastructure used across multiple test binaries (tests.rs,
// all_tracks.rs, scenarios.rs, generate_chain_specs.rs). Each binary only
// uses a subset, so Rust reports false "dead_code" warnings for items that
// are used by other binaries.
#![allow(dead_code)]

/// Run an async sub-test expression, log PASS/FAIL, push errors, and bail on first failure.
///
/// Usage: `run_and_bail!(errors, "label", some_async_fn(args));`
macro_rules! run_and_bail {
    ($errors:expr, $label:expr, $expr:expr) => {
        match $expr.await {
            Ok(()) => log::info!("PASS: {}", $label),
            Err(e) => {
                let msg = format!("FAIL: {}: {e:#}", $label);
                log::error!("{msg}");
                $errors.push(msg);
            }
        }
        if !$errors.is_empty() {
            panic!(
                "{} sub-test(s) failed (bailing early):\n{}",
                $errors.len(),
                $errors.join("\n")
            );
        }
    };
}

pub(crate) use run_and_bail;

pub mod call_data;
pub mod config;
pub mod context;
pub mod extrinsic_submitter;
pub mod network;
pub mod port_allocator;
pub mod raw_storage;
pub mod tool_runner;
pub mod tracks;
