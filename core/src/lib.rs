//! Deterministic simulation core.
//!
//! Everything below the boundary is pure: no I/O, no clock, no system entropy, no
//! async. A run is fully determined by the arguments passed in.

pub mod boundary;
pub mod config;
pub mod fx;
pub mod hash;
pub mod net;
pub mod peekers;
pub mod replay;
pub mod rng;
pub mod run;
pub mod scenario;
pub mod sim;
pub mod techniques;

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

/// Number of values the config buffer passed to the run functions must hold.
#[wasm_bindgen]
pub fn config_len() -> u32 {
    boundary::CONFIG_LEN as u32
}

/// Rejects a configuration that cannot mean what it says, returning the reason code
/// or zero when it is valid.
///
/// Exposed so the UI can refuse a combination before spending a run on it, rather
/// than showing a number produced by a config that quietly did something else.
#[wasm_bindgen]
pub fn validate_config(config: Vec<f64>) -> u32 {
    match boundary::config_from_buffer(&config).validate() {
        Ok(()) => 0,
        Err(e) => e.code(),
    }
}

/// Peeker's advantage in milliseconds, reproducing Riot's published model.
#[wasm_bindgen]
pub fn peekers_advantage_ms(rtt_ms: u32, tick_rate: u32, client_fps: u32) -> f64 {
    fx::to_f64_for_display(peekers::peekers_advantage_ms(peekers::PeekConditions {
        rtt_ms,
        tick_rate,
        client_fps,
    }))
}

/// Values per snapshot record in the buffer `run_snapshots` returns.
#[wasm_bindgen]
pub fn snapshot_stride() -> u32 {
    boundary::SNAPSHOT_STRIDE as u32
}

/// Values per frame record in the buffer `run_frames` returns.
#[wasm_bindgen]
pub fn frame_stride() -> u32 {
    boundary::FRAME_STRIDE as u32
}

/// Clients recorded in each replay frame.
#[wasm_bindgen]
pub fn frame_client_count() -> u32 {
    replay::CLIENT_COUNT as u32
}

/// The value a tick slot carries when it holds nothing.
#[wasm_bindgen]
pub fn absent_tick() -> f64 {
    boundary::ABSENT_TICK
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
    config: Vec<f64>,
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
    boundary::metrics_buffer(
        &scenario,
        boundary::segment_by_index(segment_index),
        seed,
        boundary::config_from_buffer(&config),
    )
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
    config: Vec<f64>,
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
    boundary::metrics_buffer(
        &scenario,
        segment,
        seed,
        boundary::config_from_buffer(&config),
    )
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
    config: Vec<f64>,
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
    boundary::snapshot_buffer(
        &scenario,
        boundary::segment_by_index(segment_index),
        seed,
        boundary::config_from_buffer(&config),
    )
}

/// A two-client run recorded frame by frame, for the replay view.
///
/// Network conditions cross directly rather than by preset index, because the view's
/// latency, jitter and loss sliders are continuous. Re-running from the same seed with
/// one condition changed is the whole point of the controls.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn run_frames(
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
    config: Vec<f64>,
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
    boundary::frame_buffer(
        &scenario,
        segment,
        seed,
        boundary::config_from_buffer(&config),
    )
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
