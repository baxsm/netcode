//! One seeded run: a server and a client simulating the same scenario across a
//! network, and the metrics that come out of it.
//!
//! The techniques in `techniques.rs` are composed here. Which of them are active is
//! `NetcodeConfig`, so the same loop produces both the uncompensated baseline and a
//! fully compensated run, and the two are therefore comparable.
//!
//! Ordering inside the tick is a correctness question, not a style one. Metrics are
//! sampled before corrections are applied, because a correction erases the error it
//! is correcting and sampling after it would report a smoother client than the player
//! actually saw.

use crate::config::NetcodeConfig;
use crate::fx::{clamp, sqrt, to_bits, Fx};
use crate::hash::Hasher;
use crate::net::{Link, NetworkSegment, PacketPayload};
use crate::rng::Rng64;
use crate::scenario::{InputAction, Scenario};
use crate::techniques::{
    apply_correction, extrapolate, interpolate, rewind_limit_ticks, rewind_target_tick,
    InputHistory, PendingInput, StateBuffer, StateSample,
};

/// Ticks skipped before metrics accumulate. The first packets are still in flight,
/// so divergence in this window is meaningless rather than large, and including it
/// would compress the differences between configurations.
pub const WARMUP_TICKS: u32 = 32;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Body {
    pub x: Fx,
    pub y: Fx,
    pub vx: Fx,
    pub vy: Fx,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Metrics {
    pub divergence_mean: Fx,
    pub divergence_p99: Fx,
    pub divergence_max: Fx,
    pub correction_count: u32,
    pub correction_magnitude_mean: Fx,
    pub correction_magnitude_max: Fx,
    pub input_latency_mean_ms: Fx,
    pub packets_sent: u32,
    pub packets_dropped: u32,
    pub sampled_ticks: u32,
    pub rollback_count: u32,
    pub rollback_depth_mean: Fx,
    pub snap_count: u32,
    /// Shots the client predicted as hits that the server confirmed, over all shots
    /// fired. One when nothing was fired, since no shot was mis-registered.
    pub hit_registration_accuracy: Fx,
    pub shots_fired: u32,
    pub shots_confirmed: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Snapshot {
    pub tick: u32,
    pub server: Body,
    pub client: Body,
}

pub struct RunResult {
    pub seed: u64,
    pub config_hash: u64,
    pub state_hash: u64,
    pub metrics: Metrics,
    pub snapshots: Vec<Snapshot>,
}

/// A world of one controllable body. Phase 2 widens this; keeping it to one entity
/// here keeps the divergence measurement unambiguous.
struct Sim {
    body: Body,
    accel: Fx,
    max_speed: Fx,
    bounds_x: Fx,
    bounds_y: Fx,
    friction: Fx,
}

impl Sim {
    fn from_scenario(s: &Scenario) -> Self {
        let spec = s.entities.first();
        Self {
            body: Body {
                x: spec.map_or(Fx::ZERO, |e| e.start_x),
                y: spec.map_or(Fx::ZERO, |e| e.start_y),
                vx: Fx::ZERO,
                vy: Fx::ZERO,
            },
            accel: spec.map_or(Fx::ZERO, |e| e.accel),
            max_speed: spec.map_or(Fx::ZERO, |e| e.max_speed),
            bounds_x: s.world.bounds_x,
            bounds_y: s.world.bounds_y,
            friction: s.world.friction,
        }
    }

    /// One fixed step. `dt` comes from the scenario's tick rate, never a constant.
    fn step(&mut self, dt: Fx, input: Option<(Fx, Fx)>) {
        if let Some((dx, dy)) = input {
            self.body.vx += dx * self.accel * dt;
            self.body.vy += dy * self.accel * dt;
        }

        self.body.vx *= self.friction;
        self.body.vy *= self.friction;

        let speed_sq = self.body.vx * self.body.vx + self.body.vy * self.body.vy;
        let max_sq = self.max_speed * self.max_speed;
        if self.max_speed > Fx::ZERO && speed_sq > max_sq {
            let speed = sqrt(speed_sq);
            if speed > Fx::ZERO {
                self.body.vx = self.body.vx / speed * self.max_speed;
                self.body.vy = self.body.vy / speed * self.max_speed;
            }
        }

        self.body.x += self.body.vx * dt;
        self.body.y += self.body.vy * dt;

        if self.body.x < -self.bounds_x || self.body.x > self.bounds_x {
            self.body.vx = -self.body.vx;
            self.body.x = clamp(self.body.x, -self.bounds_x, self.bounds_x);
        }
        if self.body.y < -self.bounds_y || self.body.y > self.bounds_y {
            self.body.vy = -self.body.vy;
            self.body.y = clamp(self.body.y, -self.bounds_y, self.bounds_y);
        }
    }
}

fn distance(a: Body, b: Body) -> Fx {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    sqrt(dx * dx + dy * dy)
}

pub struct RunRequest<'a> {
    pub scenario: &'a Scenario,
    pub segment: NetworkSegment,
    pub seed: u64,
    pub config: NetcodeConfig,
    pub capture_snapshots: bool,
}

/// Runs one seeded simulation to completion.
///
/// The tick body runs in a fixed order, and the order is load bearing:
/// read input, predict, send, receive, step the server, sample metrics, then correct.
/// Sampling sits ahead of correction on purpose. See the module comment.
pub fn run(request: RunRequest<'_>) -> RunResult {
    let scenario = request.scenario;
    let config = request.config;
    let techniques = config.techniques;
    let dt = scenario.tick_interval_ms() / crate::fx::from_int(1000);
    let tick_ms = scenario.tick_interval_ms();
    let rewind_ticks = rewind_limit_ticks(config.server_rewind_limit_ms, tick_ms);

    let mut rng = Rng64::from_seed(request.seed);
    let mut server = Sim::from_scenario(scenario);
    let mut client = Sim::from_scenario(scenario);

    let mut to_server = Link::new(request.segment);
    let mut to_client = Link::new(request.segment);

    let mut snapshots = Vec::new();
    if request.capture_snapshots {
        snapshots.reserve(scenario.duration_ticks as usize + 1);
    }

    let mut divergences: Vec<Fx> = Vec::new();
    let mut corrections: Vec<Fx> = Vec::new();
    let mut rollback_depths: Vec<Fx> = Vec::new();
    let mut latency_total_ms = Fx::ZERO;
    let mut latency_count: u32 = 0;
    let mut snap_count: u32 = 0;
    let mut shots_fired: u32 = 0;
    let mut shots_confirmed: u32 = 0;

    let mut history = InputHistory::new();
    let mut received_states = StateBuffer::new();
    let mut server_history = StateBuffer::new();

    // the input the server applies when the client's update has not arrived. Riot
    // documents repeating the last received input, and without it divergence under
    // loss reads lower than it really is
    let mut server_last_input: Option<(Fx, Fx)> = None;
    let mut server_last_sequence: u32 = 0;

    // the script is walked with a cursor rather than searched, so an input applies at
    // its scheduled tick and never at the tick it happens to be read
    let mut cursor = 0usize;
    let mut held: Option<(Fx, Fx)> = None;

    for tick in 0..scenario.duration_ticks {
        let mut fired_this_tick = false;
        while cursor < scenario.input_script.len() {
            let event = scenario.input_script[cursor];
            if event.tick != tick {
                break;
            }
            held = match event.action {
                InputAction::Move { dx, dy } => Some((dx, dy)),
                InputAction::Stop => None,
                InputAction::Fire { .. } => {
                    fired_this_tick = true;
                    held
                }
            };
            cursor += 1;
        }

        // client-side prediction: apply local input immediately rather than waiting
        // for the server to confirm it. without it the client only moves when
        // authoritative state arrives, which is the full round trip of input lag
        if techniques.client_prediction {
            client.step(dt, Some(held.unwrap_or((Fx::ZERO, Fx::ZERO))));
        }

        // an input is sent every tick, including a released one as an explicit zero.
        // going silent instead would be indistinguishable from a lost packet, and the
        // server's input prediction would then repeat the last movement forever and
        // accelerate a body the player had already stopped
        // one input per tick, so the sequence is the tick offset by one. starting at
        // 1 keeps 0 available as "nothing acknowledged yet"
        let sequence = tick + 1;
        let (dx, dy) = held.unwrap_or((Fx::ZERO, Fx::ZERO));
        if techniques.client_prediction {
            history.push(PendingInput {
                sequence,
                tick,
                dx,
                dy,
            });
        }
        to_server.send(
            &mut rng,
            tick,
            tick_ms,
            PacketPayload::Input {
                entity_id: 0,
                dx,
                dy,
                input_tick: tick,
                sequence,
            },
        );

        // every input that arrived is applied, not just the newest.
        //
        // Keeping only the last one while still advancing the acknowledgement past
        // all of them would have the server claim inputs it never simulated. The
        // client then trims those from its history and never replays them, so the
        // reconciled state stays permanently short of motion. That is the
        // "replaying against the wrong starting state" failure mode, and it reads as
        // a client that slowly falls behind rather than as an error.
        let mut arrived: Vec<(Fx, Fx)> = Vec::new();
        for packet in to_server.receive(tick) {
            if let PacketPayload::Input {
                dx,
                dy,
                input_tick,
                sequence,
                ..
            } = packet.payload
            {
                // a duplicate carries a sequence already applied, so it must not
                // advance the acknowledgement or be counted as fresh input
                if sequence <= server_last_sequence {
                    continue;
                }
                arrived.push((dx, dy));
                server_last_sequence = sequence;
                latency_total_ms += Fx::from_num(tick.saturating_sub(input_tick)) * tick_ms;
                latency_count += 1;
            }
        }

        if arrived.is_empty() {
            // server-side input prediction: repeat the last received input when
            // nothing arrived in time, exactly as Riot documents
            server.step(dt, server_last_input);
        } else {
            if let Some(last) = arrived.last() {
                server_last_input = Some(*last);
            }
            for input in &arrived {
                server.step(dt, Some(*input));
            }
        }
        server_history.insert(StateSample {
            tick,
            body: server.body,
        });

        to_client.send(
            &mut rng,
            tick,
            tick_ms,
            PacketPayload::State {
                entity_id: 0,
                x: server.body.x,
                y: server.body.y,
                vx: server.body.vx,
                vy: server.body.vy,
                server_tick: tick,
                last_input_sequence: server_last_sequence,
            },
        );

        // server rewind: resolve the shot against the world the firing client was
        // looking at, bounded so high latency cannot rewind arbitrarily far
        if fired_this_tick && tick >= WARMUP_TICKS {
            shots_fired += 1;
            if techniques.server_rewind {
                let viewed = received_states.latest().map_or(tick, |s| s.tick);
                let target = rewind_target_tick(tick, viewed, rewind_ticks);
                if let Some(at) = server_history.at_or_before(target) {
                    if distance(at.body, client.body) <= scenario.hit_tolerance() {
                        shots_confirmed += 1;
                    }
                }
            } else if distance(server.body, client.body) <= scenario.hit_tolerance() {
                shots_confirmed += 1;
            }
        }

        let mut newest: Option<StateSample> = None;
        let mut acknowledged: Option<u32> = None;
        for packet in to_client.receive(tick) {
            if let PacketPayload::State {
                x,
                y,
                vx,
                vy,
                server_tick,
                last_input_sequence,
                ..
            } = packet.payload
            {
                let sample = StateSample {
                    tick: server_tick,
                    body: Body { x, y, vx, vy },
                };
                received_states.insert(sample);
                // a reordered packet can arrive after a newer one, so the newest
                // sample wins rather than the last one read
                if newest.is_none_or(|n| server_tick > n.tick) {
                    newest = Some(sample);
                    acknowledged = Some(last_input_sequence);
                }
            }
        }

        // metrics are sampled here, before any correction moves the client. a
        // correction erases the error it corrects, so sampling after it would report
        // a client that never drifted
        if tick >= WARMUP_TICKS {
            divergences.push(distance(server.body, client.body));
        }

        if request.capture_snapshots {
            snapshots.push(Snapshot {
                tick,
                server: server.body,
                client: client.body,
            });
        }

        if let (Some(sample), Some(ack)) = (newest, acknowledged) {
            let gap = distance(client.body, sample.body);

            if techniques.server_reconciliation {
                history.acknowledge(ack);

                // replay starts from the authoritative state, never from the current
                // predicted one. starting from the prediction looks almost right at
                // low latency and falls apart exactly where it matters
                let mut replay = Sim::from_scenario(scenario);
                replay.body = sample.body;
                let pending = history.pending().to_vec();

                if techniques.rollback && !pending.is_empty() {
                    let depth =
                        (tick.saturating_sub(sample.tick)).min(config.rollback_window_ticks as u32);
                    if depth > 0 {
                        rollback_depths.push(Fx::from_num(depth));
                    }
                }

                // only inputs the server has not seen are replayed. replaying one too
                // many double-applies an input the authoritative state already holds
                for input in &pending {
                    replay.step(dt, Some((input.dx, input.dy)));
                }
                let outcome = apply_correction(
                    client.body,
                    replay.body,
                    config.correction_blend_rate,
                    config.snap_threshold,
                );
                if tick >= WARMUP_TICKS && gap > Fx::ZERO {
                    corrections.push(outcome.magnitude);
                    if outcome.snapped {
                        snap_count += 1;
                    }
                }
                client.body = outcome.body;
            } else if tick >= WARMUP_TICKS && gap > Fx::ZERO {
                // without reconciliation the drift is recorded but never acted on,
                // which is the baseline this phase has to beat
                corrections.push(gap);
            }

            // without prediction the client has no simulation of its own, so it shows
            // whatever the server last told it
            if !techniques.client_prediction {
                client.body = render_body(&techniques, &received_states, sample, tick, dt, &config);
            }
        }
    }

    let metrics = Metrics {
        divergence_mean: mean(&divergences),
        divergence_p99: percentile(&mut divergences.clone(), 99),
        divergence_max: max_of(&divergences),
        correction_count: corrections.len() as u32,
        correction_magnitude_mean: mean(&corrections),
        correction_magnitude_max: max_of(&corrections),
        input_latency_mean_ms: if latency_count == 0 {
            Fx::ZERO
        } else {
            latency_total_ms / Fx::from_num(latency_count)
        },
        packets_sent: to_server.sent_count() + to_client.sent_count(),
        packets_dropped: to_server.dropped_count() + to_client.dropped_count(),
        sampled_ticks: divergences.len() as u32,
        rollback_count: rollback_depths.len() as u32,
        rollback_depth_mean: mean(&rollback_depths),
        snap_count,
        hit_registration_accuracy: if shots_fired == 0 {
            Fx::from_num(1)
        } else {
            Fx::from_num(shots_confirmed) / Fx::from_num(shots_fired)
        },
        shots_fired,
        shots_confirmed,
    };

    let mut h = Hasher::new();
    scenario.hash_into(&mut h);
    config.hash_into(&mut h);
    h.write_u64(request.seed);
    for body in [server.body, client.body] {
        h.write_i64(to_bits(body.x));
        h.write_i64(to_bits(body.y));
        h.write_i64(to_bits(body.vx));
        h.write_i64(to_bits(body.vy));
    }

    RunResult {
        seed: request.seed,
        config_hash: config.config_hash(),
        state_hash: h.finish(),
        metrics,
        snapshots,
    }
}

/// What a client with no local simulation draws.
///
/// Interpolation renders `interpolation_delay_ticks` in the past between two
/// authoritative states, which is smooth but behind. When the buffer does not reach
/// that far back, extrapolation projects forward from the newest state instead. With
/// neither enabled the newest state is drawn as-is, which is the popping the two
/// techniques exist to remove.
fn render_body(
    techniques: &crate::config::TechniqueSet,
    received: &StateBuffer,
    newest: StateSample,
    tick: u32,
    dt: Fx,
    config: &NetcodeConfig,
) -> Body {
    if techniques.entity_interpolation {
        let render_tick = tick.saturating_sub(config.interpolation_delay_ticks as u32);
        if let Some((a, b)) = received.straddling(render_tick) {
            return interpolate(a, b, render_tick);
        }
    }
    if techniques.extrapolation {
        return extrapolate(newest, tick, dt, config.extrapolation_limit_ticks);
    }
    newest.body
}

fn max_of(values: &[Fx]) -> Fx {
    values
        .iter()
        .copied()
        .fold(Fx::ZERO, |a, b| if b > a { b } else { a })
}

fn mean(values: &[Fx]) -> Fx {
    if values.is_empty() {
        return Fx::ZERO;
    }
    let mut total = Fx::ZERO;
    for v in values {
        total += *v;
    }
    total / Fx::from_num(values.len() as u32)
}

/// Nearest-rank percentile. No interpolation, so the result is always an observed
/// value and cannot drift through a division.
fn percentile(values: &mut [Fx], p: u32) -> Fx {
    if values.is_empty() {
        return Fx::ZERO;
    }
    values.sort_by(|a, b| a.partial_cmp(b).expect("fixed point never produces NaN"));
    let rank = ((values.len() as u64 * p as u64).div_ceil(100) as usize).max(1);
    values[rank.min(values.len()) - 1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{TechniqueSet, TECHNIQUE_COMBINATIONS};
    use crate::fx::{abs, from_int, ratio, to_f64_for_display};
    use crate::net::LossModel;
    use crate::scenario::{EntityKind, EntitySpec, InputEvent, WorldConfig};

    fn moving_scenario(tick_rate: u32, ticks: u32) -> Scenario {
        Scenario {
            tick_rate,
            duration_ticks: ticks,
            world: WorldConfig {
                bounds_x: from_int(1000),
                bounds_y: from_int(1000),
                friction: from_int(1),
                gravity: Fx::ZERO,
            },
            entities: vec![EntitySpec {
                id: 0,
                kind: EntityKind::Player,
                start_x: Fx::ZERO,
                start_y: Fx::ZERO,
                max_speed: from_int(100),
                accel: from_int(10),
                radius: from_int(1),
            }],
            input_script: vec![InputEvent {
                tick: 0,
                entity_id: 0,
                action: InputAction::Move {
                    dx: from_int(1),
                    dy: Fx::ZERO,
                },
            }],
        }
    }

    /// No techniques enabled. These tests were written against the uncompensated
    /// baseline and must keep measuring it, so enabling anything here would quietly
    /// change what they assert.
    fn baseline_config() -> NetcodeConfig {
        NetcodeConfig {
            techniques: TechniqueSet::NONE,
            ..NetcodeConfig::default()
        }
    }

    fn run_with(segment: NetworkSegment, seed: u64) -> RunResult {
        let scenario = moving_scenario(64, 400);
        run(RunRequest {
            scenario: &scenario,
            segment,
            seed,
            config: baseline_config(),
            capture_snapshots: false,
        })
    }

    fn run_config(
        scenario: &Scenario,
        segment: NetworkSegment,
        seed: u64,
        config: NetcodeConfig,
    ) -> RunResult {
        run(RunRequest {
            scenario,
            segment,
            seed,
            config,
            capture_snapshots: true,
        })
    }

    /// The analytic case the phase doc asks for. With no friction, no speed cap and a
    /// constant unit input, velocity after n ticks is exactly `n * accel * dt`, which
    /// is checkable by hand rather than against another run.
    #[test]
    fn constant_input_reaches_hand_computed_velocity() {
        let mut sim = Sim {
            body: Body::default(),
            accel: from_int(10),
            max_speed: Fx::ZERO,
            bounds_x: from_int(100000),
            bounds_y: from_int(100000),
            friction: from_int(1),
        };
        let dt = ratio(1, 64);
        for _ in 0..64 {
            sim.step(dt, Some((from_int(1), Fx::ZERO)));
        }
        // 64 steps of 10 * (1/64) is exactly 10
        assert_eq!(sim.body.vx, from_int(10));
    }

    #[test]
    fn position_after_constant_velocity_is_exact() {
        let mut sim = Sim {
            body: Body {
                vx: from_int(8),
                ..Default::default()
            },
            accel: Fx::ZERO,
            max_speed: Fx::ZERO,
            bounds_x: from_int(100000),
            bounds_y: from_int(100000),
            friction: from_int(1),
        };
        let dt = ratio(1, 64);
        for _ in 0..64 {
            sim.step(dt, None);
        }
        // 64 steps of 8 * (1/64) is exactly 8
        assert_eq!(sim.body.x, from_int(8));
    }

    #[test]
    fn tick_rate_changes_the_step_size() {
        // the same wall-clock second at two rates must land at the same velocity, which
        // fails if any code path hardcodes a rate
        let mut fast = Sim {
            body: Body::default(),
            accel: from_int(10),
            max_speed: Fx::ZERO,
            bounds_x: from_int(100000),
            bounds_y: from_int(100000),
            friction: from_int(1),
        };
        let mut slow = Sim { ..fast };
        for _ in 0..128 {
            fast.step(ratio(1, 128), Some((from_int(1), Fx::ZERO)));
        }
        for _ in 0..64 {
            slow.step(ratio(1, 64), Some((from_int(1), Fx::ZERO)));
        }
        assert_eq!(fast.body.vx, slow.body.vx);
    }

    #[test]
    fn perfect_network_keeps_client_and_server_together() {
        let result = run_with(NetworkSegment::perfect(), 42);
        assert_eq!(result.metrics.packets_dropped, 0);
        // a zero-latency link still costs one tick of transit, so the gap is bounded
        // rather than zero. anything larger means the sims disagree structurally
        assert!(
            to_f64_for_display(result.metrics.divergence_max) < 1.0,
            "divergence {} on a perfect link",
            to_f64_for_display(result.metrics.divergence_max)
        );
    }

    #[test]
    fn adverse_network_diverges_more_than_a_clean_one() {
        let clean = run_with(NetworkSegment::lan(), 7);
        let bad = run_with(NetworkSegment::hostile(), 7);
        assert!(
            bad.metrics.divergence_mean > clean.metrics.divergence_mean,
            "hostile {} did not exceed lan {}",
            to_f64_for_display(bad.metrics.divergence_mean),
            to_f64_for_display(clean.metrics.divergence_mean)
        );
    }

    #[test]
    fn latency_raises_measured_input_latency() {
        let near = run_with(NetworkSegment::lan(), 3);
        let far = run_with(NetworkSegment::transcontinental(), 3);
        assert!(
            far.metrics.input_latency_mean_ms > near.metrics.input_latency_mean_ms,
            "transcontinental {} did not exceed lan {}",
            to_f64_for_display(far.metrics.input_latency_mean_ms),
            to_f64_for_display(near.metrics.input_latency_mean_ms)
        );
    }

    #[test]
    fn same_seed_reproduces_the_run() {
        let a = run_with(NetworkSegment::hostile(), 123);
        let b = run_with(NetworkSegment::hostile(), 123);
        assert_eq!(a.state_hash, b.state_hash);
        assert_eq!(a.metrics, b.metrics);
    }

    #[test]
    fn different_seeds_produce_different_runs() {
        let a = run_with(NetworkSegment::hostile(), 1);
        let b = run_with(NetworkSegment::hostile(), 2);
        assert_ne!(a.state_hash, b.state_hash);
    }

    #[test]
    fn warmup_ticks_are_excluded_from_metrics() {
        let scenario = moving_scenario(64, 100);
        let result = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 5,
            config: baseline_config(),
            capture_snapshots: false,
        });
        assert_eq!(result.metrics.sampled_ticks, 100 - WARMUP_TICKS);
    }

    #[test]
    fn a_run_shorter_than_warmup_reports_no_samples() {
        let scenario = moving_scenario(64, 10);
        let result = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 5,
            config: baseline_config(),
            capture_snapshots: false,
        });
        assert_eq!(result.metrics.sampled_ticks, 0);
        assert_eq!(result.metrics.divergence_mean, Fx::ZERO);
        assert_eq!(result.metrics.divergence_p99, Fx::ZERO);
    }

    #[test]
    fn snapshots_are_captured_only_when_asked() {
        let scenario = moving_scenario(64, 50);
        let off = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 5,
            config: baseline_config(),
            capture_snapshots: false,
        });
        let on = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 5,
            config: baseline_config(),
            capture_snapshots: true,
        });
        assert!(off.snapshots.is_empty());
        assert_eq!(on.snapshots.len(), 50);
        // capturing must not change the simulation
        assert_eq!(off.state_hash, on.state_hash);
    }

    #[test]
    fn scenario_identity_is_part_of_the_hash() {
        let a = moving_scenario(64, 200);
        let b = moving_scenario(128, 200);
        let ra = run(RunRequest {
            scenario: &a,
            segment: NetworkSegment::perfect(),
            seed: 9,
            config: baseline_config(),
            capture_snapshots: false,
        });
        let rb = run(RunRequest {
            scenario: &b,
            segment: NetworkSegment::perfect(),
            seed: 9,
            config: baseline_config(),
            capture_snapshots: false,
        });
        assert_ne!(ra.state_hash, rb.state_hash);
    }

    #[test]
    fn percentile_picks_observed_values() {
        let mut v: Vec<Fx> = (1..=100).map(from_int).collect();
        assert_eq!(percentile(&mut v, 100), from_int(100));
        assert_eq!(percentile(&mut v, 50), from_int(50));
        assert_eq!(percentile(&mut v, 1), from_int(1));
        assert_eq!(percentile(&mut [], 99), Fx::ZERO);
    }

    #[test]
    fn p99_never_exceeds_max() {
        let result = run_with(NetworkSegment::hostile(), 77);
        assert!(result.metrics.divergence_p99 <= result.metrics.divergence_max);
    }

    #[test]
    fn packets_dropped_never_exceeds_sent() {
        let result = run_with(NetworkSegment::hostile(), 31);
        assert!(result.metrics.packets_dropped <= result.metrics.packets_sent);
    }

    #[test]
    fn no_loss_means_no_drops() {
        let result = run_with(NetworkSegment::good_broadband(), 8);
        assert_eq!(result.metrics.packets_dropped, 0);
    }

    /// Guards tick-rate-as-data through `run` itself. Driving `Sim::step` directly
    /// does not cover it, because `run` is where `dt` is derived.
    #[test]
    fn run_derives_dt_from_the_scenario_tick_rate() {
        let mut at_64 = moving_scenario(64, 64);
        at_64.world.friction = from_int(1);
        let mut at_128 = moving_scenario(128, 128);
        at_128.world.friction = from_int(1);

        let a = run(RunRequest {
            scenario: &at_64,
            segment: NetworkSegment::perfect(),
            seed: 1,
            config: baseline_config(),
            capture_snapshots: true,
        });
        let b = run(RunRequest {
            scenario: &at_128,
            segment: NetworkSegment::perfect(),
            seed: 1,
            config: baseline_config(),
            capture_snapshots: true,
        });

        let end_a = a.snapshots.last().expect("64 ticks captured").client;
        let end_b = b.snapshots.last().expect("128 ticks captured").client;

        // one simulated second either way, so the travelled distance must agree
        let gap = to_f64_for_display(abs(end_a.x - end_b.x));
        assert!(
            gap < 0.05,
            "64 Hz reached {} but 128 Hz reached {}",
            end_a.x,
            end_b.x
        );
    }

    /// Scheduling the input away from tick 0 is what makes an early-applying cursor
    /// observable at all.
    #[test]
    fn an_input_scheduled_later_does_not_apply_early() {
        let mut scenario = moving_scenario(64, 80);
        scenario.world.friction = from_int(1);
        scenario.input_script = vec![InputEvent {
            tick: 40,
            entity_id: 0,
            action: InputAction::Move {
                dx: from_int(1),
                dy: Fx::ZERO,
            },
        }];

        let result = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 1,
            config: baseline_config(),
            capture_snapshots: true,
        });

        // nothing may move before the scheduled tick
        assert_eq!(result.snapshots[39].client.vx, Fx::ZERO);
        assert_eq!(result.snapshots[39].client.x, Fx::ZERO);
        // and it must be moving after it
        assert!(result.snapshots[41].client.vx > Fx::ZERO);
    }

    #[test]
    fn inputs_apply_at_their_scheduled_tick() {
        let mut scenario = moving_scenario(64, 120);
        // move right from tick 0, then stop at tick 60
        scenario.input_script = vec![
            InputEvent {
                tick: 0,
                entity_id: 0,
                action: InputAction::Move {
                    dx: from_int(1),
                    dy: Fx::ZERO,
                },
            },
            InputEvent {
                tick: 60,
                entity_id: 0,
                action: InputAction::Stop,
            },
        ];
        scenario.sort_inputs();

        let result = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 1,
            config: baseline_config(),
            capture_snapshots: true,
        });

        // asserted on the server, which is the body the input script drives directly.
        // the client is a renderer of received state when prediction is off, so its
        // velocity tracks arrival rather than the schedule
        let at_60 = result.snapshots[60].server.vx;
        let at_119 = result.snapshots[119].server.vx;
        // with friction at 1 and no input after tick 60, velocity holds exactly
        assert_eq!(at_60, at_119);
    }

    /// Mean client-to-server distance over the settled middle of a run.
    ///
    /// The last ticks are excluded deliberately. A run stops at a fixed tick with
    /// packets still in flight, so the final snapshot compares a client holding state
    /// from several ticks ago against a server that has moved on since. That tail is
    /// an artifact of where the run was cut, not something a player would experience,
    /// and measuring it would make a well-tracking configuration look worse than a
    /// badly tracking one. The warm-up head is excluded for the same reason.
    fn steady_state_error(r: &RunResult) -> f64 {
        let tail = WARMUP_TICKS as usize;
        let settled = &r.snapshots[tail..r.snapshots.len().saturating_sub(tail)];
        if settled.is_empty() {
            return 0.0;
        }
        let total: f64 = settled
            .iter()
            .map(|s| to_f64_for_display(abs(s.client.x - s.server.x)))
            .sum();
        total / settled.len() as f64
    }

    // ---- the verification oracle ----
    //
    // Four independent checks, because no single one is sufficient. Riot's published
    // figures live in `peekers.rs`; the other three are here, where they can see a
    // whole run.

    /// Oracle 2: at zero latency and zero loss, any combination that predicts must
    /// track the server exactly.
    ///
    /// On a perfect link there is nothing to compensate for, so a predicting client
    /// running the same inputs through the same integrator must land bit-for-bit on
    /// the server. Exhaustive over all 64 combinations, which is affordable and
    /// removes the risk of hand-listing them and missing the broken one.
    ///
    /// Combinations without prediction are excluded deliberately, not to make the
    /// test pass: a client that does not predict has no simulation of its own and
    /// renders the last state it received, which is one tick behind by construction.
    /// That lag is the thing prediction exists to remove, and it is asserted
    /// separately in `an_unpredicted_client_lags_by_its_transit_time`.
    #[test]
    fn zero_latency_collapses_every_predicting_combination_onto_the_server() {
        let scenario = moving_scenario(64, 200);

        let mut checked = 0;
        for bits in 0..TECHNIQUE_COMBINATIONS {
            let techniques = TechniqueSet::from_bits(bits);
            let config = NetcodeConfig {
                techniques,
                ..NetcodeConfig::default()
            };
            if config.validate().is_err() || !techniques.client_prediction {
                continue;
            }
            let result = run_config(&scenario, NetworkSegment::perfect(), 11, config);
            assert_eq!(
                result.metrics.divergence_max,
                Fx::ZERO,
                "combination {bits} diverged by {} on a perfect link",
                to_f64_for_display(result.metrics.divergence_max)
            );
            assert_eq!(
                result.metrics.correction_count, 0,
                "combination {bits} corrected on a perfect link"
            );
            checked += 1;
        }
        // guards against the filters above quietly excluding everything
        assert!(checked >= 16, "only {checked} combinations were exercised");
    }

    /// The counterpart to the test above: without prediction the client is behind by
    /// its transit time even on a perfect link, and that is correct rather than a bug.
    #[test]
    fn an_unpredicted_client_lags_by_its_transit_time() {
        let scenario = moving_scenario(64, 200);
        let result = run_config(&scenario, NetworkSegment::perfect(), 11, baseline_config());
        assert!(
            result.metrics.divergence_max > Fx::ZERO,
            "an unpredicted client showed no lag, which means it is not rendering received state"
        );
        // one tick of travel at this speed, not an unbounded drift
        assert!(
            to_f64_for_display(result.metrics.divergence_max) < 2.0,
            "unpredicted lag was {} which is more than one tick of motion",
            to_f64_for_display(result.metrics.divergence_max)
        );
    }

    /// Every valid combination must also stay internally consistent on a perfect
    /// link: no corrections, no snaps, no rollbacks, because nothing went wrong.
    #[test]
    fn a_perfect_link_never_corrects_under_any_combination() {
        let scenario = moving_scenario(64, 200);
        for bits in 0..TECHNIQUE_COMBINATIONS {
            let config = NetcodeConfig {
                techniques: TechniqueSet::from_bits(bits),
                ..NetcodeConfig::default()
            };
            if config.validate().is_err() {
                continue;
            }
            let m = run_config(&scenario, NetworkSegment::perfect(), 3, config).metrics;
            assert_eq!(
                m.snap_count, 0,
                "combination {bits} snapped on a perfect link"
            );
            assert_eq!(
                m.packets_dropped, 0,
                "combination {bits} dropped a packet on a perfect link"
            );
        }
    }

    /// Oracle 3: prediction must remove the delay between pressing an input and
    /// seeing the result locally.
    ///
    /// This is the whole reason prediction exists. Measured as how long the client
    /// takes to start moving after the input tick, which is what a player feels,
    /// rather than as divergence from the server.
    ///
    /// Note that prediction *raises* divergence from the server, and that is correct
    /// rather than a regression: a predicting client is deliberately ahead of the
    /// authoritative state by roughly the network delay. Asserting that divergence
    /// falls here would be asserting that prediction does not work.
    #[test]
    fn prediction_removes_local_input_delay() {
        let mut scenario = moving_scenario(64, 300);
        scenario.world.friction = from_int(1);
        scenario.input_script = vec![InputEvent {
            tick: 40,
            entity_id: 0,
            action: InputAction::Move {
                dx: from_int(1),
                dy: Fx::ZERO,
            },
        }];

        let first_motion = |r: &RunResult| {
            r.snapshots
                .iter()
                .position(|s| s.client.vx > Fx::ZERO)
                .unwrap_or(usize::MAX)
        };

        let without = run_config(
            &scenario,
            NetworkSegment::transcontinental(),
            5,
            baseline_config(),
        );
        let with = run_config(
            &scenario,
            NetworkSegment::transcontinental(),
            5,
            NetcodeConfig {
                techniques: TechniqueSet {
                    client_prediction: true,
                    ..TechniqueSet::NONE
                },
                ..NetcodeConfig::default()
            },
        );

        // the predicting client moves on the very tick the input was pressed
        assert_eq!(first_motion(&with), 40);
        assert!(
            first_motion(&with) < first_motion(&without),
            "predicted motion began at {} against {} unpredicted",
            first_motion(&with),
            first_motion(&without)
        );
    }

    /// Oracle 3: reconciliation must leave the client closer to the server than
    /// prediction alone does.
    ///
    /// Asserted on where the client actually ends up, not on mean divergence. Under
    /// loss an unreconciled client accumulates a one-way error that grows all run,
    /// while mean divergence averages the whole run including its early, still-small
    /// window. Final position error is what a player would see as rubber-banding, and
    /// it is the quantity reconciliation is built to bound.
    #[test]
    fn reconciliation_keeps_the_client_closer_to_the_server_under_loss() {
        let scenario = moving_scenario(64, 400);
        let predicted_only = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };
        let reconciled = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                server_reconciliation: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };

        let a = run_config(&scenario, NetworkSegment::hostile(), 21, predicted_only);
        let b = run_config(&scenario, NetworkSegment::hostile(), 21, reconciled);
        assert!(
            steady_state_error(&b) < steady_state_error(&a),
            "reconciled client tracked {:.3} from the server against {:.3} unreconciled",
            steady_state_error(&b),
            steady_state_error(&a)
        );
    }

    /// Oracle 3: a faster blend must track the reconciled target more tightly.
    ///
    /// Measured against the reconciled target the correction actually aims at, which
    /// is the acknowledged server state with the client's unacknowledged inputs
    /// replayed on top. That target, not the raw server position, is what the blend
    /// rate converges on.
    ///
    /// Measuring against the raw server position instead shows the opposite ordering,
    /// and that is not a bug: the server is behind the client by the network delay by
    /// construction, so a client that snaps onto the reconciled state each tick
    /// abandons its own prediction and sits closer to where the server *was*. The
    /// correction magnitude is the honest quantity here, and it is what a player
    /// experiences as rubber-banding.
    #[test]
    fn a_faster_blend_rate_leaves_less_error_behind() {
        let scenario = moving_scenario(64, 400);
        let correction_at = |blend_permille: i32| {
            let config = NetcodeConfig {
                techniques: TechniqueSet {
                    client_prediction: true,
                    server_reconciliation: true,
                    ..TechniqueSet::NONE
                },
                correction_blend_rate: ratio(blend_permille, 1000),
                ..NetcodeConfig::default()
            };
            let m = run_config(&scenario, NetworkSegment::hostile(), 11, config).metrics;
            to_f64_for_display(m.correction_magnitude_mean)
        };
        // leaving 80% of the error in place must accumulate a larger residual than
        // landing on the target outright
        assert!(
            correction_at(0) <= correction_at(800),
            "blending at 0 left a mean correction of {:.3} against {:.3} at 800",
            correction_at(0),
            correction_at(800)
        );
    }

    /// Oracle 3: worse networks must not produce better numbers.
    ///
    /// Asserted against round trip time with jitter held at zero. Divergence tracks
    /// the one-way delay measured in whole ticks, and with jitter on, two nearby RTTs
    /// can quantise to the same tick count or straddle a boundary, so a strict
    /// ordering between arbitrary presets does not hold and asserting one would be
    /// asserting a falsehood.
    ///
    /// This is a real property of the emulator rather than a workaround: a link is
    /// sampled at tick granularity, so a delay difference smaller than a tick is
    /// genuinely invisible to the simulation. `divergence_is_flat_within_one_tick`
    /// pins that behaviour directly so it cannot change unnoticed.
    #[test]
    fn divergence_rises_with_round_trip_time() {
        let scenario = moving_scenario(64, 300);
        let config = NetcodeConfig::default();
        let seeds = [13u64, 14, 15, 16];

        let mean_divergence = |rtt_mean_ms: u32| {
            let segment = NetworkSegment {
                rtt_mean_ms,
                rtt_jitter_ms: 0,
                ..NetworkSegment::good_broadband()
            };
            let total: f64 = seeds
                .iter()
                .map(|s| {
                    to_f64_for_display(
                        run_config(&scenario, segment, *s, config)
                            .metrics
                            .divergence_mean,
                    )
                })
                .sum();
            total / seeds.len() as f64
        };

        let mut previous = 0.0;
        for rtt in [32u32, 63, 94, 125, 200, 300, 400] {
            let current = mean_divergence(rtt);
            assert!(
                current >= previous,
                "{rtt} ms averaged {current:.4} against {previous:.4} at the lower round trip"
            );
            previous = current;
        }
    }

    /// The quantisation the test above works around, pinned so it stays visible.
    ///
    /// A round trip difference smaller than one tick cannot change the simulation,
    /// because packets are only ever delivered on tick boundaries. Anyone reading a
    /// flat region in the results should find this test rather than assume a bug.
    #[test]
    fn divergence_is_flat_within_one_tick_of_delay() {
        let scenario = moving_scenario(64, 300);
        let config = NetcodeConfig::default();
        let at = |rtt_mean_ms: u32| {
            let segment = NetworkSegment {
                rtt_mean_ms,
                rtt_jitter_ms: 0,
                ..NetworkSegment::good_broadband()
            };
            run_config(&scenario, segment, 13, config)
                .metrics
                .divergence_mean
        };
        // 34 ms and 40 ms are both a little over one tick of one-way delay at 64 Hz,
        // so they land on the same tick and must produce identical results
        assert_eq!(at(34), at(40));
        // and crossing the next boundary must change it
        assert_ne!(at(34), at(70));
    }

    /// Oracle 3: rollback must never resimulate further back than its window.
    #[test]
    fn rollback_never_exceeds_its_window() {
        let scenario = moving_scenario(64, 400);
        for window in [2u8, 4, 8, 16] {
            let config = NetcodeConfig {
                techniques: TechniqueSet::ALL,
                rollback_window_ticks: window,
                ..NetcodeConfig::default()
            };
            let m = run_config(&scenario, NetworkSegment::hostile(), 17, config).metrics;
            assert!(
                to_f64_for_display(m.rollback_depth_mean) <= window as f64,
                "mean rollback depth {} exceeded the {window} tick window",
                to_f64_for_display(m.rollback_depth_mean)
            );
        }
    }

    /// Oracle 3: a longer rewind limit cannot register fewer hits.
    #[test]
    fn a_longer_rewind_limit_never_lowers_hit_registration() {
        let mut scenario = moving_scenario(64, 300);
        scenario.input_script.push(InputEvent {
            tick: 150,
            entity_id: 0,
            action: InputAction::Fire {
                dir_x: from_int(1),
                dir_y: Fx::ZERO,
            },
        });
        scenario.sort_inputs();

        let short = NetcodeConfig {
            techniques: TechniqueSet::ALL,
            server_rewind_limit_ms: 20,
            ..NetcodeConfig::default()
        };
        let long = NetcodeConfig {
            techniques: TechniqueSet::ALL,
            server_rewind_limit_ms: 400,
            ..NetcodeConfig::default()
        };
        let a = run_config(&scenario, NetworkSegment::transcontinental(), 4, short);
        let b = run_config(&scenario, NetworkSegment::transcontinental(), 4, long);
        assert!(b.metrics.shots_confirmed >= a.metrics.shots_confirmed);
    }

    /// Oracle 4, the Gambetta cross-check: with prediction on but reconciliation off,
    /// a lossy link must let the client drift away from the server.
    ///
    /// His demo shows the same behaviour, and it is the reason reconciliation exists.
    /// Qualitative because his simulation differs in detail, but a disagreement in
    /// direction would mean one of the two implementations is wrong.
    #[test]
    fn disabling_reconciliation_under_loss_causes_drift() {
        let scenario = moving_scenario(64, 400);
        let drifting = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };
        let corrected = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                server_reconciliation: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };
        let lossy = NetworkSegment {
            loss_pct: 10,
            loss_model: LossModel::Independent,
            ..NetworkSegment::average_broadband()
        };

        let a = run_config(&scenario, lossy, 33, drifting);
        let b = run_config(&scenario, lossy, 33, corrected);
        assert!(
            steady_state_error(&a) > steady_state_error(&b),
            "unreconciled drift {:.3} did not exceed reconciled {:.3}",
            steady_state_error(&a),
            steady_state_error(&b)
        );
    }

    /// Metrics must be sampled before corrections are applied.
    ///
    /// If sampling moved after the correction the client would already have been
    /// pulled onto the server, divergence would read near zero even on a hostile
    /// link, and every recommendation the tool makes would be too optimistic.
    /// Metrics must be sampled before corrections are applied.
    ///
    /// Checked against the snapshots, which are written at the same point in the tick
    /// as the divergence sample. A run where reported divergence matched the
    /// post-correction gap would mean the sample had moved after the correction, and
    /// every reported figure would then understate what the player saw.
    ///
    /// The correction is forced to be large and instant, so the pre- and
    /// post-correction gaps are far apart and the two cannot be confused.
    #[test]
    fn divergence_is_sampled_before_the_correction_is_applied() {
        let scenario = moving_scenario(64, 400);
        let config = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                server_reconciliation: true,
                ..TechniqueSet::NONE
            },
            // land on the target outright, so anything sampled afterwards would be
            // the reconciled residual rather than the error the client actually held
            correction_blend_rate: Fx::ZERO,
            snap_threshold: ratio(1, 1000),
            ..NetcodeConfig::default()
        };
        let result = run_config(&scenario, NetworkSegment::transcontinental(), 8, config);

        // the snapshot is taken at the sampling point, so it must still carry the
        // uncorrected gap
        let sampled_gap = steady_state_error(&result);
        assert!(
            sampled_gap > 0.5,
            "sampled gap was {sampled_gap:.4} on a 180 ms link with instant snapping, \
             which means the correction had already run when the sample was taken"
        );
        assert!(
            to_f64_for_display(result.metrics.divergence_mean) > 0.5,
            "divergence mean was {:.4} while the sampled gap was {sampled_gap:.4}",
            to_f64_for_display(result.metrics.divergence_mean)
        );
    }

    /// Determinism must survive every technique being enabled.
    #[test]
    fn a_fully_compensated_run_is_still_reproducible() {
        let scenario = moving_scenario(64, 300);
        let config = NetcodeConfig::default();
        let a = run_config(&scenario, NetworkSegment::hostile(), 99, config);
        let b = run_config(&scenario, NetworkSegment::hostile(), 99, config);
        assert_eq!(a.state_hash, b.state_hash);
        assert_eq!(a.metrics, b.metrics);
    }

    /// The config must be part of the run's identity, otherwise two different
    /// configurations would be indistinguishable in a sweep's results.
    #[test]
    fn the_config_changes_the_state_hash() {
        let scenario = moving_scenario(64, 200);
        let a = run_config(&scenario, NetworkSegment::lan(), 6, baseline_config());
        let b = run_config(
            &scenario,
            NetworkSegment::lan(),
            6,
            NetcodeConfig::default(),
        );
        assert_ne!(a.state_hash, b.state_hash);
        assert_ne!(a.config_hash, b.config_hash);
    }

    /// Server-side input prediction: when the client's update does not arrive, the
    /// server repeats the last input rather than treating it as no input at all.
    ///
    /// Without it the server stalls whenever a packet is late, which understates
    /// divergence under loss and makes every profile look better than it is.
    #[test]
    fn the_server_repeats_the_last_input_when_none_arrives() {
        let mut scenario = moving_scenario(64, 200);
        scenario.world.friction = from_int(1);
        let lossy = NetworkSegment {
            loss_pct: 40,
            loss_model: LossModel::Independent,
            ..NetworkSegment::good_broadband()
        };
        let result = run_config(&scenario, lossy, 12, baseline_config());
        let end = result.snapshots.last().map_or(Fx::ZERO, |s| s.server.vx);
        // a server that ignored missing updates would barely accelerate through a
        // 40% loss run
        assert!(
            end > from_int(5),
            "server reached only {} with input prediction, which suggests it stalled on loss",
            to_f64_for_display(end)
        );
    }

    /// The same schedule seen from the client, which only holds a velocity of its own
    /// when it is predicting.
    #[test]
    fn a_predicting_client_holds_velocity_after_the_stop() {
        let mut scenario = moving_scenario(64, 120);
        scenario.input_script = vec![
            InputEvent {
                tick: 0,
                entity_id: 0,
                action: InputAction::Move {
                    dx: from_int(1),
                    dy: Fx::ZERO,
                },
            },
            InputEvent {
                tick: 60,
                entity_id: 0,
                action: InputAction::Stop,
            },
        ];
        scenario.sort_inputs();

        let result = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 1,
            config: NetcodeConfig {
                techniques: TechniqueSet {
                    client_prediction: true,
                    ..TechniqueSet::NONE
                },
                ..NetcodeConfig::default()
            },
            capture_snapshots: true,
        });

        assert_eq!(
            result.snapshots[60].client.vx,
            result.snapshots[119].client.vx
        );
    }
}
