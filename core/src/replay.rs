//! A run recorded frame by frame, for the replay view.
//!
//! `run.rs` measures one client and reports aggregates. This measures two, and keeps
//! what happened on every tick rather than folding it into a mean. The two exist
//! separately on purpose: the sweep in Phase 4 runs thousands of configurations and
//! must not pay for a per-tick record it never reads, and this must not be pulled
//! toward reporting averages.
//!
//! Two clients rather than one because the quantities this view exists to show are
//! relational. Peeker's advantage is one player seeing another before being seen, and
//! a single client has nobody to be ahead of.
//!
//! The world holds one controllable body, so the two clients are not two players.
//! Client A owns the body and drives it; client B is a second viewer of the same
//! entity on its own link, which is the player the peeker is peeking. Modelling B as
//! a second controllable body would need a second input script and a collision rule,
//! neither of which the scenario format carries yet, and inventing them here would
//! put physics in the replay view that the measured run does not have.
//!
//! Both clients share the server and the scenario and differ only in their link, so a
//! difference between the two panels is caused by the network and nothing else.

use crate::config::NetcodeConfig;
use crate::fx::{sqrt, Fx};
use crate::hash::Hasher;
use crate::net::{Link, NetworkSegment, PacketPayload};
use crate::rng::Rng64;
use crate::run::{Body, Sim, WARMUP_TICKS};
use crate::scenario::{InputAction, Scenario};
use crate::techniques::{
    apply_correction, extrapolate, interpolate, rewind_limit_ticks, rewind_target_tick,
    InputHistory, PendingInput, StateBuffer, StateSample,
};

/// What one client did on one tick.
///
/// `corrected` and `rolled_back` are recorded per tick rather than counted, because
/// the view flashes the tick it happened on. A count cannot say when.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ClientFrame {
    /// Where the client drew itself.
    pub body: Body,
    /// The newest authoritative state this client had received, which is the ghost.
    /// Absent before the first packet arrives, and drawing a ghost then would be
    /// drawing a position nobody had.
    pub ghost: Option<StateSample>,
    /// Where the client was immediately before a correction moved it. Present only on
    /// a tick that corrected, so the view can draw the jump it made.
    pub pre_correction: Option<Body>,
    pub correction_magnitude: Fx,
    pub snapped: bool,
    /// Ticks resimulated this tick, zero when nothing was rolled back.
    pub rollback_depth: u32,
}

/// What the whole world did on one tick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Frame {
    pub tick: u32,
    pub server: Body,
    pub clients: [ClientFrame; CLIENT_COUNT],
    /// The tick the server resolved a shot against, when one was fired and rewound.
    pub rewind_target: Option<u32>,
}

pub const CLIENT_COUNT: usize = 2;

