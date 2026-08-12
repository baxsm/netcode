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
use crate::sweep::{sweep, SweepRequest, WeightedSegment};

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

/// Values per sweep point: a full metrics record, then the two scores and the two
/// halves of the config hash.
///
/// `METRICS_LEN` already covers the aggregated metrics and the combined state hash,
/// so this builds on it rather than restating a number. Adding a metric moves the
/// scores along with it instead of shifting them out from under the reader.
pub const SWEEP_STRIDE: usize = METRICS_LEN + 4;

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

/// Radius of the controllable body, which is also the hit tolerance a shot is judged
/// against. One unit is what every scenario before authoring ran with, so it stays the
/// default rather than becoming a field callers must remember to send.
pub const DEFAULT_RADIUS: i32 = 1;

/// Field count of the scenario buffer, in the order `scenario_from_buffer` reads.
///
/// The scenario crosses as a buffer for the same reason the config does: passed
/// positionally it would push the run functions past twenty arguments, where
/// transposing two numbers still compiles and silently simulates something else.
pub const SCENARIO_LEN: usize = 8;

/// Reads a `BuildScenario` out of the flat buffer a caller passes in.
///
/// Index order is the contract with the TypeScript mirror, which builds the same array
/// from a named field list. A short buffer falls back to the shape the built-in
/// scenarios use rather than reading past the end.
pub fn scenario_from_buffer(values: &[f64]) -> BuildScenario {
    if values.len() < SCENARIO_LEN {
        return BuildScenario {
            tick_rate: 64,
            duration_ticks: 0,
            accel: 0,
            max_speed: 0,
            friction_permille: 1000,
            bounds: 0,
            move_from_tick: 0,
            stop_at_tick: 0,
        };
    }
    let tick = |i: usize| values[i].clamp(0.0, f64::from(u32::MAX)) as u32;
    BuildScenario {
        tick_rate: values[0].clamp(1.0, 1000.0) as u32,
        duration_ticks: values[1].clamp(0.0, 1_000_000.0) as u32,
        accel: values[2].clamp(-100_000.0, 100_000.0) as i32,
        max_speed: values[3].clamp(-100_000.0, 100_000.0) as i32,
        friction_permille: values[4].clamp(0.0, 1000.0) as u32,
        bounds: values[5].clamp(0.0, 1_000_000.0) as i32,
        move_from_tick: tick(6),
        stop_at_tick: tick(7),
    }
}

/// Writes a scenario into the flat layout `scenario_from_buffer` reads. The inverse of
/// that function, and asserted to round trip.
pub fn scenario_to_buffer(spec: &BuildScenario) -> Vec<f64> {
    vec![
        f64::from(spec.tick_rate),
        f64::from(spec.duration_ticks),
        f64::from(spec.accel),
        f64::from(spec.max_speed),
        f64::from(spec.friction_permille),
        f64::from(spec.bounds),
        f64::from(spec.move_from_tick),
        f64::from(spec.stop_at_tick),
    ]
}

/// Values per input event: tick, action tag, then the two direction components.
///
/// A direction is only read by `Move` and `Fire`, but it occupies its slots for `Stop`
/// as well. A variable-width record would make the reader depend on the tag it has not
/// parsed yet, and a misread tag would then shift every event after it.
pub const SCRIPT_STRIDE: usize = 4;

/// Action tags, matching the order of `InputAction`'s variants.
///
/// Numeric because the boundary carries no strings. An unknown tag becomes `Stop`
/// rather than being dropped, so a script from a newer format still runs a defined
/// input instead of silently losing a tick.
pub const ACTION_MOVE: f64 = 0.0;
pub const ACTION_FIRE: f64 = 1.0;
pub const ACTION_STOP: f64 = 2.0;

/// Directions cross as permille, matching every other rate on this boundary, so no
/// decimal literal is parsed through a float on the way into a fixed-point core.
fn script_from_buffer(values: &[f64]) -> Vec<InputEvent> {
    values
        .chunks_exact(SCRIPT_STRIDE)
        .map(|c| {
            let component = |v: f64| ratio(v.clamp(-1000.0, 1000.0) as i32, 1000);
            let (dx, dy) = (component(c[2]), component(c[3]));
            InputEvent {
                tick: c[0].clamp(0.0, f64::from(u32::MAX)) as u32,
                entity_id: 0,
                action: if c[1] == ACTION_MOVE {
                    InputAction::Move { dx, dy }
                } else if c[1] == ACTION_FIRE {
                    InputAction::Fire {
                        dir_x: dx,
                        dir_y: dy,
                    }
                } else {
                    InputAction::Stop
                },
            }
        })
        .collect()
}

