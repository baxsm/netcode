//! The WASM boundary. Values cross as flat scalars and a `Float64Array`, never as
//! serialized structs.
//!
//! `schema.md` names `serde-wasm-bindgen`, but that crate was last published in
//! February 2024 and a struct-heavy boundary is the documented `wasm-bindgen` time
//! sink. Flat drops the dependency and keeps serialization out of the sweep's hot
//! path. Fixed point converts to `f64` here on the way out, and nowhere else.

use crate::fx::{from_int, ratio, to_f64_for_display, Fx};
use crate::net::{LossModel, NetworkSegment};
use crate::run::{run, RunRequest};
use crate::scenario::{EntityKind, EntitySpec, InputAction, InputEvent, Scenario, WorldConfig};

/// Field count of the metrics buffer. The TypeScript side asserts this, so adding a
/// metric without updating the mirror fails a test rather than silently shifting
/// every field after it.
pub const METRICS_LEN: usize = 12;

/// Values per snapshot: tick, then server x/y/vx/vy, then client x/y/vx/vy.
pub const SNAPSHOT_STRIDE: usize = 9;

pub struct BuildScenario {
    pub tick_rate: u32,
    pub duration_ticks: u32,
    pub accel: i32,
    pub max_speed: i32,
    pub friction_permille: u32,
    pub bounds: i32,
    pub move_from_tick: u32,
    pub stop_at_tick: u32,
}

/// Builds the one-entity scenario the Phase 1 surface exposes.
///
/// Authoring arbitrary scenarios is Phase 5. Until then a caller picks from this
/// shape, which keeps the boundary flat without pretending the editor exists.
pub fn build_scenario(spec: &BuildScenario) -> Scenario {
    let mut input_script = vec![InputEvent {
        tick: spec.move_from_tick,
        entity_id: 0,
        action: InputAction::Move {
            dx: from_int(1),
            dy: Fx::ZERO,
        },
    }];
    if spec.stop_at_tick > spec.move_from_tick {
        input_script.push(InputEvent {
            tick: spec.stop_at_tick,
            entity_id: 0,
            action: InputAction::Stop,
        });
    }

    let mut scenario = Scenario {
        tick_rate: spec.tick_rate.max(1),
        duration_ticks: spec.duration_ticks,
        world: WorldConfig {
            bounds_x: from_int(spec.bounds),
            bounds_y: from_int(spec.bounds),
            friction: ratio(spec.friction_permille as i32, 1000),
            gravity: Fx::ZERO,
        },
        entities: vec![EntitySpec {
            id: 0,
            kind: EntityKind::Player,
            start_x: Fx::ZERO,
            start_y: Fx::ZERO,
            max_speed: from_int(spec.max_speed),
            accel: from_int(spec.accel),
            radius: from_int(1),
        }],
        input_script,
    };
    scenario.sort_inputs();
    scenario
}

/// Named network presets, resolved by index so the boundary stays numeric.
pub fn segment_by_index(index: u32) -> NetworkSegment {
    match index {
        0 => NetworkSegment::perfect(),
        1 => NetworkSegment::lan(),
        2 => NetworkSegment::good_broadband(),
        3 => NetworkSegment::average_broadband(),
        4 => NetworkSegment::mobile_4g(),
        5 => NetworkSegment::transcontinental(),
        _ => NetworkSegment::hostile(),
    }
}

pub const SEGMENT_NAMES: [&str; 7] = [
    "perfect",
    "lan",
    "good broadband",
    "average broadband",
    "mobile 4g",
    "transcontinental",
    "hostile",
];

pub struct CustomSegment {
    pub rtt_mean_ms: u32,
    pub rtt_jitter_ms: u32,
    pub loss_pct: u32,
    pub reorder_pct: u32,
    pub duplicate_pct: u32,
    pub burst_loss: bool,
}

pub fn custom_segment(spec: &CustomSegment) -> NetworkSegment {
    NetworkSegment {
        weight: from_int(1),
        rtt_mean_ms: spec.rtt_mean_ms,
        rtt_jitter_ms: spec.rtt_jitter_ms,
        loss_pct: spec.loss_pct,
        reorder_pct: spec.reorder_pct,
        duplicate_pct: spec.duplicate_pct,
        loss_model: if spec.burst_loss {
            LossModel::GilbertElliott {
                good_to_bad_permille: 20,
                bad_to_good_permille: 300,
                bad_loss_pct: 50,
            }
        } else {
            LossModel::Independent
        },
    }
}

/// Metrics as a flat buffer. Order is the contract; the TypeScript mirror reads the
/// same indices and a test holds the two together.
pub fn metrics_buffer(scenario: &Scenario, segment: NetworkSegment, seed: u64) -> Vec<f64> {
    let result = run(RunRequest {
        scenario,
        segment,
        seed,
        capture_snapshots: false,
    });
    let m = result.metrics;
    vec![
        to_f64_for_display(m.divergence_mean),
        to_f64_for_display(m.divergence_p99),
        to_f64_for_display(m.divergence_max),
        f64::from(m.correction_count),
        to_f64_for_display(m.correction_magnitude_mean),
        to_f64_for_display(m.correction_magnitude_max),
        to_f64_for_display(m.input_latency_mean_ms),
        f64::from(m.packets_sent),
        f64::from(m.packets_dropped),
        f64::from(m.sampled_ticks),
        // the hash is split because a u64 does not survive an f64 intact
        f64::from((result.state_hash >> 32) as u32),
        f64::from(result.state_hash as u32),
    ]
}