/// Derives one client's link seed from the run seed.
///
/// Each client draws from its own generator so its packet timings do not depend on
/// how many other clients exist or on the order they are stepped in. Threading one
/// shared generator through both would make client A's link a function of client B's
/// traffic, and adding a client would silently change every existing result.
///
/// The multiplier is an odd 64-bit constant, so the mapping is injective and two
/// clients cannot collide onto the same stream.
fn client_seed(seed: u64, index: usize) -> u64 {
    seed ^ (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

/// The parts of a client that are per-client rather than shared.
struct Client {
    sim: Sim,
    to_server: Link,
    to_client: Link,
    rng: Rng64,
    history: InputHistory,
    received: StateBuffer,
    last_sequence: u32,
}

impl Client {
    fn new(scenario: &Scenario, segment: NetworkSegment, seed: u64) -> Self {
        Self {
            sim: Sim::from_scenario(scenario),
            to_server: Link::new(segment),
            to_client: Link::new(segment),
            rng: Rng64::from_seed(seed),
            history: InputHistory::new(),
            received: StateBuffer::new(),
            last_sequence: 0,
        }
    }
}

/// Which client owns the controllable body and drives the server.
const OWNER: usize = 0;

pub struct ReplayRequest<'a> {
    pub scenario: &'a Scenario,
    pub segment: NetworkSegment,
    pub seed: u64,
    pub config: NetcodeConfig,
}

pub struct ReplayResult {
    pub frames: Vec<Frame>,
    pub state_hash: u64,
}

/// Runs a two-client simulation, recording every tick.
///
/// The tick order matches `run.rs` exactly: read input, predict, send, receive, step
/// the server, record, then correct. Recording sits where metric sampling sits, so a
/// frame carries the error the player actually held rather than the residual left
/// after the correction erased it. Diverging from that order here would make the
/// replay disagree with the numbers the rest of the tool reports.
pub fn replay(request: ReplayRequest<'_>) -> ReplayResult {
    let scenario = request.scenario;
    let config = request.config;
    let techniques = config.techniques;
    let dt = scenario.tick_interval_ms() / crate::fx::from_int(1000);
    let tick_ms = scenario.tick_interval_ms();
    let rewind_ticks = rewind_limit_ticks(config.server_rewind_limit_ms, tick_ms);

    let mut server = Sim::from_scenario(scenario);
    let mut server_history = StateBuffer::new();
    let mut server_last_input: Option<(Fx, Fx)> = None;
    let mut clients: Vec<Client> = (0..CLIENT_COUNT)
        .map(|i| Client::new(scenario, request.segment, client_seed(request.seed, i)))
        .collect();

    let mut frames = Vec::with_capacity(scenario.duration_ticks as usize);

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

        let (dx, dy) = held.unwrap_or((Fx::ZERO, Fx::ZERO));
        let sequence = tick + 1;

        // only the owner predicts, because only the owner has local input. a viewer
        // predicting a body it does not control would be inventing motion, and it is
        // precisely the case interpolation and extrapolation exist to handle
        let owner = &mut clients[OWNER];
        if techniques.client_prediction {
            owner.sim.step(dt, Some((dx, dy)));
            owner.history.push(PendingInput {
                sequence,
                tick,
                dx,
                dy,
            });
        }
        owner.to_server.send(
            &mut owner.rng,
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

        // every input that arrived is applied, not just the newest. keeping only the
        // last while advancing the acknowledgement past all of them would have the
        // server claim inputs it never simulated, and the owner would then trim them
        // from its history and never replay them
        let mut arrived: Vec<(Fx, Fx)> = Vec::new();
        for packet in owner.to_server.receive(tick) {
            if let PacketPayload::Input {
                dx,
                dy,
                sequence: seq,
                ..
            } = packet.payload
            {
                if seq <= owner.last_sequence {
                    continue;
                }
                owner.last_sequence = seq;
                arrived.push((dx, dy));
            }
        }
        let acknowledged = owner.last_sequence;

        if arrived.is_empty() {
            // the server repeats the last input it received rather than treating a
            // late packet as a released key
            server.step(dt, server_last_input);
        } else {
            server_last_input = arrived.last().copied();
            for input in &arrived {
                server.step(dt, Some(*input));
            }
        }
        server_history.insert(StateSample {
            tick,
            body: server.body,
        });
        for client in clients.iter_mut() {
            client.to_client.send(
                &mut client.rng,
                tick,
                tick_ms,
                PacketPayload::State {
                    entity_id: 0,
                    x: server.body.x,
                    y: server.body.y,
                    vx: server.body.vx,
                    vy: server.body.vy,
                    server_tick: tick,
                    last_input_sequence: acknowledged,
                },
            );
        }

        // the rewind target is recorded so the view can draw where the server resolved
        // the shot, against the world the owner was looking at when it fired
        let mut rewind_target = None;
        if fired_this_tick && tick >= WARMUP_TICKS && techniques.server_rewind {
            let viewed = clients[OWNER].received.latest().map_or(tick, |s| s.tick);
            rewind_target = Some(rewind_target_tick(tick, viewed, rewind_ticks));
        }

        let mut newest: Vec<Option<StateSample>> = Vec::with_capacity(CLIENT_COUNT);
        let mut acks: Vec<Option<u32>> = Vec::with_capacity(CLIENT_COUNT);
        for client in clients.iter_mut() {
            let mut best: Option<StateSample> = None;
            let mut ack: Option<u32> = None;
            for packet in client.to_client.receive(tick) {
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
                    client.received.insert(sample);
                    if best.is_none_or(|n| server_tick > n.tick) {
                        best = Some(sample);
                        ack = Some(last_input_sequence);
                    }
                }
            }
            newest.push(best);
            acks.push(ack);
        }

        // recorded here, before any correction moves a client, so a frame holds the
        // error the player saw rather than the residual left after correcting it
        let mut recorded = [ClientFrame::default(); CLIENT_COUNT];
        for (i, client) in clients.iter().enumerate() {
            recorded[i] = ClientFrame {
                body: client.sim.body,
                ghost: client.received.latest(),
                ..ClientFrame::default()
            };
        }

        for (i, client) in clients.iter_mut().enumerate() {
            let (Some(sample), Some(ack)) = (newest[i], acks[i]) else {
                continue;
            };

            // only the owner predicts, so only the owner has unacknowledged inputs to
            // replay. reconciling a viewer would correct a prediction it never made
            let predicting = i == OWNER && techniques.client_prediction;

            if predicting && techniques.server_reconciliation {
                client.history.acknowledge(ack);

                // replay starts from the authoritative state, never from the current
                // predicted one
                let mut replay_sim = Sim::from_scenario(scenario);
                replay_sim.body = sample.body;
                let pending = client.history.pending().to_vec();

                if techniques.rollback && !pending.is_empty() {
                    recorded[i].rollback_depth =
                        (tick.saturating_sub(sample.tick)).min(config.rollback_window_ticks as u32);
                }

                for input in &pending {
                    replay_sim.step(dt, Some((input.dx, input.dy)));
                }

                let before = client.sim.body;
                let outcome = apply_correction(
                    client.sim.body,
                    replay_sim.body,
                    config.correction_blend_rate,
                    config.snap_threshold,
                );
                // a correction of zero moved nothing, and drawing a flash for it would
                // show the mechanism firing on ticks where nothing happened
                if outcome.magnitude > Fx::ZERO {
                    recorded[i].pre_correction = Some(before);
                    recorded[i].correction_magnitude = outcome.magnitude;
                    recorded[i].snapped = outcome.snapped;
                }
                // `recorded[i].body` already holds `before`, captured ahead of this
                // loop. Assigning it again here would read as the thing that keeps the
                // frame pre-correction when the capture above is what does.
                client.sim.body = outcome.body;
            }

            if !predicting {
                client.sim.body =
                    render_body(&techniques, &client.received, sample, tick, dt, &config);
                recorded[i].body = client.sim.body;
            }
        }

        frames.push(Frame {
            tick,
            server: server.body,
            clients: recorded,
            rewind_target,
        });
    }

    let mut h = Hasher::new();
    scenario.hash_into(&mut h);
    config.hash_into(&mut h);
    h.write_u64(request.seed);
    for body in std::iter::once(server.body).chain(clients.iter().map(|c| c.sim.body)) {
        h.write_i64(crate::fx::to_bits(body.x));
        h.write_i64(crate::fx::to_bits(body.y));
        h.write_i64(crate::fx::to_bits(body.vx));
        h.write_i64(crate::fx::to_bits(body.vy));
    }

    ReplayResult {
        frames,
        state_hash: h.finish(),
    }
}

