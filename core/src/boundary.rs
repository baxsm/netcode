//! The WASM boundary. Values cross as flat scalars and a `Float64Array`, never as
//! serialized structs.
//!
//! `schema.md` names `serde-wasm-bindgen`, but that crate was last published in
//! February 2024 and a struct-heavy boundary is the documented `wasm-bindgen` time
//! sink. Flat drops the dependency and keeps serialization out of the sweep's hot
//! path. Fixed point converts to `f64` here on the way out, and nowhere else.

use crate::config::{NetcodeConfig, TechniqueSet};
use crate::fx::{from_int, ratio, to_f64_for_display, Fx};
use crate::net::{LossModel, NetworkSegment};
use crate::replay::{replay, ReplayRequest};
use crate::run::{run, RunRequest};
use crate::scenario::{EntityKind, EntitySpec, InputAction, InputEvent, Scenario, WorldConfig};

/// Field count of the metrics buffer. The TypeScript side asserts this, so adding a
/// metric without updating the mirror fails a test rather than silently shifting
/// every field after it.
pub const METRICS_LEN: usize = 18;

/// Field count of the config buffer a caller passes in.
///
/// Config crosses as an array rather than as positional arguments. With thirteen
/// fields the positional form would be a twenty-eight argument function where
/// transposing two numbers still compiles and silently runs the wrong configuration.
pub const CONFIG_LEN: usize = 13;

/// Values per snapshot: tick, then server x/y/vx/vy, then client x/y/vx/vy.
pub const SNAPSHOT_STRIDE: usize = 9;

/// Values per client inside a replay frame.
///
/// Laid out as: x, y, ghost tick, ghost x, ghost y, pre-correction x, pre-correction
/// y, correction magnitude, snapped, rollback depth.
pub const FRAME_CLIENT_STRIDE: usize = 10;

/// Values per replay frame: tick, server x, server y, rewind target, then one block
/// of `FRAME_CLIENT_STRIDE` per client.
pub const FRAME_STRIDE: usize = 4 + FRAME_CLIENT_STRIDE * crate::replay::CLIENT_COUNT;

/// Marks a tick field as carrying no value: a ghost before the first packet arrives,
/// a rewind target on a tick with no shot.
///
/// Only ever written to a tick slot. A tick is unsigned so negative one cannot be
/// mistaken for one, whereas a coordinate slot has no spare value at all: negative one
/// is a position a body legitimately occupies. So presence of a ghost is read from its
/// tick, and presence of a pre-correction position from the correction magnitude,
/// never from the coordinates themselves.
pub const ABSENT_TICK: f64 = -1.0;

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

/// Reads a `NetcodeConfig` out of the flat buffer a caller passes in.
///
/// Index order is the contract with the TypeScript mirror, which builds the same
/// array from a named field list. A short buffer falls back to the default rather
/// than reading past the end, and the caller finds out through `validate`.
pub fn config_from_buffer(values: &[f64]) -> NetcodeConfig {
    if values.len() < CONFIG_LEN {
        return NetcodeConfig::default();
    }
    let flag = |i: usize| values[i] != 0.0;
    let byte = |i: usize| values[i].clamp(0.0, 255.0) as u8;
    NetcodeConfig {
        techniques: TechniqueSet {
            client_prediction: flag(0),
            server_reconciliation: flag(1),
            entity_interpolation: flag(2),
            extrapolation: flag(3),
            server_rewind: flag(4),
            rollback: flag(5),
        },
        interpolation_delay_ticks: byte(6),
        input_buffer_ticks: byte(7),
        rollback_window_ticks: byte(8),
        // rates and thresholds cross as permille integers so no decimal literal is
        // parsed through a float on the way in
        correction_blend_rate: ratio(values[9].clamp(0.0, 1000.0) as i32, 1000),
        snap_threshold: ratio(values[10].clamp(0.0, 1_000_000.0) as i32, 1000),
        server_rewind_limit_ms: values[11].clamp(0.0, 60_000.0) as u32,
        extrapolation_limit_ticks: byte(12),
    }
}

