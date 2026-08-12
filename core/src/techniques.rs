//! The six latency compensation techniques, as pieces the run loop composes.
//!
//! Each is separable so a configuration can enable any subset, which is what makes
//! the comparison table mean anything. The taxonomy is fixed by Liu, Xu & Claypool,
//! ACM Computing Surveys 54(11s), 2022, so the set is defensible rather than
//! invented, and the behaviour of each follows Gambetta's canonical description.
//!
//! Every function here is pure: state goes in, state comes out. The run loop owns
//! the ordering, because when a technique runs relative to metric sampling is itself
//! a correctness question.

use crate::config::HISTORY_TICKS;
use crate::fx::{clamp, sqrt, Fx};
use crate::run::Body;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PendingInput {
    pub sequence: u32,
    pub tick: u32,
    pub dx: Fx,
    pub dy: Fx,
}

/// The server's queue of arrived inputs, held before being applied.
///
/// A server that applies an input the tick it arrives is at the mercy of jitter: two
/// inputs land in one tick and none in the next, so the body lurches and then
/// stalls. Holding each input for a fixed number of ticks lets a late one catch up
/// with an early one, and the server consumes at a steady rate instead.
///
/// The cost is latency. Every input waits the full depth even when the link is
/// perfectly steady, which is the tradeoff the sweep exists to price: depth buys
/// smoothness under jitter and spends responsiveness to do it.
///
/// A depth of zero applies inputs the tick they arrive, which is the no-buffer case.
#[derive(Clone, Debug, Default)]
pub struct InputBuffer {
    /// Each entry is the tick the input becomes eligible, and the input itself.
    queue: Vec<(u32, Fx, Fx)>,
}

impl InputBuffer {
    pub fn new() -> Self {
        Self { queue: Vec::new() }
    }

    /// Accepts an input, eligible `depth` ticks after it arrived.
    pub fn push(&mut self, arrived_tick: u32, depth: u8, dx: Fx, dy: Fx) {
        self.queue
            .push((arrived_tick.saturating_add(depth as u32), dx, dy));
    }