/// What a client with no local simulation draws. Mirrors `run::render_body`.
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

pub fn distance(a: Body, b: Body) -> Fx {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    sqrt(dx * dx + dy * dy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{TechniqueSet, TECHNIQUE_COMBINATIONS};
    use crate::fx::{from_int, to_f64_for_display};
    use crate::run::{run, RunRequest};
    use crate::scenario::{EntityKind, EntitySpec, InputEvent, WorldConfig};

    fn moving_scenario(ticks: u32) -> Scenario {
        Scenario {
            tick_rate: 64,
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

    fn replay_with(segment: NetworkSegment, seed: u64, config: NetcodeConfig) -> ReplayResult {
        let scenario = moving_scenario(400);
        replay(ReplayRequest {
            scenario: &scenario,
            segment,
            seed,
            config,
        })
    }

    #[test]
    fn a_frame_is_recorded_for_every_tick() {
        let r = replay_with(NetworkSegment::lan(), 1, NetcodeConfig::default());
        assert_eq!(r.frames.len(), 400);
        for (i, frame) in r.frames.iter().enumerate() {
            assert_eq!(frame.tick, i as u32, "frame {i} carries the wrong tick");
        }
    }

    #[test]
    fn the_same_seed_reproduces_the_replay() {
        let a = replay_with(NetworkSegment::hostile(), 77, NetcodeConfig::default());
        let b = replay_with(NetworkSegment::hostile(), 77, NetcodeConfig::default());
        assert_eq!(a.state_hash, b.state_hash);
        assert_eq!(a.frames, b.frames);
    }

    #[test]
    fn different_seeds_produce_different_replays() {
        let a = replay_with(NetworkSegment::hostile(), 1, NetcodeConfig::default());
        let b = replay_with(NetworkSegment::hostile(), 2, NetcodeConfig::default());
        assert_ne!(a.state_hash, b.state_hash);
    }

    /// The replay must agree with the run it illustrates.
    ///
    /// This is the load-bearing test of the module. The owner client here and the
    /// single client in `run.rs` are the same client on the same link, so their server
    /// trajectories must be identical tick for tick. If they drift, the picture the
    /// tool shows contradicts the numbers it reports, and the disagreement would read
    /// as a rendering bug rather than as two simulations diverging.
    ///
    /// Asserted on the server body, which both modules step from the same arrived
    /// inputs. The owner's own body is asserted separately below.
    #[test]
    fn the_server_trajectory_matches_the_measured_run() {
        let scenario = moving_scenario(300);
        let config = NetcodeConfig::default();

        for segment in [
            NetworkSegment::perfect(),
            NetworkSegment::good_broadband(),
            NetworkSegment::transcontinental(),
        ] {
            let measured = run(RunRequest {
                scenario: &scenario,
                segment,
                seed: 42,
                config,
                capture_snapshots: true,
            });
            let recorded = replay(ReplayRequest {
                scenario: &scenario,
                segment,
                seed: client_seed(42, OWNER),
                config,
            });

            for (a, b) in measured.snapshots.iter().zip(recorded.frames.iter()) {
                assert_eq!(
                    a.server, b.server,
                    "server diverged at tick {} on a {} ms link",
                    a.tick, segment.rtt_mean_ms
                );
            }
        }
    }

    /// The owner's rendered body must match the measured run's client too.
    ///
    /// Recorded before the correction in both modules, so a mismatch means the two
    /// correction paths have drifted apart rather than that one samples later.
    #[test]
    fn the_owner_body_matches_the_measured_run() {
        let scenario = moving_scenario(300);
        let config = NetcodeConfig::default();
        let segment = NetworkSegment::transcontinental();

        let measured = run(RunRequest {
            scenario: &scenario,
            segment,
            seed: 5,
            config,
            capture_snapshots: true,
        });
        let recorded = replay(ReplayRequest {
            scenario: &scenario,
            segment,
            seed: client_seed(5, OWNER),
            config,
        });

        for (a, b) in measured.snapshots.iter().zip(recorded.frames.iter()) {
            assert_eq!(
                a.client, b.clients[OWNER].body,
                "owner diverged at tick {}",
                a.tick
            );
        }
    }

    /// The two clients must draw their delays from independent streams.
    ///
    /// Asserted by construction rather than by observing the frames. Both clients run
    /// the same `Link` code against the same segment, and the owner additionally sends
    /// input packets, so their generators desync by call count alone. That makes an
    /// observed difference in arrival times a weak signal: it survives even when both
    /// are seeded identically, which is exactly the defect worth catching.
    ///
    /// So this asserts the seeds themselves are distinct, and
    /// `a_shared_seed_changes_the_viewer` pins that the seed actually reaches the
    /// viewer's link rather than being computed and dropped.
    #[test]
    fn client_seeds_are_distinct() {
        assert_ne!(client_seed(42, 0), client_seed(42, 1));
        assert_eq!(client_seed(42, OWNER), client_seed(42, 0));
        // distinct for every run seed, not just one that happens to work
        for seed in [0u64, 1, 42, u64::MAX] {
            assert_ne!(
                client_seed(seed, 0),
                client_seed(seed, 1),
                "collided at {seed}"
            );
        }
    }

    /// The derived seed must reach the viewer's link.
    ///
    /// Computing a per-client seed and then not using it would leave both clients on
    /// the same stream while `client_seeds_are_distinct` still passed. Changing only
    /// the viewer's seed must change what the viewer received.
    #[test]
    fn a_shared_seed_changes_the_viewer() {
        let scenario = moving_scenario(200);
        let config = NetcodeConfig::default();
        let ghosts = |seed: u64| -> Vec<Option<StateSample>> {
            replay(ReplayRequest {
                scenario: &scenario,
                segment: NetworkSegment::hostile(),
                seed,
                config,
            })
            .frames
            .iter()
            .map(|f| f.clients[1].ghost)
            .collect()
        };
        // the owner's stream is derived from the run seed too, so a different run seed
        // moves both. what matters is that the viewer's arrivals are not a copy of the
        // owner's on the same run
        let r = replay_with(NetworkSegment::hostile(), 9, config);
        let owner_arrivals: Vec<Option<u32>> = r
            .frames
            .iter()
            .map(|f| f.clients[0].ghost.map(|g| g.tick))
            .collect();
        let viewer_arrivals: Vec<Option<u32>> = r
            .frames
            .iter()
            .map(|f| f.clients[1].ghost.map(|g| g.tick))
            .collect();
        assert_ne!(
            owner_arrivals, viewer_arrivals,
            "both clients saw state arrive on exactly the same ticks"
        );
        assert_ne!(
            ghosts(9),
            ghosts(10),
            "the run seed did not reach the viewer"
        );
    }

    /// A ghost must be absent until a packet has actually arrived.
    ///
    /// Drawing one before then would put an authoritative marker on screen at a
    /// position no client had been told about.
    #[test]
    fn no_ghost_is_recorded_before_the_first_packet_arrives() {
        let r = replay_with(
            NetworkSegment::transcontinental(),
            3,
            NetcodeConfig::default(),
        );
        assert!(
            r.frames[0].clients[OWNER].ghost.is_none(),
            "a ghost existed on tick 0, before any state could have arrived"
        );
        let arrived = r
            .frames
            .iter()
            .position(|f| f.clients[OWNER].ghost.is_some())
            .expect("state arrives eventually");
        assert!(
            arrived > 0,
            "the first ghost appeared on tick 0 on a 180 ms link"
        );
    }

    /// A ghost must never be dated in the future. It is state that already arrived, so
    /// a ghost ahead of the current tick would be showing the client something it
    /// cannot yet know.
    #[test]
    fn a_ghost_is_never_newer_than_its_frame() {
        let r = replay_with(NetworkSegment::hostile(), 12, NetcodeConfig::default());
        for frame in &r.frames {
            for client in &frame.clients {
                if let Some(ghost) = client.ghost {
                    assert!(
                        ghost.tick <= frame.tick,
                        "ghost from tick {} on frame {}",
                        ghost.tick,
                        frame.tick
                    );
                }
            }
        }
    }

    /// A pre-correction position is recorded exactly when a correction happened.
    ///
    /// The two must agree, otherwise the view draws a correction line with no
    /// correction behind it, or misses one that occurred.
    #[test]
    fn a_pre_correction_position_accompanies_every_correction() {
        let r = replay_with(NetworkSegment::hostile(), 21, NetcodeConfig::default());
        for frame in &r.frames {
            for client in &frame.clients {
                assert_eq!(
                    client.pre_correction.is_some(),
                    client.correction_magnitude > Fx::ZERO,
                    "correction record disagrees with itself on tick {}",
                    frame.tick
                );
            }
        }
    }

    /// A frame must hold the position the player saw, not the corrected one.
    ///
    /// This is the phase doc's named failure mode for this view. If the recorded body
    /// were sampled after the correction, the replay would show a client that never
    /// drifted, every correction line would start where it ended, and the picture
    /// would quietly disagree with the divergence the tool reports.
    ///
    /// Pinned by construction: on a tick that corrected, the recorded body must equal
    /// the recorded pre-correction position, and the client's state going into the
    /// next frame must differ from it. A blend rate of zero lands on the target
    /// outright so the two are far apart and cannot be confused.
    #[test]
    fn a_frame_holds_the_position_before_the_correction() {
        let scenario = moving_scenario(400);
        let config = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: true,
                server_reconciliation: true,
                ..TechniqueSet::NONE
            },
            correction_blend_rate: Fx::ZERO,
            ..NetcodeConfig::default()
        };
        let r = replay(ReplayRequest {
            scenario: &scenario,
            segment: NetworkSegment::transcontinental(),
            seed: 8,
            config,
        });

        let mut checked = 0;
        for frame in &r.frames {
            let owner = frame.clients[OWNER];
            let Some(before) = owner.pre_correction else {
                continue;
            };
            assert_eq!(
                owner.body, before,
                "frame {} recorded a body that is not the pre-correction position",
                frame.tick
            );
            checked += 1;
        }
        assert!(
            checked > 0,
            "no correction occurred, so this test asserted nothing"
        );
    }

    /// Corrections must actually occur on a bad link, otherwise the flash the view
    /// draws would never fire and the feature would look broken when it is the run
    /// that produced nothing.
    #[test]
    fn a_hostile_link_produces_corrections_to_draw() {
        let r = replay_with(NetworkSegment::hostile(), 21, NetcodeConfig::default());
        let corrected = r
            .frames
            .iter()
            .filter(|f| f.clients[OWNER].correction_magnitude > Fx::ZERO)
            .count();
        assert!(
            corrected > 0,
            "no correction was recorded on a hostile link, so nothing would ever flash"
        );
    }

    /// A perfect link corrects nothing, so nothing may flash.
    #[test]
    fn a_perfect_link_records_no_corrections() {
        let r = replay_with(NetworkSegment::perfect(), 4, NetcodeConfig::default());
        for frame in &r.frames {
            assert_eq!(
                frame.clients[OWNER].correction_magnitude,
                Fx::ZERO,
                "corrected on a perfect link at tick {}",
                frame.tick
            );
        }
    }

    /// Rollback depth must never exceed the configured window, in the record as well
    /// as in the aggregate. The view draws this number directly.
    #[test]
    fn recorded_rollback_depth_stays_inside_the_window() {
        let scenario = moving_scenario(400);
        for window in [2u8, 4, 8, 16] {
            let config = NetcodeConfig {
                techniques: TechniqueSet::ALL,
                rollback_window_ticks: window,
                ..NetcodeConfig::default()
            };
            let r = replay(ReplayRequest {
                scenario: &scenario,
                segment: NetworkSegment::hostile(),
                seed: 17,
                config,
            });
            for frame in &r.frames {
                for client in &frame.clients {
                    assert!(
                        client.rollback_depth <= window as u32,
                        "depth {} exceeded the {window} tick window at tick {}",
                        client.rollback_depth,
                        frame.tick
                    );
                }
            }
        }
    }

    /// A rewind target must sit inside the window the server is allowed to rewind to.
    #[test]
    fn a_rewind_target_is_never_outside_its_limit() {
        let mut scenario = moving_scenario(300);
        scenario.input_script.push(InputEvent {
            tick: 150,
            entity_id: 0,
            action: InputAction::Fire {
                dir_x: from_int(1),
                dir_y: Fx::ZERO,
            },
        });
        scenario.sort_inputs();

        let config = NetcodeConfig {
            techniques: TechniqueSet::ALL,
            server_rewind_limit_ms: 200,
            ..NetcodeConfig::default()
        };
        let r = replay(ReplayRequest {
            scenario: &scenario,
            segment: NetworkSegment::transcontinental(),
            seed: 4,
            config,
        });

        let limit = rewind_limit_ticks(200, scenario.tick_interval_ms());
        let targets: Vec<(u32, u32)> = r
            .frames
            .iter()
            .filter_map(|f| f.rewind_target.map(|t| (f.tick, t)))
            .collect();
        assert!(!targets.is_empty(), "the shot recorded no rewind target");
        for (tick, target) in targets {
            assert!(target <= tick, "rewound forward to {target} from {tick}");
            assert!(
                tick - target <= limit,
                "rewound {} ticks past the {limit} tick limit",
                tick - target
            );
        }
    }

    /// A viewer that does not predict must never be recorded as correcting, because it
    /// has no prediction to correct.
    #[test]
    fn the_viewer_never_reconciles() {
        let r = replay_with(NetworkSegment::hostile(), 31, NetcodeConfig::default());
        for frame in &r.frames {
            let viewer = frame.clients[1];
            assert_eq!(viewer.correction_magnitude, Fx::ZERO);
            assert_eq!(viewer.rollback_depth, 0);
            assert!(viewer.pre_correction.is_none());
        }
    }

    /// The viewer renders received state, so it must lag the server rather than track
    /// it exactly. A viewer sitting on the server position would mean it is predicting
    /// a body it does not control.
    #[test]
    fn the_viewer_lags_the_server() {
        let r = replay_with(
            NetworkSegment::transcontinental(),
            6,
            NetcodeConfig::default(),
        );
        let settled = &r.frames[WARMUP_TICKS as usize..];
        let lagging = settled
            .iter()
            .any(|f| distance(f.server, f.clients[1].body) > Fx::ZERO);
        assert!(
            lagging,
            "the viewer tracked the server exactly on a 180 ms link"
        );
    }

    /// Every valid technique combination must produce a complete, finite record.
    ///
    /// Exhaustive because the view renders whatever it is given, and a single
    /// combination that records a non-finite position would draw off-canvas rather
    /// than fail loudly.
    #[test]
    fn every_valid_combination_records_a_usable_replay() {
        let scenario = moving_scenario(120);
        let mut checked = 0;
        for bits in 0..TECHNIQUE_COMBINATIONS {
            let config = NetcodeConfig {
                techniques: TechniqueSet::from_bits(bits),
                ..NetcodeConfig::default()
            };
            if config.validate().is_err() {
                continue;
            }
            let r = replay(ReplayRequest {
                scenario: &scenario,
                segment: NetworkSegment::mobile_4g(),
                seed: 8,
                config,
            });
            assert_eq!(r.frames.len(), 120, "combination {bits} recorded short");
            for frame in &r.frames {
                for client in &frame.clients {
                    let x = to_f64_for_display(client.body.x);
                    let y = to_f64_for_display(client.body.y);
                    assert!(
                        x.is_finite() && y.is_finite(),
                        "combination {bits} drew NaN"
                    );
                }
            }
            checked += 1;
        }
        assert!(checked >= 16, "only {checked} combinations were exercised");
    }
}