/// The move-then-stop script every scenario ran before authoring existed.
///
/// Kept as the fallback for an empty script buffer, so every hash pinned in Phases 0
/// to 4 reproduces without the caller having to restate the script that produced it.
fn default_script(spec: &BuildScenario) -> Vec<InputEvent> {
    let mut script = vec![InputEvent {
        tick: spec.move_from_tick,
        entity_id: 0,
        action: InputAction::Move {
            dx: from_int(1),
            dy: Fx::ZERO,
        },
    }];
    if spec.stop_at_tick > spec.move_from_tick {
        script.push(InputEvent {
            tick: spec.stop_at_tick,
            entity_id: 0,
            action: InputAction::Stop,
        });
    }
    script
}

/// Builds the one-entity scenario, optionally with an authored input script.
///
/// The world holds a single controllable body, so a scenario carries one entity and
/// one script rather than a list of each. That is the simulation's actual shape, and
/// an editor offering more entities than it integrates would be reporting on bodies
/// that never moved.
pub fn build_scenario_with_script(spec: &BuildScenario, script: &[f64]) -> Scenario {
    let input_script = if script.len() < SCRIPT_STRIDE {
        default_script(spec)
    } else {
        script_from_buffer(script)
    };

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
            radius: from_int(DEFAULT_RADIUS),
        }],
        input_script,
    };
    scenario.sort_inputs();
    scenario
}