/// Snapshots as a flat buffer of `SNAPSHOT_STRIDE`-value records.
pub fn snapshot_buffer(scenario: &Scenario, segment: NetworkSegment, seed: u64) -> Vec<f64> {
    let result = run(RunRequest {
        scenario,
        segment,
        seed,
        capture_snapshots: true,
    });
    let mut out = Vec::with_capacity(result.snapshots.len() * SNAPSHOT_STRIDE);
    for s in result.snapshots {
        out.push(f64::from(s.tick));
        out.push(to_f64_for_display(s.server.x));
        out.push(to_f64_for_display(s.server.y));
        out.push(to_f64_for_display(s.server.vx));
        out.push(to_f64_for_display(s.server.vy));
        out.push(to_f64_for_display(s.client.x));
        out.push(to_f64_for_display(s.client.y));
        out.push(to_f64_for_display(s.client.vx));
        out.push(to_f64_for_display(s.client.vy));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> BuildScenario {
        BuildScenario {
            tick_rate: 64,
            duration_ticks: 200,
            accel: 10,
            max_speed: 100,
            friction_permille: 1000,
            bounds: 1000,
            move_from_tick: 0,
            stop_at_tick: 0,
        }
    }

    #[test]
    fn metrics_buffer_has_the_declared_length() {
        let s = build_scenario(&spec());
        let buf = metrics_buffer(&s, NetworkSegment::perfect(), 1);
        assert_eq!(buf.len(), METRICS_LEN);
    }

    #[test]
    fn snapshot_buffer_is_a_whole_number_of_records() {
        let s = build_scenario(&spec());
        let buf = snapshot_buffer(&s, NetworkSegment::perfect(), 1);
        assert_eq!(buf.len() % SNAPSHOT_STRIDE, 0);
        assert_eq!(buf.len() / SNAPSHOT_STRIDE, 200);
    }

    #[test]
    fn split_hash_reassembles_to_the_original() {
        let s = build_scenario(&spec());
        let buf = metrics_buffer(&s, NetworkSegment::hostile(), 42);
        let high = buf[10] as u64;
        let low = buf[11] as u64;
        let rebuilt = (high << 32) | low;

        let direct = run(RunRequest {
            scenario: &s,
            segment: NetworkSegment::hostile(),
            seed: 42,
            capture_snapshots: false,
        });
        assert_eq!(rebuilt, direct.state_hash);
    }

    #[test]
    fn every_metric_is_finite_and_non_negative() {
        let s = build_scenario(&spec());
        for index in 0..7 {
            let buf = metrics_buffer(&s, segment_by_index(index), 5);
            for (i, v) in buf.iter().enumerate() {
                assert!(
                    v.is_finite(),
                    "field {i} was not finite for segment {index}"
                );
                assert!(*v >= 0.0, "field {i} was negative for segment {index}");
            }
        }
    }

    #[test]
    fn segment_index_saturates_to_hostile() {
        assert_eq!(segment_by_index(6), NetworkSegment::hostile());
        assert_eq!(segment_by_index(999), NetworkSegment::hostile());
        assert_eq!(SEGMENT_NAMES.len(), 7);
    }

    #[test]
    fn a_zero_tick_rate_is_clamped_rather_than_dividing_by_zero() {
        let s = build_scenario(&BuildScenario {
            tick_rate: 0,
            ..spec()
        });
        assert_eq!(s.tick_rate, 1);
        let buf = metrics_buffer(&s, NetworkSegment::perfect(), 1);
        assert_eq!(buf.len(), METRICS_LEN);
    }

    #[test]
    fn stop_input_is_only_added_when_it_follows_the_move() {
        let with_stop = build_scenario(&BuildScenario {
            stop_at_tick: 100,
            ..spec()
        });
        assert_eq!(with_stop.input_script.len(), 2);
        let without = build_scenario(&BuildScenario {
            stop_at_tick: 0,
            ..spec()
        });
        assert_eq!(without.input_script.len(), 1);
    }

    #[test]
    fn custom_segment_carries_its_fields() {
        let s = custom_segment(&CustomSegment {
            rtt_mean_ms: 120,
            rtt_jitter_ms: 30,
            loss_pct: 4,
            reorder_pct: 2,
            duplicate_pct: 1,
            burst_loss: true,
        });
        assert_eq!(s.rtt_mean_ms, 120);
        assert_eq!(s.loss_pct, 4);
        assert!(matches!(s.loss_model, LossModel::GilbertElliott { .. }));
    }
}
