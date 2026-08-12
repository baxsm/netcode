//! Deterministic simulation core.
//!
//! Everything below the boundary is pure: no I/O, no clock, no system entropy, no
//! async. A run is fully determined by the arguments passed in.

pub mod boundary;
pub mod fx;
pub mod hash;
pub mod net;
pub mod rng;
pub mod run;
pub mod scenario;
pub mod sim;

use wasm_bindgen::prelude::*;

/// True when the build has relaxed SIMD compiled in. Its instructions may return
/// different results for the same inputs, so the build reports what it actually did
/// rather than trusting the toolchain default to stay off.
pub const fn relaxed_simd_enabled() -> bool {
    cfg!(target_feature = "relaxed-simd")
}

pub const fn simd128_enabled() -> bool {
    cfg!(target_feature = "simd128")
}

/// Core version plus the determinism-relevant build flags. Written into every
/// exported report, because a result is only meaningful next to the build that
/// produced it.
#[wasm_bindgen]
pub fn version() -> String {
    format!(
        "{} relaxed_simd={} simd128={}",
        env!("CARGO_PKG_VERSION"),
        relaxed_simd_enabled(),
        simd128_enabled()
    )
}

/// Runs a simulation and returns only the final state hash.
///
/// This is the function the Phase 0 gate calls in Chrome, Firefox and Node.
#[wasm_bindgen]
pub fn state_hash(seed: u64, ticks: u32, entity_count: u32) -> u64 {
    sim::run_to_hash(seed, ticks, entity_count as usize)
}

/// Number of values in the buffer `run_metrics` returns.
#[wasm_bindgen]
pub fn metrics_len() -> u32 {
    boundary::METRICS_LEN as u32
}

/// Values per snapshot record in the buffer `run_snapshots` returns.
#[wasm_bindgen]
pub fn snapshot_stride() -> u32 {
    boundary::SNAPSHOT_STRIDE as u32
}

/// Names of the built-in network presets, tab separated. Indices match
/// `segment_index` on the run functions.
#[wasm_bindgen]
pub fn segment_names() -> String {
    boundary::SEGMENT_NAMES.join("\t")
}

/// Runs one simulation and returns its metrics as a flat buffer. Field order is the
/// contract with the TypeScript mirror, held together by a test.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn run_metrics(
    seed: u64,
    segment_index: u32,
    tick_rate: u32,
    duration_ticks: u32,
    accel: i32,
    max_speed: i32,
    friction_permille: u32,
    bounds: i32,
    move_from_tick: u32,
    stop_at_tick: u32,
) -> Vec<f64> {
    let scenario = boundary::build_scenario(&boundary::BuildScenario {
        tick_rate,
        duration_ticks,
        accel,
        max_speed,
        friction_permille,
        bounds,
        move_from_tick,
        stop_at_tick,
    });
    boundary::metrics_buffer(&scenario, boundary::segment_by_index(segment_index), seed)
}

/// Same run, against a network described directly rather than by preset.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn run_metrics_custom(
    seed: u64,
    tick_rate: u32,
    duration_ticks: u32,
    accel: i32,
    max_speed: i32,
    friction_permille: u32,
    bounds: i32,
    move_from_tick: u32,
    stop_at_tick: u32,
    rtt_mean_ms: u32,
    rtt_jitter_ms: u32,
    loss_pct: u32,
    reorder_pct: u32,
    duplicate_pct: u32,
    burst_loss: bool,
) -> Vec<f64> {
    let scenario = boundary::build_scenario(&boundary::BuildScenario {
        tick_rate,
        duration_ticks,
        accel,
        max_speed,
        friction_permille,
        bounds,
        move_from_tick,
        stop_at_tick,
    });
    let segment = boundary::custom_segment(&boundary::CustomSegment {
        rtt_mean_ms,
        rtt_jitter_ms,
        loss_pct,
        reorder_pct,
        duplicate_pct,
        burst_loss,
    });
    boundary::metrics_buffer(&scenario, segment, seed)
}

/// Per-tick server and client positions, for the replay view.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn run_snapshots(
    seed: u64,
    segment_index: u32,
    tick_rate: u32,
    duration_ticks: u32,
    accel: i32,
    max_speed: i32,
    friction_permille: u32,
    bounds: i32,
    move_from_tick: u32,
    stop_at_tick: u32,
) -> Vec<f64> {
    let scenario = boundary::build_scenario(&boundary::BuildScenario {
        tick_rate,
        duration_ticks,
        accel,
        max_speed,
        friction_permille,
        bounds,
        move_from_tick,
        stop_at_tick,
    });
    boundary::snapshot_buffer(&scenario, boundary::segment_by_index(segment_index), seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaxed_simd_is_off() {
        assert!(
            !relaxed_simd_enabled(),
            "relaxed SIMD introduces non-deterministic instructions and must stay off"
        );
    }

    #[test]
    fn version_reports_build_flags() {
        let v = version();
        assert!(v.contains("relaxed_simd=false"));
        assert!(v.starts_with(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn state_hash_export_matches_direct_call() {
        assert_eq!(state_hash(42, 600, 16), sim::run_to_hash(42, 600, 16));
    }
}