    /// Removes and returns every input whose hold has expired, oldest first.
    ///
    /// Order is preserved because the server applies each one as a separate step, and
    /// two inputs applied in the wrong order integrate to a different position.
    pub fn release(&mut self, tick: u32) -> Vec<(Fx, Fx)> {
        let mut out = Vec::new();
        self.queue.retain(|&(due, dx, dy)| {
            if due <= tick {
                out.push((dx, dy));
                false
            } else {
                true
            }
        });
        out
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

/// Inputs the client has sent but the server has not confirmed.
///
/// Bounded, because an unbounded buffer under sustained loss is a slow leak that
/// only shows up in long runs.
#[derive(Clone, Debug, Default)]
pub struct InputHistory {
    entries: Vec<PendingInput>,
}

impl InputHistory {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn push(&mut self, input: PendingInput) {
        self.entries.push(input);
        if self.entries.len() > HISTORY_TICKS {
            self.entries.remove(0);
        }
    }

    /// Drops everything the server has already accounted for.
    ///
    /// Keeps strictly greater than the acknowledgement, because it names the last
    /// input the server applied, and replaying that one on top of a state which
    /// already contains it applies it twice. Relaxing this to `>=` is exactly the
    /// off-by-one the phase doc flags; `unacknowledged_after` pins both directions.
    pub fn acknowledge(&mut self, sequence: u32) {
        self.entries.retain(|e| e.sequence > sequence);
    }

    pub fn pending(&self) -> &[PendingInput] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StateSample {
    pub tick: u32,
    pub body: Body,
}

/// Authoritative states, newest last.
///
/// Interpolation reads two adjacent samples out of this. "Adjacent" means adjacent
/// in this buffer, not adjacent in tick number: after a dropped packet the two
/// surrounding samples have a gap between them, and interpolating across that gap is
/// correct. Interpolating between non-adjacent *entries* is the bug.
#[derive(Clone, Debug, Default)]
pub struct StateBuffer {
    samples: Vec<StateSample>,
}

impl StateBuffer {
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
        }
    }

    /// Inserts in tick order and ignores a tick already held.
    ///
    /// Out-of-order arrival is normal on a reordering link, so a naive push would
    /// leave the buffer unsorted and make interpolation walk backwards.
    pub fn insert(&mut self, sample: StateSample) {
        match self.samples.binary_search_by_key(&sample.tick, |s| s.tick) {
            Ok(_) => {}
            Err(index) => {
                self.samples.insert(index, sample);
                if self.samples.len() > HISTORY_TICKS {
                    self.samples.remove(0);
                }
            }
        }
    }

    pub fn latest(&self) -> Option<StateSample> {
        self.samples.last().copied()
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// The state as it was at `tick`, for server rewind.
    ///
    /// Returns the newest sample at or before the requested tick, which is what the
    /// firing client was actually looking at. Returning the nearest sample in either
    /// direction would let the server resolve a shot against a position the client
    /// had not seen yet.
    pub fn at_or_before(&self, tick: u32) -> Option<StateSample> {
        self.samples.iter().rev().find(|s| s.tick <= tick).copied()
    }

    /// The two samples surrounding `tick`, for interpolation.
    ///
    /// `None` when the buffer does not straddle the requested tick, which is the
    /// caller's signal to extrapolate instead of inventing a value.
    pub fn straddling(&self, tick: u32) -> Option<(StateSample, StateSample)> {
        if self.samples.len() < 2 {
            return None;
        }
        for pair in self.samples.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if a.tick <= tick && tick <= b.tick {
                return Some((a, b));
            }
        }
        None
    }
}

/// Position between two authoritative states.
///
/// `delay_ticks` is subtracted from the current tick, so the caller passes a render
/// tick already in the past. Confusing ticks with milliseconds here yields a delay
/// wrong by the tick interval, so this takes ticks and never converts.
pub fn interpolate(a: StateSample, b: StateSample, tick: u32) -> Body {
    if b.tick <= a.tick {
        return b.body;
    }
    let span = Fx::from_num(b.tick - a.tick);
    let into = Fx::from_num(tick.saturating_sub(a.tick));
    let t = clamp(into / span, Fx::ZERO, Fx::from_num(1));
    Body {
        x: a.body.x + (b.body.x - a.body.x) * t,
        y: a.body.y + (b.body.y - a.body.y) * t,
        vx: a.body.vx + (b.body.vx - a.body.vx) * t,
        vy: a.body.vy + (b.body.vy - a.body.vy) * t,
    }
}

/// Projects forward from the last known state along its velocity.
///
/// `limit_ticks` bounds how far, because an unbounded projection during a loss burst
/// sends the entity far away and the correction that follows dominates every metric.
pub fn extrapolate(from: StateSample, tick: u32, dt: Fx, limit_ticks: u8) -> Body {
    let ahead = tick.saturating_sub(from.tick).min(limit_ticks as u32);
    let elapsed = Fx::from_num(ahead) * dt;
    Body {
        x: from.body.x + from.body.vx * elapsed,
        y: from.body.y + from.body.vy * elapsed,
        vx: from.body.vx,
        vy: from.body.vy,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Correction {
    pub body: Body,
    pub magnitude: Fx,
    pub snapped: bool,
}

/// Moves the client toward the authoritative state.
///
/// Below `snap_threshold` the error is blended away over several ticks so motion
/// stays smooth; at or beyond it the client teleports, because blending a large
/// error is a long visible slide that reads worse than a single jump.
///
/// `blend_rate` is the share of the error *left in place* each tick, matching the
/// schema's "0 = snap instantly, 1 = never converge".
pub fn apply_correction(
    predicted: Body,
    authoritative: Body,
    blend_rate: Fx,
    snap_threshold: Fx,
) -> Correction {
    let dx = authoritative.x - predicted.x;
    let dy = authoritative.y - predicted.y;
    let magnitude = sqrt(dx * dx + dy * dy);

    if magnitude >= snap_threshold {
        return Correction {
            body: authoritative,
            magnitude,
            snapped: true,
        };
    }

    let keep = clamp(blend_rate, Fx::ZERO, Fx::from_num(1));
    Correction {
        body: Body {
            x: predicted.x + dx * (Fx::from_num(1) - keep),
            y: predicted.y + dy * (Fx::from_num(1) - keep),
            vx: authoritative.vx,
            vy: authoritative.vy,
        },
        magnitude,
        snapped: false,
    }
}

/// How far back the server may rewind, in ticks.
///
/// Converts the configured millisecond limit using the scenario's tick interval, so
/// changing tick rate changes the tick depth and not the wall-clock guarantee.
pub fn rewind_limit_ticks(limit_ms: u32, tick_interval_ms: Fx) -> u32 {
    if tick_interval_ms <= Fx::ZERO {
        return 0;
    }
    (Fx::from_num(limit_ms) / tick_interval_ms).to_num::<u32>()
}

/// The tick the server resolves a shot against.
///
/// Clamped to the rewind limit, so a client with very high latency cannot make the
/// server resolve against arbitrarily old state.
pub fn rewind_target_tick(now: u32, client_view_tick: u32, limit_ticks: u32) -> u32 {
    let oldest = now.saturating_sub(limit_ticks);
    client_view_tick.max(oldest).min(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::{abs, from_int, ratio, to_f64_for_display};

    fn body(x: i32, y: i32) -> Body {
        Body {
            x: from_int(x),
            y: from_int(y),
            vx: Fx::ZERO,
            vy: Fx::ZERO,
        }
    }

    fn moving(x: i32, vx: i32) -> Body {
        Body {
            x: from_int(x),
            y: Fx::ZERO,
            vx: from_int(vx),
            vy: Fx::ZERO,
        }
    }

    fn input(sequence: u32) -> PendingInput {
        PendingInput {
            sequence,
            tick: sequence,
            dx: from_int(1),
            dy: Fx::ZERO,
        }
    }

    /// The acknowledgement boundary, both directions at once.
    ///
    /// This is the single most likely defect in the phase, so it gets an exact
    /// expectation rather than a range. Acknowledging sequence 3 must leave 4 and 5
    /// and must not leave 3.
    #[test]
    fn unacknowledged_after() {
        let mut history = InputHistory::new();
        for s in 1..=5 {
            history.push(input(s));
        }
        history.acknowledge(3);
        let left: Vec<u32> = history.pending().iter().map(|e| e.sequence).collect();
        assert_eq!(left, vec![4, 5]);
    }

    #[test]
    fn acknowledging_everything_empties_the_history() {
        let mut history = InputHistory::new();
        for s in 1..=5 {
            history.push(input(s));
        }
        history.acknowledge(5);
        assert!(history.is_empty());
    }

    #[test]
    fn acknowledging_nothing_keeps_every_input() {
        let mut history = InputHistory::new();
        for s in 1..=5 {
            history.push(input(s));
        }
        history.acknowledge(0);
        assert_eq!(history.len(), 5);
    }

    /// A stale acknowledgement arriving after a newer one must not resurrect inputs.
    #[test]
    fn a_late_acknowledgement_does_not_restore_dropped_inputs() {
        let mut history = InputHistory::new();
        for s in 1..=5 {
            history.push(input(s));
        }
        history.acknowledge(4);
        history.acknowledge(2);
        let left: Vec<u32> = history.pending().iter().map(|e| e.sequence).collect();
        assert_eq!(left, vec![5]);
    }

    #[test]
    fn a_zero_depth_buffer_releases_immediately() {
        let mut buffer = InputBuffer::new();
        buffer.push(10, 0, from_int(1), Fx::ZERO);
        assert_eq!(buffer.release(10).len(), 1);
        assert!(buffer.is_empty());
    }

    #[test]
    fn an_input_waits_exactly_its_depth() {
        let mut buffer = InputBuffer::new();
        buffer.push(10, 3, from_int(1), Fx::ZERO);
        assert!(buffer.release(12).is_empty(), "released a tick early");
        assert_eq!(buffer.release(13).len(), 1);
    }

    /// Two inputs applied in the wrong order integrate to a different position, so
    /// the queue has to come out oldest first.
    #[test]
    fn released_inputs_keep_their_arrival_order() {
        let mut buffer = InputBuffer::new();
        buffer.push(0, 2, from_int(1), Fx::ZERO);
        buffer.push(1, 2, from_int(2), Fx::ZERO);
        let out = buffer.release(5);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, from_int(1));
        assert_eq!(out[1].0, from_int(2));
    }

    /// The buffer holds inputs, it does not drop them. Anything not yet due stays.
    #[test]
    fn a_release_leaves_inputs_that_are_not_due() {
        let mut buffer = InputBuffer::new();
        buffer.push(0, 1, from_int(1), Fx::ZERO);
        buffer.push(0, 9, from_int(2), Fx::ZERO);
        assert_eq!(buffer.release(2).len(), 1);
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.release(9).len(), 1);
    }

    #[test]
    fn input_history_is_bounded() {
        let mut history = InputHistory::new();
        for s in 0..(HISTORY_TICKS as u32 * 3) {
            history.push(input(s));
        }
        assert_eq!(history.len(), HISTORY_TICKS);
    }

    #[test]
    fn state_buffer_orders_out_of_order_arrivals() {
        let mut buffer = StateBuffer::new();
        for tick in [5u32, 1, 4, 2, 3] {
            buffer.insert(StateSample {
                tick,
                body: body(tick as i32, 0),
            });
        }
        assert_eq!(buffer.latest().expect("not empty").tick, 5);
        let (a, b) = buffer.straddling(3).expect("straddles 3");
        assert!(a.tick <= 3 && 3 <= b.tick);
    }

    #[test]
    fn state_buffer_ignores_a_duplicate_tick() {
        let mut buffer = StateBuffer::new();
        buffer.insert(StateSample {
            tick: 1,
            body: body(1, 0),
        });
        buffer.insert(StateSample {
            tick: 1,
            body: body(99, 0),
        });
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.latest().expect("not empty").body.x, from_int(1));
    }

    #[test]
    fn rewind_reads_the_state_the_client_was_looking_at() {
        let mut buffer = StateBuffer::new();
        for tick in [0u32, 4, 8, 12] {
            buffer.insert(StateSample {
                tick,
                body: body(tick as i32, 0),
            });
        }
        // tick 6 falls between samples, so the client saw the one at 4
        assert_eq!(buffer.at_or_before(6).expect("has history").tick, 4);
        assert_eq!(buffer.at_or_before(8).expect("has history").tick, 8);
        // nothing recorded that early
        assert!(buffer.at_or_before(0).is_some());
        assert_eq!(buffer.at_or_before(100).expect("clamps to newest").tick, 12);
    }

    /// Hand-computed: halfway between 0 and 10 is 5.
    #[test]
    fn interpolation_reaches_the_hand_computed_midpoint() {
        let a = StateSample {
            tick: 0,
            body: body(0, 0),
        };
        let b = StateSample {
            tick: 10,
            body: body(10, 0),
        };
        assert_eq!(interpolate(a, b, 5).x, from_int(5));
        assert_eq!(interpolate(a, b, 0).x, Fx::ZERO);
        assert_eq!(interpolate(a, b, 10).x, from_int(10));
    }

    #[test]
    fn interpolation_clamps_outside_the_span() {
        let a = StateSample {
            tick: 10,
            body: body(0, 0),
        };
        let b = StateSample {
            tick: 20,
            body: body(10, 0),
        };
        assert_eq!(interpolate(a, b, 5).x, Fx::ZERO);
        assert_eq!(interpolate(a, b, 99).x, from_int(10));
    }

    /// After a dropped packet the surrounding samples have a tick gap. Interpolating
    /// across it is correct, and the midpoint must respect the real span rather than
    /// assuming consecutive ticks.
    #[test]
    fn interpolation_spans_a_gap_left_by_a_dropped_packet() {
        let a = StateSample {
            tick: 0,
            body: body(0, 0),
        };
        let b = StateSample {
            tick: 4,
            body: body(8, 0),
        };
        // two ticks into a four tick span is half the distance
        assert_eq!(interpolate(a, b, 2).x, from_int(4));
    }

    #[test]
    fn extrapolation_projects_along_velocity() {
        let from = StateSample {
            tick: 0,
            body: moving(0, 64),
        };
        // 64 units per second at 1/64 s per tick is 1 unit per tick
        let out = extrapolate(from, 4, ratio(1, 64), 10);
        assert_eq!(out.x, from_int(4));
    }

    #[test]
    fn extrapolation_stops_at_its_limit() {
        let from = StateSample {
            tick: 0,
            body: moving(0, 64),
        };
        let limited = extrapolate(from, 100, ratio(1, 64), 5);
        // capped at 5 ticks regardless of how far ahead the caller asked
        assert_eq!(limited.x, from_int(5));
    }

    #[test]
    fn a_correction_beyond_the_threshold_snaps() {
        let out = apply_correction(body(0, 0), body(100, 0), ratio(8, 10), from_int(50));
        assert!(out.snapped);
        assert_eq!(out.body.x, from_int(100));
        assert_eq!(out.magnitude, from_int(100));
    }

    /// Hand-computed: keeping 80% of a 10 unit error moves 2 units.
    ///
    /// Compared within a tolerance rather than exactly, because 8/10 is not a dyadic
    /// rational and so has no exact Q32.32 representation. The residual is about
    /// 2e-9, which is the representation and not a drifting calculation.
    #[test]
    fn a_correction_below_the_threshold_blends_by_the_rate() {
        let out = apply_correction(body(0, 0), body(10, 0), ratio(8, 10), from_int(50));
        assert!(!out.snapped);
        assert!(
            abs(out.body.x - from_int(2)) < ratio(1, 1_000_000),
            "blended to {} rather than 2",
            to_f64_for_display(out.body.x)
        );
        assert_eq!(out.magnitude, from_int(10));
    }

    /// A blend rate that is exactly representable must land exactly, which separates
    /// the representation residual above from an error in the arithmetic.
    #[test]
    fn a_dyadic_blend_rate_lands_exactly() {
        let out = apply_correction(body(0, 0), body(8, 0), ratio(1, 2), from_int(50));
        assert_eq!(out.body.x, from_int(4));
    }

    #[test]
    fn a_blend_rate_of_zero_lands_exactly_on_the_authoritative_state() {
        let out = apply_correction(body(0, 0), body(10, 0), Fx::ZERO, from_int(50));
        assert_eq!(out.body.x, from_int(10));
        assert!(!out.snapped);
    }

    /// Repeated blending must converge, otherwise the client trails forever.
    #[test]
    fn repeated_blending_converges_on_the_target() {
        let mut current = body(0, 0);
        let target = body(10, 0);
        for _ in 0..64 {
            current = apply_correction(current, target, ratio(8, 10), from_int(50)).body;
        }
        assert!(
            to_f64_for_display(abs(current.x - target.x)) < 0.01,
            "blending stalled at {}",
            to_f64_for_display(current.x)
        );
    }

    #[test]
    fn rewind_limit_converts_milliseconds_to_ticks() {
        // 200 ms at 15.625 ms per tick is 12 ticks
        assert_eq!(rewind_limit_ticks(200, ratio(1000, 64)), 12);
        // the same limit at double the rate is double the ticks
        assert_eq!(rewind_limit_ticks(200, ratio(1000, 128)), 25);
        assert_eq!(rewind_limit_ticks(200, Fx::ZERO), 0);
    }

    #[test]
    fn rewind_never_exceeds_its_window() {
        // asking to rewind to tick 10 with a 5 tick limit at tick 100 clamps to 95
        assert_eq!(rewind_target_tick(100, 10, 5), 95);
        // a target inside the window is honoured
        assert_eq!(rewind_target_tick(100, 97, 5), 97);
        // and a target in the future clamps to now
        assert_eq!(rewind_target_tick(100, 150, 5), 100);
    }
}
