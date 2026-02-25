//! Simple port allocator for test isolation.
//!
//! Each call to `next_port()` returns a fresh port number, ensuring concurrent
//! tool invocations don't collide. The gap between ports is 10 to accommodate
//! Chopsticks' internal port usage.
//!
//! Uses a monotonically increasing global counter — no resets, so port ranges
//! never overlap even if test suites run in parallel.

use std::sync::atomic::{AtomicU16, Ordering};

static NEXT_PORT: AtomicU16 = AtomicU16::new(9000);

/// Get the next available port and advance the counter by 10.
/// The gap accounts for Chopsticks' internal ports.
pub fn next_port() -> u16 {
    NEXT_PORT.fetch_add(10, Ordering::Relaxed)
}
