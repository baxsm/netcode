//! Deterministic simulation core.
//!
//! Everything below the boundary is pure: no I/O, no clock, no system entropy, no
//! async. A run is fully determined by the arguments passed in.

pub mod fx;
pub mod hash;
pub mod rng;
pub mod sim;

use wasm_bindgen::prelude::*;

/// True when the build has relaxed SIMD compiled in.
///
/// The relaxed SIMD proposal states that the same instruction with the same inputs
/// may return different results, which would break every comparison this project
/// makes. It is off by default in the current toolchain, but a default is not a
/// guarantee, so the build reports what it actually did and a test asserts it.
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
