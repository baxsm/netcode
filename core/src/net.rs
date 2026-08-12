//! Seeded network emulation: delay, jitter, loss, reordering, duplication.
//!
//! Jitter is right-skewed, not uniform. Real delay has a floor set by distance and a
//! long tail from queueing, so a symmetric model hides the late packets that force
//! corrections and biases every recommendation kind. This follows netem's
//! `paretonormal`: a bell-like body plus a pareto tail. Loss follows netem's other
//! model, Gilbert-Elliott, because real loss arrives in bursts.

use crate::fx::{from_int, ratio, Fx};
use crate::rng::Rng64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LossModel {
    /// Each packet drops independently. Simple, and wrong for anything but a clean link.
    Independent,
    /// Two-state burst loss. `good_to_bad` and `bad_to_good` are per-mille transition
    /// probabilities; while in the bad state, packets drop at `bad_loss_pct`.
    GilbertElliott {
        good_to_bad_permille: u32,
        bad_to_good_permille: u32,
        bad_loss_pct: u32,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct NetworkSegment {
    pub weight: Fx,
    pub rtt_mean_ms: u32,
    pub rtt_jitter_ms: u32,
    pub loss_pct: u32,
    pub reorder_pct: u32,
    pub duplicate_pct: u32,
    pub loss_model: LossModel,
}

impl Default for NetworkSegment {
    fn default() -> Self {
        Self {
            weight: from_int(1),
            rtt_mean_ms: 0,
            rtt_jitter_ms: 0,
            loss_pct: 0,
            reorder_pct: 0,
            duplicate_pct: 0,
            loss_model: LossModel::Independent,
        }
    }
}

impl NetworkSegment {
    pub fn perfect() -> Self {
        Self::default()
    }

    pub fn lan() -> Self {
        Self {
            rtt_mean_ms: 4,
            rtt_jitter_ms: 1,
            ..Self::default()
        }
    }

    pub fn good_broadband() -> Self {
        Self {
            rtt_mean_ms: 30,
            rtt_jitter_ms: 5,
            loss_pct: 0,
            ..Self::default()
        }
    }

    pub fn average_broadband() -> Self {
        Self {
            rtt_mean_ms: 60,
            rtt_jitter_ms: 15,
            loss_pct: 1,
            ..Self::default()
        }
    }

    pub fn mobile_4g() -> Self {
        Self {
            rtt_mean_ms: 90,
            rtt_jitter_ms: 40,
            loss_pct: 1,
            reorder_pct: 1,
            ..Self::default()
        }
    }

    pub fn transcontinental() -> Self {
        Self {
            rtt_mean_ms: 180,
            rtt_jitter_ms: 25,
            loss_pct: 1,
            ..Self::default()
        }
    }

    /// High jitter plus burst loss. The profile a configuration has to survive rather
    /// than the one it is tuned for.
    pub fn hostile() -> Self {
        Self {
            rtt_mean_ms: 200,
            rtt_jitter_ms: 80,
            loss_pct: 5,
            reorder_pct: 3,
            duplicate_pct: 1,
            loss_model: LossModel::GilbertElliott {
                good_to_bad_permille: 20,
                bad_to_good_permille: 300,
                bad_loss_pct: 50,
            },
            ..Self::default()
        }
    }

    /// One-way delay is half the round trip.
    fn one_way_mean_ms(&self) -> Fx {
        ratio(self.rtt_mean_ms as i32, 2)
    }

    fn one_way_jitter_ms(&self) -> Fx {
        ratio(self.rtt_jitter_ms as i32, 2)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Packet {
    pub send_tick: u32,
    pub arrive_tick: u32,
    pub payload: PacketPayload,
    /// Distinguishes a duplicate from its original when both arrive.
    pub sequence: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PacketPayload {
    /// Client to server. The input the client applied locally at `input_tick`.
    ///
    /// `sequence` numbers the input itself rather than the packet, so a duplicate
    /// carries the same sequence as its original and the server can tell the two
    /// apart from a genuinely new input.
    Input {
        entity_id: u16,
        dx: Fx,
        dy: Fx,
        input_tick: u32,
        sequence: u32,
    },
    /// Server to client. Authoritative state for one entity.
    ///
    /// `last_input_sequence` is the acknowledgement reconciliation replays from: the
    /// last client input this state already includes. Getting it wrong by one is the
    /// defect the phase doc calls the most likely in the phase, so it is carried
    /// explicitly rather than inferred from the tick.
    State {
        entity_id: u16,
        x: Fx,
        y: Fx,
        vx: Fx,
        vy: Fx,
        server_tick: u32,
        last_input_sequence: u32,
    },
}

/// A link in one direction. Two of these make a connection.
pub struct Link {
    segment: NetworkSegment,
    queue: Vec<Packet>,
    next_sequence: u32,
    in_bad_state: bool,
    sent: u32,
    dropped: u32,
    delivered: u32,
    delay_total_ms: Fx,
}

impl Link {
    pub fn new(segment: NetworkSegment) -> Self {
        Self {
            segment,
            queue: Vec::new(),
            next_sequence: 0,
            in_bad_state: false,
            sent: 0,
            dropped: 0,
            delivered: 0,
            delay_total_ms: Fx::ZERO,
        }
    }

    /// Draws a one-way delay in milliseconds.
    ///
    /// Body: the average of four uniforms, which concentrates around the mean without
    /// needing a transcendental for a true Gaussian. Tail: a Pareto draw applied to a
    /// minority of packets, which is what produces the late arrivals that matter.
    fn draw_delay_ms(&self, rng: &mut Rng64) -> Fx {
        let mean = self.segment.one_way_mean_ms();
        let jitter = self.segment.one_way_jitter_ms();
        if jitter == Fx::ZERO {
            return mean;
        }

        // four averaged uniforms in [-1, 1], a bell-ish body with no transcendental
        let mut acc = Fx::ZERO;
        for _ in 0..4 {
            acc += rng.unit() * from_int(2) - from_int(1);
        }
        let body = mean + (acc / from_int(4)) * jitter;

        // pareto tail on roughly one packet in eight. inverse-CDF for alpha = 1 is
        // 1/u, clamped so a near-zero draw cannot produce an unbounded delay
        let delayed = if rng.chance(125, 1000) {
            let u = rng.unit().max(ratio(1, 64));
            let factor = from_int(1) / u;
            body + jitter * factor.min(from_int(8))
        } else {
            body
        };

        delayed.max(Fx::ZERO)
    }

    fn drops(&mut self, rng: &mut Rng64) -> bool {
        match self.segment.loss_model {
            LossModel::Independent => rng.chance(self.segment.loss_pct, 100),
            LossModel::GilbertElliott {
                good_to_bad_permille,
                bad_to_good_permille,
                bad_loss_pct,
            } => {
                // transition first, then decide, so a burst starts on the packet that
                // entered the bad state rather than the one after it
                if self.in_bad_state {
                    if rng.chance(bad_to_good_permille, 1000) {
                        self.in_bad_state = false;
                    }
                } else if rng.chance(good_to_bad_permille, 1000) {
                    self.in_bad_state = true;
                }

                if self.in_bad_state {
                    rng.chance(bad_loss_pct, 100)
                } else {
                    rng.chance(self.segment.loss_pct, 100)
                }
            }
        }
    }

    /// Queues a packet, applying loss, delay, reordering and duplication.
    pub fn send(&mut self, rng: &mut Rng64, now: u32, tick_ms: Fx, payload: PacketPayload) {
        self.sent += 1;

        if self.drops(rng) {
            self.dropped += 1;
            return;
        }

        let delay_ms = self.draw_delay_ms(rng);
        self.delay_total_ms += delay_ms;

        let delay_ticks = if tick_ms > Fx::ZERO {
            (delay_ms / tick_ms).to_num::<i32>().max(0) as u32
        } else {
            0
        };

        // reordering sends the packet a tick early rather than shuffling the queue, so
        // the effect is visible even when every packet drew the same delay
        let arrive = if self.segment.reorder_pct > 0 && rng.chance(self.segment.reorder_pct, 100) {
            now + delay_ticks.saturating_sub(1)
        } else {
            now + delay_ticks
        };

        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.queue.push(Packet {
            send_tick: now,
            arrive_tick: arrive,
            payload,
            sequence,
        });

        if self.segment.duplicate_pct > 0 && rng.chance(self.segment.duplicate_pct, 100) {
            let sequence = self.next_sequence;
            self.next_sequence += 1;
            self.queue.push(Packet {
                send_tick: now,
                arrive_tick: arrive + 1,
                payload,
                sequence,
            });
        }
    }

    /// Removes and returns everything due at or before `now`.
    ///
    /// Sorted by arrival then sequence so delivery order is total and reproducible.
    /// Iterating an unordered container here would make the whole run non-deterministic.
    pub fn receive(&mut self, now: u32) -> Vec<Packet> {
        let mut due: Vec<Packet> = self
            .queue
            .iter()
            .copied()
            .filter(|p| p.arrive_tick <= now)
            .collect();
        self.queue.retain(|p| p.arrive_tick > now);
        due.sort_by_key(|p| (p.arrive_tick, p.sequence));
        self.delivered += due.len() as u32;
        due
    }

    pub fn sent_count(&self) -> u32 {
        self.sent
    }

    pub fn dropped_count(&self) -> u32 {
        self.dropped
    }

    pub fn delivered_count(&self) -> u32 {
        self.delivered
    }

    /// Mean applied one-way delay over packets that were not dropped.
    pub fn mean_delay_ms(&self) -> Fx {
        let n = self.sent - self.dropped;
        if n == 0 {
            return Fx::ZERO;
        }
        self.delay_total_ms / from_int(n as i32)
    }

    pub fn in_flight(&self) -> usize {
        self.queue.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::to_f64_for_display;

    fn tick_ms() -> Fx {
        ratio(1000, 64)
    }

    fn input(n: u32) -> PacketPayload {
        PacketPayload::Input {
            entity_id: 0,
            dx: Fx::ZERO,
            dy: Fx::ZERO,
            input_tick: n,
            sequence: n,
        }
    }

    #[test]
    fn perfect_link_delivers_in_the_tick_it_was_sent() {
        let mut link = Link::new(NetworkSegment::perfect());
        let mut rng = Rng64::from_seed(1);
        let mut delivered = 0;
        for t in 0..50 {
            link.send(&mut rng, t, tick_ms(), input(t));
            delivered += link.receive(t).len();
        }
        assert_eq!(delivered, 50);
        assert_eq!(link.dropped_count(), 0);
        assert_eq!(link.in_flight(), 0);
    }

    #[test]
    fn delay_holds_packets_until_due() {
        let segment = NetworkSegment {
            rtt_mean_ms: 100,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(2);

        link.send(&mut rng, 0, tick_ms(), input(0));
        // 50 ms one way at 15.625 ms per tick is 3 ticks
        assert_eq!(link.receive(0).len(), 0);
        assert_eq!(link.receive(2).len(), 0);
        assert_eq!(link.receive(3).len(), 1);
    }

    #[test]
    fn measured_loss_converges_to_configured_rate() {
        let segment = NetworkSegment {
            loss_pct: 10,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(3);
        for t in 0..20000 {
            link.send(&mut rng, t, tick_ms(), input(t));
        }
        let rate = link.dropped_count() as f64 / link.sent_count() as f64;
        assert!((rate - 0.10).abs() < 0.02, "loss rate was {rate}");
    }

    #[test]
    fn measured_mean_delay_converges_to_configured_mean() {
        let segment = NetworkSegment {
            rtt_mean_ms: 100,
            rtt_jitter_ms: 20,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(4);
        for t in 0..20000 {
            link.send(&mut rng, t, tick_ms(), input(t));
        }
        // the pareto tail pushes the mean above the configured centre on purpose, so
        // the assertion is one-sided: at least the mean, and not unboundedly above it
        let mean = to_f64_for_display(link.mean_delay_ms());
        assert!(mean >= 50.0, "mean {mean} fell below the one-way centre");
        assert!(mean < 65.0, "mean {mean} suggests the tail is unbounded");
    }

    #[test]
    fn jitter_produces_a_right_skewed_spread() {
        let segment = NetworkSegment {
            rtt_mean_ms: 100,
            rtt_jitter_ms: 20,
            ..NetworkSegment::default()
        };
        let link = Link::new(segment);
        let mut rng = Rng64::from_seed(5);

        let mut samples: Vec<f64> = (0..8000)
            .map(|_| to_f64_for_display(link.draw_delay_ms(&mut rng)))
            .collect();
        samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in fixed point"));

        let median = samples[samples.len() / 2];
        let p99 = samples[samples.len() * 99 / 100];
        let min = samples[0];

        // the tail must reach far above the median while the floor stays near it.
        // a uniform model would fail this, which is the point of the test
        assert!(
            p99 > median * 1.3,
            "p99 {p99} is not far enough above median {median}"
        );
        assert!(
            min > median * 0.5,
            "min {min} is too far below median {median}"
        );
    }

    #[test]
    fn gilbert_elliott_loses_more_in_bursts_than_independent() {
        let burst = NetworkSegment {
            loss_pct: 1,
            loss_model: LossModel::GilbertElliott {
                good_to_bad_permille: 20,
                bad_to_good_permille: 200,
                bad_loss_pct: 60,
            },
            ..NetworkSegment::default()
        };
        let mut link = Link::new(burst);
        let mut rng = Rng64::from_seed(6);

        let mut longest_run = 0;
        let mut run = 0;
        for t in 0..20000 {
            let before = link.dropped_count();
            link.send(&mut rng, t, tick_ms(), input(t));
            if link.dropped_count() > before {
                run += 1;
                longest_run = longest_run.max(run);
            } else {
                run = 0;
            }
        }

        // independent loss at these rates essentially never produces a run this long,
        // so a long run is evidence the burst model is actually engaged
        assert!(longest_run >= 4, "longest drop run was only {longest_run}");
    }

    #[test]
    fn duplication_delivers_the_payload_twice() {
        let segment = NetworkSegment {
            duplicate_pct: 100,
            rtt_mean_ms: 0,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(7);

        link.send(&mut rng, 0, tick_ms(), input(0));
        let first = link.receive(0);
        let second = link.receive(1);
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].payload, second[0].payload);
        assert_ne!(first[0].sequence, second[0].sequence);
    }

    #[test]
    fn delivery_is_ordered_by_arrival_then_sequence() {
        let segment = NetworkSegment {
            rtt_mean_ms: 60,
            rtt_jitter_ms: 40,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(8);

        for t in 0..200 {
            link.send(&mut rng, t, tick_ms(), input(t));
        }
        let got = link.receive(500);
        let mut expected = got.clone();
        expected.sort_by_key(|p| (p.arrive_tick, p.sequence));
        assert_eq!(got, expected);
    }

    #[test]
    fn same_seed_produces_the_same_link_behaviour() {
        let run = || {
            let mut link = Link::new(NetworkSegment::hostile());
            let mut rng = Rng64::from_seed(99);
            let mut arrivals = Vec::new();
            for t in 0..500 {
                link.send(&mut rng, t, tick_ms(), input(t));
                for p in link.receive(t) {
                    arrivals.push((p.arrive_tick, p.sequence));
                }
            }
            (arrivals, link.dropped_count())
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn reordering_can_deliver_a_later_packet_first() {
        let segment = NetworkSegment {
            rtt_mean_ms: 60,
            rtt_jitter_ms: 30,
            reorder_pct: 50,
            ..NetworkSegment::default()
        };
        let mut link = Link::new(segment);
        let mut rng = Rng64::from_seed(10);

        for t in 0..300 {
            link.send(&mut rng, t, tick_ms(), input(t));
        }
        let got = link.receive(1000);
        let out_of_order = got.windows(2).any(|w| {
            let (a, b) = (w[0], w[1]);
            matches!(
                (a.payload, b.payload),
                (
                    PacketPayload::Input { input_tick: x, .. },
                    PacketPayload::Input { input_tick: y, .. }
                ) if y < x
            )
        });
        assert!(
            out_of_order,
            "no reordering observed with reorder_pct at 50"
        );
    }

    #[test]
    fn nothing_is_delivered_twice() {
        let mut link = Link::new(NetworkSegment::mobile_4g());
        let mut rng = Rng64::from_seed(11);
        let mut seen = Vec::new();
        for t in 0..400 {
            link.send(&mut rng, t, tick_ms(), input(t));
            for p in link.receive(t) {
                seen.push(p.sequence);
            }
        }
        let mut unique = seen.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(seen.len(), unique.len());
    }
}
