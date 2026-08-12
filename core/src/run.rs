//! One seeded run: a server and a client simulating the same scenario across a
//! network, and the metrics that come out of it.
//!
//! No latency compensation yet. That is the baseline phase 2 has to beat, so large
//! divergence under loss is the expected result here, not a bug.

use crate::fx::{abs, clamp, sqrt, to_bits, Fx};
use crate::hash::Hasher;
use crate::net::{Link, NetworkSegment, PacketPayload};
use crate::rng::Rng64;
use crate::scenario::{InputAction, Scenario};

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
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Snapshot {
    pub tick: u32,
    pub server: Body,
    pub client: Body,
}

pub struct RunResult {
    pub seed: u64,
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
    pub capture_snapshots: bool,
}

/// Runs one seeded simulation to completion.
pub fn run(request: RunRequest<'_>) -> RunResult {
    let scenario = request.scenario;
    let dt = scenario.tick_interval_ms() / crate::fx::from_int(1000);
    let tick_ms = scenario.tick_interval_ms();

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
    let mut latency_total_ms = Fx::ZERO;
    let mut latency_count: u32 = 0;

    // the script is walked with a cursor rather than searched, so an input applies at
    // its scheduled tick and never at the tick it happens to be read
    let mut cursor = 0usize;
    let mut held: Option<(Fx, Fx)> = None;

    for tick in 0..scenario.duration_ticks {
        while cursor < scenario.input_script.len() {
            let event = scenario.input_script[cursor];
            if event.tick != tick {
                break;
            }
            held = match event.action {
                InputAction::Move { dx, dy } => Some((dx, dy)),
                InputAction::Stop => None,
                InputAction::Fire { .. } => held,
            };
            cursor += 1;
        }

        // the client predicts by applying its own input immediately
        client.step(dt, held);

        if let Some((dx, dy)) = held {
            to_server.send(
                &mut rng,
                tick,
                tick_ms,
                PacketPayload::Input {
                    entity_id: 0,
                    dx,
                    dy,
                    input_tick: tick,
                },
            );
        }

        let mut server_input = None;
        for packet in to_server.receive(tick) {
            if let PacketPayload::Input {
                dx, dy, input_tick, ..
            } = packet.payload
            {
                server_input = Some((dx, dy));
                latency_total_ms += Fx::from_num(tick.saturating_sub(input_tick)) * tick_ms;
                latency_count += 1;
            }
        }

        server.step(dt, server_input);

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
            },
        );

        // with no reconciliation the client only records how far it had drifted when
        // authoritative state arrived. phase 2 is where this becomes a correction that
        // actually moves the client
        for packet in to_client.receive(tick) {
            if let PacketPayload::State { x, y, .. } = packet.payload {
                let authoritative = Body {
                    x,
                    y,
                    ..Default::default()
                };
                let gap = distance(client.body, authoritative);
                if tick >= WARMUP_TICKS && gap > Fx::ZERO {
                    corrections.push(gap);
                }
            }
        }

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
    }

    let metrics = Metrics {
        divergence_mean: mean(&divergences),
        divergence_p99: percentile(&mut divergences.clone(), 99),
        divergence_max: divergences
            .iter()
            .copied()
            .fold(Fx::ZERO, |a, b| if b > a { b } else { a }),
        correction_count: corrections.len() as u32,
        correction_magnitude_mean: mean(&corrections),
        correction_magnitude_max: corrections.iter().copied().fold(Fx::ZERO, |a, b| {
            if b > a {
                b
            } else {
                a
            }
        }),
        input_latency_mean_ms: if latency_count == 0 {
            Fx::ZERO
        } else {
            latency_total_ms / Fx::from_num(latency_count)
        },
        packets_sent: to_server.sent_count() + to_client.sent_count(),
        packets_dropped: to_server.dropped_count() + to_client.dropped_count(),
        sampled_ticks: divergences.len() as u32,
    };

    let mut h = Hasher::new();
    scenario.hash_into(&mut h);
    h.write_u64(request.seed);
    for body in [server.body, client.body] {
        h.write_i64(to_bits(body.x));
        h.write_i64(to_bits(body.y));
        h.write_i64(to_bits(body.vx));
        h.write_i64(to_bits(body.vy));
    }

    RunResult {
        seed: request.seed,
        state_hash: h.finish(),
        metrics,
        snapshots,
    }
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

/// True when two bodies are within `tolerance` of each other.
pub fn within(a: Body, b: Body, tolerance: Fx) -> bool {
    abs(a.x - b.x) <= tolerance && abs(a.y - b.y) <= tolerance
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::{from_int, ratio, to_f64_for_display};
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

    fn run_with(segment: NetworkSegment, seed: u64) -> RunResult {
        let scenario = moving_scenario(64, 400);
        run(RunRequest {
            scenario: &scenario,
            segment,
            seed,
            capture_snapshots: false,
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
            capture_snapshots: false,
        });
        let on = run(RunRequest {
            scenario: &scenario,
            segment: NetworkSegment::perfect(),
            seed: 5,
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
            capture_snapshots: false,
        });
        let rb = run(RunRequest {
            scenario: &b,
            segment: NetworkSegment::perfect(),
            seed: 9,
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
            capture_snapshots: true,
        });
        let b = run(RunRequest {
            scenario: &at_128,
            segment: NetworkSegment::perfect(),
            seed: 1,
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
            capture_snapshots: true,
        });

        let at_60 = result.snapshots[60].client.vx;
        let at_119 = result.snapshots[119].client.vx;
        // with friction at 1 and no input after tick 60, velocity holds exactly
        assert_eq!(at_60, at_119);
    }
}