/// The scenario with its built-in move-then-stop script.
pub fn build_scenario(spec: &BuildScenario) -> Scenario {
    build_scenario_with_script(spec, &[])
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

/// Values per segment in the sweep's segment buffer: weight in permille, then the
/// six condition fields.
pub const SWEEP_SEGMENT_STRIDE: usize = 7;

/// Reads the weighted segments the sweep aggregates over.
///
/// Weights cross as permille integers, matching how every other rate crosses this
/// boundary, so no decimal literal is parsed through a float on the way in.
pub fn segments_from_buffer(values: &[f64]) -> Vec<WeightedSegment> {
    values
        .chunks_exact(SWEEP_SEGMENT_STRIDE)
        .map(|c| WeightedSegment {
            weight: ratio(c[0].clamp(0.0, 1_000_000.0) as i32, 1000),
            segment: custom_segment(&CustomSegment {
                rtt_mean_ms: c[1].clamp(0.0, 60_000.0) as u32,
                rtt_jitter_ms: c[2].clamp(0.0, 60_000.0) as u32,
                loss_pct: c[3].clamp(0.0, 100.0) as u32,
                reorder_pct: c[4].clamp(0.0, 100.0) as u32,
                duplicate_pct: c[5].clamp(0.0, 100.0) as u32,
                burst_loss: c[6] != 0.0,
            }),
        })
        .collect()
}

/// Writes a config into the flat layout `config_from_buffer` reads.
///
/// The inverse of that function, and asserted to round trip. Rates cross as permille
/// integers, so they are scaled back on the way out.
pub fn config_to_buffer(config: &NetcodeConfig) -> Vec<f64> {
    let permille = |v: Fx| (v * from_int(1000)).round().to_num::<i64>() as f64;
    let t = config.techniques;
    vec![
        f64::from(u8::from(t.client_prediction)),
        f64::from(u8::from(t.server_reconciliation)),
        f64::from(u8::from(t.entity_interpolation)),
        f64::from(u8::from(t.extrapolation)),
        f64::from(u8::from(t.server_rewind)),
        f64::from(u8::from(t.rollback)),
        f64::from(config.interpolation_delay_ticks),
        f64::from(config.input_buffer_ticks),
        f64::from(config.rollback_window_ticks),
        permille(config.correction_blend_rate),
        permille(config.snap_threshold),
        f64::from(config.server_rewind_limit_ms),
        f64::from(config.extrapolation_limit_ticks),
    ]
}

/// Reads a block of configurations laid end to end, each `CONFIG_LEN` values wide.
pub fn configs_from_buffer(values: &[f64]) -> Vec<NetcodeConfig> {
    values
        .chunks_exact(CONFIG_LEN)
        .map(config_from_buffer)
        .collect()
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

/// Writes one `Metrics` in the mirror's field order.
///
/// Shared by the single-run and sweep paths so the two cannot drift into writing the
/// same fields in a different order.
fn push_metrics(out: &mut Vec<f64>, m: &crate::run::Metrics) {
    out.push(to_f64_for_display(m.divergence_mean));
    out.push(to_f64_for_display(m.divergence_p99));
    out.push(to_f64_for_display(m.divergence_max));
    out.push(f64::from(m.correction_count));
    out.push(to_f64_for_display(m.correction_magnitude_mean));
    out.push(to_f64_for_display(m.correction_magnitude_max));
    out.push(to_f64_for_display(m.input_latency_mean_ms));
    out.push(f64::from(m.packets_sent));
    out.push(f64::from(m.packets_dropped));
    out.push(f64::from(m.sampled_ticks));
    out.push(f64::from(m.rollback_count));
    out.push(to_f64_for_display(m.rollback_depth_mean));
    out.push(f64::from(m.snap_count));
    out.push(to_f64_for_display(m.hit_registration_accuracy));
    out.push(f64::from(m.shots_fired));
    out.push(f64::from(m.shots_confirmed));
}

/// Splits a `u64` across two slots, since an `f64` cannot carry 64 bits intact.
fn push_hash(out: &mut Vec<f64>, hash: u64) {
    out.push(f64::from((hash >> 32) as u32));
    out.push(f64::from(hash as u32));
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
    let mut out = Vec::with_capacity(METRICS_LEN);
    push_metrics(&mut out, &result.metrics);
    push_hash(&mut out, result.state_hash);
    out
}

/// A block of the configuration grid, run against every seed and every weighted
/// segment, as a flat buffer of `SWEEP_STRIDE`-value records.
///
/// The caller passes many configurations in one call rather than one per call. A run
/// costs roughly 0.4 ms and a worker round trip costs about the same, so a sweep of
/// thousands would otherwise spend as long on messaging as on simulating.
pub fn sweep_buffer(
    scenario: &Scenario,
    configs: &[NetcodeConfig],
    segments: &[WeightedSegment],
    seeds: &[u64],
) -> Vec<f64> {
    let points = sweep(SweepRequest {
        scenario,
        configs,
        segments,
        seeds,
    });

    let mut out = Vec::with_capacity(points.len() * SWEEP_STRIDE);
    for point in points {
        push_metrics(&mut out, &point.aggregated);
        push_hash(&mut out, point.state_hash);
        out.push(to_f64_for_display(point.responsiveness_score));
        out.push(to_f64_for_display(point.smoothness_score));
        push_hash(&mut out, point.config_hash);
    }
    out
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
    fn a_config_survives_a_round_trip_through_the_buffer() {
        let original = NetcodeConfig::default();
        assert_eq!(config_from_buffer(&config_to_buffer(&original)), original);

        let tuned = NetcodeConfig {
            techniques: TechniqueSet::from_bits(0b010101),
            interpolation_delay_ticks: 7,
            input_buffer_ticks: 4,
            rollback_window_ticks: 12,
            correction_blend_rate: ratio(350, 1000),
            snap_threshold: ratio(8500, 1000),
            server_rewind_limit_ms: 275,
            extrapolation_limit_ticks: 9,
        };
        assert_eq!(config_from_buffer(&config_to_buffer(&tuned)), tuned);
    }

    #[test]
    fn the_encoded_default_has_the_declared_length() {
        assert_eq!(
            config_to_buffer(&NetcodeConfig::default()).len(),
            CONFIG_LEN
        );
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

    fn segment_values() -> Vec<f64> {
        // one segment at full weight, on an average-broadband-like link
        vec![1000.0, 60.0, 15.0, 1.0, 0.0, 0.0, 0.0]
    }

    #[test]
    fn the_sweep_buffer_is_a_whole_number_of_records() {
        let s = build_scenario(&spec());
        let configs = [NetcodeConfig::default(), NetcodeConfig::default()];
        let buf = sweep_buffer(
            &s,
            &configs,
            &segments_from_buffer(&segment_values()),
            &[1, 2],
        );
        assert_eq!(buf.len() % SWEEP_STRIDE, 0);
        assert_eq!(buf.len() / SWEEP_STRIDE, 2);
    }

    /// The stride must match what is actually written. A record that writes fewer
    /// values than it declares would shift every point after the first.
    #[test]
    fn the_declared_stride_matches_what_a_point_writes() {
        let s = build_scenario(&spec());
        let buf = sweep_buffer(
            &s,
            &[NetcodeConfig::default()],
            &segments_from_buffer(&segment_values()),
            &[1],
        );
        assert_eq!(buf.len(), SWEEP_STRIDE);
        assert_eq!(SWEEP_STRIDE, METRICS_LEN + 4);
    }

    /// The metrics inside a sweep point must sit at the same indices the single-run
    /// buffer uses, since the mirror decodes both with one reader.
    #[test]
    fn a_single_config_single_seed_point_matches_the_direct_run() {
        let s = build_scenario(&spec());
        let segment = custom_segment(&CustomSegment {
            rtt_mean_ms: 60,
            rtt_jitter_ms: 15,
            loss_pct: 1,
            reorder_pct: 0,
            duplicate_pct: 0,
            burst_loss: false,
        });
        let direct = metrics_buffer(&s, segment, 5, NetcodeConfig::default());
        let swept = sweep_buffer(
            &s,
            &[NetcodeConfig::default()],
            &segments_from_buffer(&segment_values()),
            &[5],
        );

        // one segment and one seed means the aggregate is the run itself, so every
        // metric must land identically. only the trailing scores differ
        assert_eq!(&swept[..METRICS_LEN - 2], &direct[..METRICS_LEN - 2]);
    }

    #[test]
    fn every_sweep_value_is_finite() {
        let s = build_scenario(&spec());
        let configs = [
            NetcodeConfig::default(),
            NetcodeConfig {
                techniques: TechniqueSet::NONE,
                ..NetcodeConfig::default()
            },
        ];
        let mut segments = segment_values();
        segments.extend([500.0, 200.0, 60.0, 8.0, 3.0, 2.0, 1.0]);

        let buf = sweep_buffer(&s, &configs, &segments_from_buffer(&segments), &[1, 2, 3]);
        for (i, v) in buf.iter().enumerate() {
            assert!(v.is_finite(), "value {i} was not finite");
        }
    }

    #[test]
    fn segments_decode_their_weight_and_conditions() {
        let decoded = segments_from_buffer(&[750.0, 120.0, 30.0, 4.0, 2.0, 1.0, 1.0]);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].weight, ratio(750, 1000));
        assert_eq!(decoded[0].segment.rtt_mean_ms, 120);
        assert_eq!(decoded[0].segment.loss_pct, 4);
        assert!(matches!(
            decoded[0].segment.loss_model,
            LossModel::GilbertElliott { .. }
        ));
    }

    /// A trailing partial record is dropped rather than read past the end or padded
    /// with zeros, which would invent a segment the caller never asked for.
    #[test]
    fn a_partial_segment_record_is_ignored() {
        assert_eq!(segments_from_buffer(&[1000.0, 60.0, 15.0]).len(), 0);
        assert_eq!(
            segments_from_buffer(&[1000.0, 60.0, 15.0, 1.0, 0.0, 0.0, 0.0, 500.0]).len(),
            1
        );
    }

    #[test]
    fn configs_decode_one_per_block() {
        let mut buf = config_values();
        buf.extend(config_values());
        let decoded = configs_from_buffer(&buf);
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0], decoded[1]);
        assert_eq!(decoded[0].interpolation_delay_ticks, 3);
    }

    #[test]
    fn a_scenario_survives_a_round_trip_through_the_buffer() {
        let original = spec();
        let decoded = scenario_from_buffer(&scenario_to_buffer(&original));
        assert_eq!(
            build_scenario(&decoded),
            build_scenario(&original),
            "a scenario changed shape crossing the buffer"
        );
        assert_eq!(scenario_to_buffer(&original).len(), SCENARIO_LEN);
    }

    /// Every slot must reach a distinct field. Perturbing one and finding the scenario
    /// unchanged means two indices are crossed or one is unread.
    #[test]
    fn every_scenario_slot_changes_the_built_scenario() {
        let values = scenario_to_buffer(&BuildScenario {
            stop_at_tick: 150,
            ..spec()
        });
        let base = build_scenario(&scenario_from_buffer(&values));
        for i in 0..SCENARIO_LEN {
            // both directions, because a field sitting on a clamp bound only moves one
            // way. friction is already at its ceiling and the move tick at its floor,
            // so a single-direction probe would read either as an unwired slot
            let moved = [1.0, -1.0].iter().any(|delta| {
                let mut perturbed = values.clone();
                perturbed[i] += delta;
                build_scenario(&scenario_from_buffer(&perturbed)) != base
            });
            assert!(moved, "slot {i} did not reach any field");
        }
    }

    #[test]
    fn a_short_scenario_buffer_does_not_read_past_the_end() {
        let s = build_scenario(&scenario_from_buffer(&[64.0, 200.0]));
        assert_eq!(s.tick_rate, 64);
        assert_eq!(s.duration_ticks, 0);
    }

    /// An empty script buffer must reproduce the built-in script exactly, since every
    /// hash pinned before authoring existed was produced by it.
    #[test]
    fn an_empty_script_falls_back_to_the_built_in_one() {
        let spec = BuildScenario {
            stop_at_tick: 120,
            ..spec()
        };
        assert_eq!(
            build_scenario_with_script(&spec, &[]),
            build_scenario(&spec)
        );
        // a partial record cannot describe an event, so it is treated as no script
        // rather than read past the end or padded into an input nobody wrote
        assert_eq!(
            build_scenario_with_script(&spec, &[10.0, ACTION_STOP, 0.0]),
            build_scenario(&spec)
        );
    }

    #[test]
    fn a_script_decodes_each_action_from_its_tag() {
        let s = build_scenario_with_script(
            &spec(),
            &[
                5.0,
                ACTION_MOVE,
                1000.0,
                -500.0,
                40.0,
                ACTION_FIRE,
                0.0,
                1000.0,
                80.0,
                ACTION_STOP,
                0.0,
                0.0,
            ],
        );
        assert_eq!(
            s.input_script,
            vec![
                InputEvent {
                    tick: 5,
                    entity_id: 0,
                    action: InputAction::Move {
                        dx: from_int(1),
                        dy: ratio(-500, 1000),
                    },
                },
                InputEvent {
                    tick: 40,
                    entity_id: 0,
                    action: InputAction::Fire {
                        dir_x: Fx::ZERO,
                        dir_y: from_int(1),
                    },
                },
                InputEvent {
                    tick: 80,
                    entity_id: 0,
                    action: InputAction::Stop,
                },
            ]
        );
    }

    /// Events must apply at their scheduled tick regardless of the order they arrive,
    /// which is what `Sim` relies on when it walks the script with a cursor.
    #[test]
    fn an_out_of_order_script_is_sorted_by_tick() {
        let s = build_scenario_with_script(
            &spec(),
            &[
                90.0,
                ACTION_STOP,
                0.0,
                0.0,
                10.0,
                ACTION_MOVE,
                1000.0,
                0.0,
                50.0,
                ACTION_FIRE,
                1000.0,
                0.0,
            ],
        );
        let ticks: Vec<u32> = s.input_script.iter().map(|e| e.tick).collect();
        assert_eq!(ticks, vec![10, 50, 90]);
    }

    /// An unrecognised tag must still produce a defined input. Dropping the event
    /// instead would leave the body holding whatever it was doing, which reads as the
    /// script working rather than as an event that was never understood.
    #[test]
    fn an_unknown_action_tag_becomes_stop() {
        let s = build_scenario_with_script(&spec(), &[3.0, 99.0, 1000.0, 1000.0]);
        assert_eq!(s.input_script[0].action, InputAction::Stop);
    }

    /// A shot must reach the run and be counted, otherwise the rewind limit has
    /// nothing to act on and the constant stays the no-op Phase 4 found it to be.
    #[test]
    fn an_authored_shot_reaches_the_run() {
        let spec = BuildScenario {
            duration_ticks: 200,
            ..spec()
        };
        let script = [
            0.0,
            ACTION_MOVE,
            1000.0,
            0.0,
            // after the warmup window, since a shot inside it is not counted
            120.0,
            ACTION_FIRE,
            1000.0,
            0.0,
        ];
        let s = build_scenario_with_script(&spec, &script);
        let buf = metrics_buffer(&s, NetworkSegment::average_broadband(), 7, config());
        // shots fired sits two from the end, ahead of the two hash halves
        assert_eq!(buf[METRICS_LEN - 4], 1.0, "the authored shot never fired");
    }

    /// The rewind limit only means something once a shot exists. Phase 4 held it out
    /// of the sweep for exactly this reason, so the effect is asserted rather than
    /// assumed before the constant goes back on an axis.
    #[test]
    fn the_rewind_limit_changes_a_shot_outcome() {
        let spec = BuildScenario {
            duration_ticks: 300,
            ..spec()
        };
        let mut script = vec![0.0, ACTION_MOVE, 1000.0, 0.0];
        for tick in (100..300).step_by(10) {
            script.extend([f64::from(tick), ACTION_FIRE, 1000.0, 0.0]);
        }
        let s = build_scenario_with_script(&spec, &script);

        let confirmed = |limit_ms: u32| {
            let buf = metrics_buffer(
                &s,
                NetworkSegment::transcontinental(),
                11,
                NetcodeConfig {
                    server_rewind_limit_ms: limit_ms,
                    ..NetcodeConfig::default()
                },
            );
            buf[METRICS_LEN - 3]
        };

        assert_ne!(
            confirmed(0),
            confirmed(400),
            "the rewind limit did not change how many shots the server confirmed"
        );
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