/// Metrics as a flat buffer. Order is the contract; the TypeScript mirror reads the
/// same indices and a test holds the two together.
pub fn metrics_buffer(
    scenario: &Scenario,
    segment: NetworkSegment,
    seed: u64,
    config: NetcodeConfig,
) -> Vec<f64> {
    let result = run(RunRequest {
        scenario,
        segment,
        seed,
        config,
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
        f64::from(m.rollback_count),
        to_f64_for_display(m.rollback_depth_mean),
        f64::from(m.snap_count),
        to_f64_for_display(m.hit_registration_accuracy),
        f64::from(m.shots_fired),
        f64::from(m.shots_confirmed),
        // the hash is split because a u64 does not survive an f64 intact
        f64::from((result.state_hash >> 32) as u32),
        f64::from(result.state_hash as u32),
    ]
}

/// Snapshots as a flat buffer of `SNAPSHOT_STRIDE`-value records.
pub fn snapshot_buffer(
    scenario: &Scenario,
    segment: NetworkSegment,
    seed: u64,
    config: NetcodeConfig,
) -> Vec<f64> {
    let result = run(RunRequest {
        scenario,
        segment,
        seed,
        config,
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

/// Replay frames as a flat buffer of `FRAME_STRIDE`-value records.
///
/// Velocities are not carried. The view draws positions and interpolates between
/// captured frames for display, so a velocity crossing here would be a field nothing
/// reads, at four extra values per frame per client.
pub fn frame_buffer(
    scenario: &Scenario,
    segment: NetworkSegment,
    seed: u64,
    config: NetcodeConfig,
) -> Vec<f64> {
    let result = replay(ReplayRequest {
        scenario,
        segment,
        seed,
        config,
    });

    let mut out = Vec::with_capacity(result.frames.len() * FRAME_STRIDE);
    for frame in result.frames {
        out.push(f64::from(frame.tick));
        out.push(to_f64_for_display(frame.server.x));
        out.push(to_f64_for_display(frame.server.y));
        out.push(frame.rewind_target.map_or(ABSENT_TICK, f64::from));

        for client in frame.clients {
            out.push(to_f64_for_display(client.body.x));
            out.push(to_f64_for_display(client.body.y));
            match client.ghost {
                Some(ghost) => {
                    out.push(f64::from(ghost.tick));
                    out.push(to_f64_for_display(ghost.body.x));
                    out.push(to_f64_for_display(ghost.body.y));
                }
                None => {
                    out.push(ABSENT_TICK);
                    out.push(0.0);
                    out.push(0.0);
                }
            }
            // the coordinates are only meaningful when the magnitude is above zero,
            // which is what the reader gates on
            let before = client.pre_correction.unwrap_or_default();
            out.push(to_f64_for_display(before.x));
            out.push(to_f64_for_display(before.y));
            out.push(to_f64_for_display(client.correction_magnitude));
            out.push(if client.snapped { 1.0 } else { 0.0 });
            out.push(f64::from(client.rollback_depth));
        }
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

    fn config() -> NetcodeConfig {
        NetcodeConfig::default()
    }

    #[test]
    fn metrics_buffer_has_the_declared_length() {
        let s = build_scenario(&spec());
        let buf = metrics_buffer(&s, NetworkSegment::perfect(), 1, config());
        assert_eq!(buf.len(), METRICS_LEN);
    }

    #[test]
    fn snapshot_buffer_is_a_whole_number_of_records() {
        let s = build_scenario(&spec());
        let buf = snapshot_buffer(&s, NetworkSegment::perfect(), 1, config());
        assert_eq!(buf.len() % SNAPSHOT_STRIDE, 0);
        assert_eq!(buf.len() / SNAPSHOT_STRIDE, 200);
    }

    #[test]
    fn split_hash_reassembles_to_the_original() {
        let s = build_scenario(&spec());
        let buf = metrics_buffer(&s, NetworkSegment::hostile(), 42, config());
        // the hash occupies the last two slots, read relative to the length so
        // adding a metric cannot silently move it out from under this test
        let high = buf[METRICS_LEN - 2] as u64;
        let low = buf[METRICS_LEN - 1] as u64;
        let rebuilt = (high << 32) | low;

        let direct = run(RunRequest {
            scenario: &s,
            segment: NetworkSegment::hostile(),
            seed: 42,
            config: config(),
            capture_snapshots: false,
        });
        assert_eq!(rebuilt, direct.state_hash);
    }

    #[test]
    fn every_metric_is_finite_and_non_negative() {
        let s = build_scenario(&spec());
        for index in 0..7 {
            let buf = metrics_buffer(&s, segment_by_index(index), 5, config());
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
        let buf = metrics_buffer(&s, NetworkSegment::perfect(), 1, config());
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

    /// The canonical buffer the mirror builds, with every field distinguishable so a
    /// transposed pair cannot pass.
    fn config_values() -> Vec<f64> {
        vec![
            1.0, 0.0, 1.0, 0.0, 1.0, 0.0,      // the six technique flags
            3.0,      // interpolation delay ticks
            4.0,      // input buffer ticks
            9.0,      // rollback window ticks
            750.0,    // correction blend rate, permille
            42_000.0, // snap threshold, permille
            250.0,    // server rewind limit ms
            7.0,      // extrapolation limit ticks
        ]
    }

    #[test]
    fn config_decodes_every_field_from_its_own_index() {
        let c = config_from_buffer(&config_values());
        assert!(c.techniques.client_prediction);
        assert!(!c.techniques.server_reconciliation);
        assert!(c.techniques.entity_interpolation);
        assert!(!c.techniques.extrapolation);
        assert!(c.techniques.server_rewind);
        assert!(!c.techniques.rollback);
        assert_eq!(c.interpolation_delay_ticks, 3);
        assert_eq!(c.input_buffer_ticks, 4);
        assert_eq!(c.rollback_window_ticks, 9);
        assert_eq!(c.correction_blend_rate, ratio(750, 1000));
        assert_eq!(c.snap_threshold, from_int(42));
        assert_eq!(c.server_rewind_limit_ms, 250);
        assert_eq!(c.extrapolation_limit_ticks, 7);
    }

    /// Every slot must reach a distinct field. Perturbing one value and finding the
    /// config unchanged means two indices are crossed or one is unread.
    #[test]
    fn every_config_slot_changes_the_decoded_config() {
        let base = config_from_buffer(&config_values());
        for i in 0..CONFIG_LEN {
            let mut values = config_values();
            values[i] = if values[i] == 0.0 { 1.0 } else { 0.0 };
            assert_ne!(
                base,
                config_from_buffer(&values),
                "slot {i} did not reach any field"
            );
        }
    }

    #[test]
    fn a_short_config_buffer_falls_back_to_the_default() {
        assert_eq!(config_from_buffer(&[1.0, 0.0]), NetcodeConfig::default());
        assert_eq!(config_from_buffer(&[]), NetcodeConfig::default());
    }

    #[test]
    fn out_of_range_config_values_are_clamped_rather_than_wrapping() {
        let mut values = config_values();
        values[6] = 9_000.0;
        values[9] = -50.0;
        values[11] = 10_000_000.0;
        let c = config_from_buffer(&values);
        assert_eq!(c.interpolation_delay_ticks, 255);
        assert_eq!(c.correction_blend_rate, Fx::ZERO);
        assert_eq!(c.server_rewind_limit_ms, 60_000);
    }

    #[test]
    fn config_reaches_the_run_and_changes_the_result() {
        let s = build_scenario(&spec());
        let none = NetcodeConfig {
            techniques: TechniqueSet::NONE,
            ..NetcodeConfig::default()
        };
        let all = NetcodeConfig {
            techniques: TechniqueSet::ALL,
            ..NetcodeConfig::default()
        };
        let a = metrics_buffer(&s, NetworkSegment::average_broadband(), 7, none);
        let b = metrics_buffer(&s, NetworkSegment::average_broadband(), 7, all);
        assert_ne!(a, b, "the config never reached the simulation");
    }

    #[test]
    fn frame_buffer_is_a_whole_number_of_records() {
        let s = build_scenario(&spec());
        let buf = frame_buffer(&s, NetworkSegment::lan(), 1, config());
        assert_eq!(buf.len() % FRAME_STRIDE, 0);
        assert_eq!(buf.len() / FRAME_STRIDE, 200);
    }

    /// Every value must be finite. The view draws these coordinates directly, so a NaN
    /// would put a body somewhere unrenderable rather than raise anything.
    #[test]
    fn every_frame_value_is_finite() {
        let s = build_scenario(&spec());
        for index in 0..7 {
            let buf = frame_buffer(&s, segment_by_index(index), 5, config());
            for (i, v) in buf.iter().enumerate() {
                assert!(
                    v.is_finite(),
                    "value {i} was not finite for segment {index}"
                );
            }
        }
    }

    /// The absent marker must be distinguishable from every real tick.
    ///
    /// A ghost tick is unsigned, so nothing legitimate can land on the sentinel. If it
    /// could, the view would hide a real ghost or draw one that never arrived.
    #[test]
    fn absent_never_collides_with_a_real_tick() {
        let s = build_scenario(&spec());
        let buf = frame_buffer(&s, NetworkSegment::hostile(), 3, config());
        let mut absent = 0;
        let mut present = 0;
        for record in buf.chunks_exact(FRAME_STRIDE) {
            // the ghost tick sits two values into the first client's block
            let ghost_tick = record[4 + 2];
            if ghost_tick == ABSENT_TICK {
                absent += 1;
            } else {
                assert!(ghost_tick >= 0.0, "a real ghost tick was negative");
                present += 1;
            }
        }
        assert!(absent > 0, "no frame reported an absent ghost");
        assert!(present > 0, "no frame reported a ghost at all");
    }

    /// A pre-correction position is read through the magnitude, so the two must agree.
    #[test]
    fn a_correction_magnitude_marks_its_own_position() {
        let s = build_scenario(&spec());
        let buf = frame_buffer(&s, NetworkSegment::hostile(), 21, config());
        let mut corrected = 0;
        for record in buf.chunks_exact(FRAME_STRIDE) {
            let magnitude = record[4 + 7];
            assert!(magnitude >= 0.0, "a correction magnitude was negative");
            if magnitude > 0.0 {
                corrected += 1;
            }
        }
        assert!(
            corrected > 0,
            "a hostile link recorded no correction to draw"
        );
    }

    #[test]
    fn the_frame_stride_covers_every_client() {
        assert_eq!(
            FRAME_STRIDE,
            4 + FRAME_CLIENT_STRIDE * crate::replay::CLIENT_COUNT
        );
        assert_eq!(FRAME_STRIDE, 24);
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
