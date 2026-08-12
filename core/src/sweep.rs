//! The parameter sweep: many configurations, each measured across every seed and
//! every network segment, then aggregated by segment weight.
//!
//! The loop lives here rather than in TypeScript because a single run costs roughly
//! 0.4 ms while a worker round trip costs about the same, so calling across the
//! boundary once per run would spend as much time on messaging as on simulating.
//! One call runs the whole block a worker was given.
//!
//! Aggregation is fixed point for the same reason the simulation is: an `f64` mean
//! would make the result depend on summation order, and the sweep's whole claim is
//! that the same inputs produce the same recommendation everywhere.

use crate::config::NetcodeConfig;
use crate::fx::{from_int, ratio, Fx};
use crate::net::NetworkSegment;
use crate::run::{run, Metrics, RunRequest};
use crate::scenario::Scenario;

/// Weight of one segment in the player population, and the conditions it describes.
pub struct WeightedSegment {
    pub segment: NetworkSegment,
    pub weight: Fx,
}

pub struct SweepRequest<'a> {
    pub scenario: &'a Scenario,
    pub configs: &'a [NetcodeConfig],
    pub segments: &'a [WeightedSegment],
    pub seeds: &'a [u64],
}

/// One configuration's aggregate result across the whole population.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SweepPoint {
    pub config_hash: u64,
    pub aggregated: Metrics,
    pub responsiveness_score: Fx,
    pub smoothness_score: Fx,
    /// Combined hash of every run behind this point. Two sweeps agreeing here agree
    /// on every underlying simulation, not only on the averages.
    pub state_hash: u64,
}

/// Reference values the scores divide by, so a score means the same thing in every
/// sweep rather than only within the one that produced it.
///
/// Normalizing against the sweep's own range would make a configuration's score
/// depend on which other configurations it was run beside, so the same config could
/// score 0.2 in one sweep and 0.8 in another without changing. That also leaves
/// Phase 5's CI baseline nothing stable to pin against.
///
/// The anchors are round numbers at the edge of what a shipped game would tolerate,
/// chosen so ordinary results land inside 0..1 without clipping. A score above 1 is
/// meaningful rather than an error: it says the configuration is worse than the worst
/// value considered acceptable.
pub mod anchors {
    use crate::fx::{from_int, Fx};

    /// Input latency a player notices as unresponsive.
    pub fn input_latency_ms() -> Fx {
        from_int(250)
    }

    /// Peeker's advantage roughly at the published uncompensated baseline.
    pub fn peekers_advantage_ms() -> Fx {
        from_int(200)
    }

    /// Divergence that reads as the client and server being in different places.
    ///
    /// Measured rather than assumed. Across the four shipped profiles and the whole
    /// configuration grid, aggregated p99 runs from 0.65 units to 3.67. An anchor of
    /// 100, which the first version of this used, compressed every real result into
    /// the bottom four percent of the range and left the term unable to separate
    /// anything.
    pub fn divergence_units() -> Fx {
        from_int(5)
    }

    /// A rubber-band jump that a player sees as a teleport.
    ///
    /// Worst corrections run from 2.6 to 13.3 units over the same span, so this is a
    /// separate anchor rather than shared with divergence. Sharing one would put the
    /// two terms on different effective scales and let the larger silently dominate,
    /// which is the unnormalized-comparison failure this scoring exists to avoid.
    pub fn correction_units() -> Fx {
        from_int(15)
    }
}

/// How much each component contributes to its composite score.
///
/// Fixed in code and deliberately not exposed as a setting. A weight the user can
/// change is a weight that decides which configuration wins, which would make the
/// recommendation a restatement of what they already believed.
pub mod weights {
    use crate::fx::{ratio, Fx};

    /// Input latency against peeker's advantage inside responsiveness.
    ///
    /// Latency carries more because it applies to every action a player takes, while
    /// peeker's advantage is one situation, and because peeker's advantage is a closed
    /// form over tick rate and frame rate that the sweep barely moves.
    pub fn input_latency() -> Fx {
        ratio(7, 10)
    }

    pub fn peekers_advantage() -> Fx {
        ratio(3, 10)
    }

    /// Divergence p99 against worst correction inside smoothness.
    ///
    /// p99 leads because it is the error a player actually sees rather than the mean,
    /// which sits near zero whenever the link is quiet.
    ///
    /// **Correction frequency is deliberately not a term.** Measuring it showed a
    /// correction fires on essentially every tick on any imperfect link, roughly 2,900
    /// per minute at 64 Hz, and that rate is set by the network rather than by the
    /// tuning: it barely moves across the whole configuration grid. Included, it
    /// contributed about 0.94 of a 1.05 total and drowned out both terms that do
    /// discriminate, so the front collapsed to two points. What varies with the
    /// configuration is how far each correction moves the player, which is the
    /// magnitude term below.
    pub fn divergence_p99() -> Fx {
        ratio(6, 10)
    }

    pub fn correction_max() -> Fx {
        ratio(4, 10)
    }
}

/// Client frame rate the peeker's advantage term is evaluated at.
///
/// Fixed rather than swept because it is a property of the player's machine, not of
/// the netcode being tuned. 60 is the conservative choice: a lower frame rate makes
/// the client buffering term larger, so tuning against it does not assume hardware
/// the player may not have.
pub const SCORING_CLIENT_FPS: u32 = 60;

/// Sums a metric across runs in fixed point, then divides once.
///
/// Accumulating and dividing at the end rather than averaging incrementally keeps the
/// result independent of how the runs were split across workers.
#[derive(Clone, Copy, Default)]
struct Accumulator {
    divergence_mean: Fx,
    divergence_p99: Fx,
    divergence_max: Fx,
    correction_count: Fx,
    correction_magnitude_mean: Fx,
    correction_magnitude_max: Fx,
    input_latency_mean_ms: Fx,
    packets_sent: Fx,
    packets_dropped: Fx,
    sampled_ticks: Fx,
    rollback_count: Fx,
    rollback_depth_mean: Fx,
    snap_count: Fx,
    hit_registration_accuracy: Fx,
    shots_fired: Fx,
    shots_confirmed: Fx,
}

impl Accumulator {
    /// Adds one run's metrics scaled by its share of the total.
    ///
    /// `max` fields take the largest value rather than the weighted sum. A worst case
    /// averaged across the population stops being a worst case, and the worst
    /// rubber-band a player will see is the number the tool is asked for.
    fn add(&mut self, m: &Metrics, share: Fx) {
        self.divergence_mean += m.divergence_mean * share;
        self.divergence_p99 += m.divergence_p99 * share;
        self.divergence_max = fx_max(self.divergence_max, m.divergence_max);
        self.correction_count += from_int(m.correction_count as i32) * share;
        self.correction_magnitude_mean += m.correction_magnitude_mean * share;
        self.correction_magnitude_max =
            fx_max(self.correction_magnitude_max, m.correction_magnitude_max);
        self.input_latency_mean_ms += m.input_latency_mean_ms * share;
        self.packets_sent += from_int(m.packets_sent as i32) * share;
        self.packets_dropped += from_int(m.packets_dropped as i32) * share;
        self.sampled_ticks += from_int(m.sampled_ticks as i32) * share;
        self.rollback_count += from_int(m.rollback_count as i32) * share;
        self.rollback_depth_mean += m.rollback_depth_mean * share;
        self.snap_count += from_int(m.snap_count as i32) * share;
        self.hit_registration_accuracy += m.hit_registration_accuracy * share;
        self.shots_fired += from_int(m.shots_fired as i32) * share;
        self.shots_confirmed += from_int(m.shots_confirmed as i32) * share;
    }

    /// The mean over the runs that were accumulated. Division rather than a multiply
    /// by the reciprocal, which would round a second time.
    ///
    /// `max` fields pass through: the worst of N runs is already the worst, and
    /// dividing it would report a value no run produced.
    fn divided_by(self, count: Fx) -> Self {
        if count <= Fx::ZERO {
            return self;
        }
        Self {
            divergence_mean: self.divergence_mean / count,
            divergence_p99: self.divergence_p99 / count,
            divergence_max: self.divergence_max,
            correction_count: self.correction_count / count,
            correction_magnitude_mean: self.correction_magnitude_mean / count,
            correction_magnitude_max: self.correction_magnitude_max,
            input_latency_mean_ms: self.input_latency_mean_ms / count,
            packets_sent: self.packets_sent / count,
            packets_dropped: self.packets_dropped / count,
            sampled_ticks: self.sampled_ticks / count,
            rollback_count: self.rollback_count / count,
            rollback_depth_mean: self.rollback_depth_mean / count,
            snap_count: self.snap_count / count,
            hit_registration_accuracy: self.hit_registration_accuracy / count,
            shots_fired: self.shots_fired / count,
            shots_confirmed: self.shots_confirmed / count,
        }
    }

    /// Folds one segment's totals in, scaled by that segment's share.
    ///
    /// `max` fields carry across unscaled: a worst case is the worst value observed,
    /// and multiplying it by a population share would report a rubber-band jump no
    /// player experienced.
    fn merge(&mut self, other: Self, scale: Fx) {
        self.divergence_mean += other.divergence_mean * scale;
        self.divergence_p99 += other.divergence_p99 * scale;
        self.divergence_max = fx_max(self.divergence_max, other.divergence_max);
        self.correction_count += other.correction_count * scale;
        self.correction_magnitude_mean += other.correction_magnitude_mean * scale;
        self.correction_magnitude_max = fx_max(
            self.correction_magnitude_max,
            other.correction_magnitude_max,
        );
        self.input_latency_mean_ms += other.input_latency_mean_ms * scale;
        self.packets_sent += other.packets_sent * scale;
        self.packets_dropped += other.packets_dropped * scale;
        self.sampled_ticks += other.sampled_ticks * scale;
        self.rollback_count += other.rollback_count * scale;
        self.rollback_depth_mean += other.rollback_depth_mean * scale;
        self.snap_count += other.snap_count * scale;
        self.hit_registration_accuracy += other.hit_registration_accuracy * scale;
        self.shots_fired += other.shots_fired * scale;
        self.shots_confirmed += other.shots_confirmed * scale;
    }

    /// Counts round to whole numbers because a fractional packet is not a thing a
    /// reader can act on, and the underlying runs each produced an integer.
    fn finish(self) -> Metrics {
        Metrics {
            divergence_mean: self.divergence_mean,
            divergence_p99: self.divergence_p99,
            divergence_max: self.divergence_max,
            correction_count: to_count(self.correction_count),
            correction_magnitude_mean: self.correction_magnitude_mean,
            correction_magnitude_max: self.correction_magnitude_max,
            input_latency_mean_ms: self.input_latency_mean_ms,
            packets_sent: to_count(self.packets_sent),
            packets_dropped: to_count(self.packets_dropped),
            sampled_ticks: to_count(self.sampled_ticks),
            rollback_count: to_count(self.rollback_count),
            rollback_depth_mean: self.rollback_depth_mean,
            snap_count: to_count(self.snap_count),
            hit_registration_accuracy: self.hit_registration_accuracy,
            shots_fired: to_count(self.shots_fired),
            shots_confirmed: to_count(self.shots_confirmed),
        }
    }
}

fn to_count(v: Fx) -> u32 {
    if v <= Fx::ZERO {
        return 0;
    }
    let rounded = (v + ratio(1, 2)).int();
    rounded.to_num::<i64>().clamp(0, u32::MAX as i64) as u32
}

/// Runs one configuration against every seed and every segment, weighted.
///
/// Every seed inside a segment carries the same share, so a segment's contribution is
/// its weight regardless of how many seeds were run. Weighting per run instead would
/// let a segment that happened to get more seeds dominate the aggregate.
pub fn run_point(
    scenario: &Scenario,
    config: NetcodeConfig,
    segments: &[WeightedSegment],
    seeds: &[u64],
) -> SweepPoint {
    if segments.is_empty() || seeds.is_empty() {
        return SweepPoint {
            config_hash: config.config_hash(),
            ..SweepPoint::default()
        };
    }

    let total_weight: Fx = segments
        .iter()
        .fold(Fx::ZERO, |sum, s| sum + fx_max(s.weight, Fx::ZERO));

    // an all-zero set of weights would divide by zero, so every segment counts
    // equally instead. that is a caller error the edge rejects, and falling back
    // beats returning a point full of zeros that reads as a real measurement
    let even = total_weight <= Fx::ZERO;
    let seed_count = from_int(seeds.len() as i32);

    let mut acc = Accumulator::default();
    let mut hasher = crate::hash::Hasher::new();

    for segment in segments {
        let weight = if even {
            ratio(1, segments.len() as i32)
        } else {
            fx_max(segment.weight, Fx::ZERO) / total_weight
        };

        // seeds accumulate at full scale, then the segment mean is taken once by
        // dividing. Scaling each run on the way in instead would round once per seed,
        // and multiplying by a reciprocal rounds again, because a share like a third
        // has no exact fixed-point representation. Both showed up as a differing low
        // bit against the same average computed directly
        let mut per_segment = Accumulator::default();
        for &seed in seeds {
            let result = run(RunRequest {
                scenario,
                segment: segment.segment,
                seed,
                config,
                capture_snapshots: false,
            });
            per_segment.add(&result.metrics, Fx::ONE);
            hasher.write_u64(result.state_hash);
        }

        acc.merge(per_segment.divided_by(seed_count), weight);
    }

    let aggregated = acc.finish();
    SweepPoint {
        config_hash: config.config_hash(),
        aggregated,
        responsiveness_score: responsiveness(&aggregated, scenario, segments),
        smoothness_score: smoothness(&aggregated, scenario),
        state_hash: hasher.finish(),
    }
}

fn fx_max(a: Fx, b: Fx) -> Fx {
    if a > b {
        a
    } else {
        b
    }
}

/// Population mean round trip, used for the peeker's advantage term.
fn weighted_rtt_ms(segments: &[WeightedSegment]) -> u32 {
    let total: Fx = segments
        .iter()
        .fold(Fx::ZERO, |sum, s| sum + fx_max(s.weight, Fx::ZERO));
    if total <= Fx::ZERO {
        // an even split, matching the fallback in `run_point` so the score and the
        // metrics describe the same population
        let sum: u32 = segments.iter().map(|s| s.segment.rtt_mean_ms).sum();
        return sum / segments.len().max(1) as u32;
    }
    let mean = segments.iter().fold(Fx::ZERO, |sum, s| {
        sum + from_int(s.segment.rtt_mean_ms as i32) * (fx_max(s.weight, Fx::ZERO) / total)
    });
    mean.to_num::<i64>().clamp(0, u32::MAX as i64) as u32
}

/// Lower is better. Input latency and peeker's advantage, each against its anchor.
pub fn responsiveness(
    aggregated: &Metrics,
    scenario: &Scenario,
    segments: &[WeightedSegment],
) -> Fx {
    let peekers = crate::peekers::peekers_advantage_ms(crate::peekers::PeekConditions {
        rtt_ms: weighted_rtt_ms(segments),
        tick_rate: scenario.tick_rate,
        client_fps: SCORING_CLIENT_FPS,
    });

    aggregated.input_latency_mean_ms / anchors::input_latency_ms() * weights::input_latency()
        + peekers / anchors::peekers_advantage_ms() * weights::peekers_advantage()
}

/// Lower is better. Divergence p99 and the worst correction, against fixed anchors.
///
/// The scenario is not read: neither term depends on run length. It stays in the
/// signature because `corrections_per_minute` remains the interface's rate readout
/// and the two must keep describing the same run.
pub fn smoothness(aggregated: &Metrics, _scenario: &Scenario) -> Fx {
    aggregated.divergence_p99 / anchors::divergence_units() * weights::divergence_p99()
        + aggregated.correction_magnitude_max / anchors::correction_units()
            * weights::correction_max()
}

/// Corrections scaled to a minute, so the rate does not depend on run length.
///
/// A raw count would make a longer scenario score worse than a shorter one running
/// identical netcode.
pub fn corrections_per_minute(aggregated: &Metrics, scenario: &Scenario) -> Fx {
    if aggregated.sampled_ticks == 0 || scenario.tick_rate == 0 {
        return Fx::ZERO;
    }
    let seconds = from_int(aggregated.sampled_ticks as i32) / from_int(scenario.tick_rate as i32);
    if seconds <= Fx::ZERO {
        return Fx::ZERO;
    }
    from_int(aggregated.correction_count as i32) / seconds * from_int(60)
}

/// Runs every configuration in the request.
pub fn sweep(request: SweepRequest) -> Vec<SweepPoint> {
    request
        .configs
        .iter()
        .map(|&config| run_point(request.scenario, config, request.segments, request.seeds))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boundary::{build_scenario, BuildScenario};
    use crate::config::TechniqueSet;

    fn scenario() -> Scenario {
        build_scenario(&BuildScenario {
            tick_rate: 64,
            duration_ticks: 200,
            accel: 10,
            max_speed: 100,
            friction_permille: 1000,
            bounds: 1000,
            move_from_tick: 0,
            stop_at_tick: 0,
        })
    }

    fn weighted(segment: NetworkSegment, num: i32, den: i32) -> WeightedSegment {
        WeightedSegment {
            segment,
            weight: ratio(num, den),
        }
    }

    #[test]
    fn a_point_is_reproducible() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::average_broadband(), 1, 1)];
        let a = run_point(&s, NetcodeConfig::default(), &segments, &[1, 2, 3]);
        let b = run_point(&s, NetcodeConfig::default(), &segments, &[1, 2, 3]);
        assert_eq!(a, b);
    }

    /// The property the whole sweep rests on: splitting the seed list and running the
    /// halves must not change what any one point reports.
    #[test]
    fn a_point_does_not_depend_on_seed_order() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::mobile_4g(), 1, 1)];
        let forward = run_point(&s, NetcodeConfig::default(), &segments, &[7, 8, 9]);
        let backward = run_point(&s, NetcodeConfig::default(), &segments, &[9, 8, 7]);
        // the aggregate is order independent because it sums before dividing
        assert_eq!(forward.aggregated, backward.aggregated);
    }

    /// Hand-computed against the definition rather than against another run of the
    /// same code, so a consistently wrong weighting cannot read as green.
    #[test]
    fn weighting_matches_a_hand_computed_average() {
        let s = scenario();
        let quiet = NetworkSegment::lan();
        let loud = NetworkSegment::hostile();
        let config = NetcodeConfig::default();

        let each = |segment| {
            run_point(&s, config, &[weighted(segment, 1, 1)], &[4])
                .aggregated
                .divergence_p99
        };
        let a = each(quiet);
        let b = each(loud);

        let mixed = run_point(
            &s,
            config,
            &[weighted(quiet, 3, 4), weighted(loud, 1, 4)],
            &[4],
        );

        let expected = a * ratio(3, 4) + b * ratio(1, 4);
        assert_eq!(mixed.aggregated.divergence_p99, expected);
    }

    /// Seeds inside a segment share that segment's weight rather than each carrying
    /// it, so the aggregate is the mean of the runs and not their sum.
    ///
    /// Every other weighting test runs a single seed, where dividing by the seed count
    /// is a no-op. Removing that division left all of them green while inflating every
    /// metric by the number of seeds, so this is the only test that holds it.
    #[test]
    fn seeds_share_their_segments_weight_rather_than_each_carrying_it() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let segment = NetworkSegment::average_broadband();
        let seeds = [3, 4, 5];

        let each: Vec<Fx> = seeds
            .iter()
            .map(|&seed| {
                run_point(&s, config, &[weighted(segment, 1, 1)], &[seed])
                    .aggregated
                    .divergence_p99
            })
            .collect();
        let expected = each.iter().fold(Fx::ZERO, |sum, &v| sum + v) / from_int(3);

        let together = run_point(&s, config, &[weighted(segment, 1, 1)], &seeds);
        assert_eq!(together.aggregated.divergence_p99, expected);
    }

    /// Adding seeds must not move the aggregate the way adding population would. A
    /// missing division by the seed count reads exactly as a metric that grows with
    /// the sample size.
    #[test]
    fn adding_seeds_does_not_inflate_the_aggregate() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let segments = [weighted(NetworkSegment::good_broadband(), 1, 1)];

        let one = run_point(&s, config, &segments, &[9]);
        let many = run_point(&s, config, &segments, &[9, 9, 9, 9]);

        // the same seed four times must average back to itself
        assert_eq!(
            one.aggregated.divergence_p99,
            many.aggregated.divergence_p99
        );
        assert_eq!(
            one.aggregated.input_latency_mean_ms,
            many.aggregated.input_latency_mean_ms
        );
    }

    /// The methodological point of the product. A configuration measured against a
    /// population that is mostly hostile must not report the quiet result.
    #[test]
    fn shifting_the_population_shifts_the_aggregate() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let mostly_quiet = run_point(
            &s,
            config,
            &[
                weighted(NetworkSegment::lan(), 9, 10),
                weighted(NetworkSegment::hostile(), 1, 10),
            ],
            &[4, 5],
        );
        let mostly_loud = run_point(
            &s,
            config,
            &[
                weighted(NetworkSegment::lan(), 1, 10),
                weighted(NetworkSegment::hostile(), 9, 10),
            ],
            &[4, 5],
        );
        assert!(
            mostly_loud.aggregated.divergence_p99 > mostly_quiet.aggregated.divergence_p99,
            "the segment weights did not reach the aggregate"
        );
    }

    /// Equal weights must produce the plain mean, which is the case a reader assumes
    /// when they have not set weights at all.
    #[test]
    fn equal_weights_produce_the_plain_mean() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let a = NetworkSegment::good_broadband();
        let b = NetworkSegment::transcontinental();

        let single = |segment| {
            run_point(&s, config, &[weighted(segment, 1, 1)], &[11])
                .aggregated
                .input_latency_mean_ms
        };

        let mixed = run_point(&s, config, &[weighted(a, 1, 2), weighted(b, 1, 2)], &[11]);
        let expected = (single(a) + single(b)) / from_int(2);
        assert_eq!(mixed.aggregated.input_latency_mean_ms, expected);
    }

    /// Zero weights would divide by zero. Falling back to an even split beats
    /// returning zeros, which would read as a configuration that measured perfectly.
    #[test]
    fn all_zero_weights_fall_back_to_an_even_split() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let zeroed = run_point(
            &s,
            config,
            &[
                weighted(NetworkSegment::lan(), 0, 1),
                weighted(NetworkSegment::hostile(), 0, 1),
            ],
            &[3],
        );
        let even = run_point(
            &s,
            config,
            &[
                weighted(NetworkSegment::lan(), 1, 2),
                weighted(NetworkSegment::hostile(), 1, 2),
            ],
            &[3],
        );
        assert_eq!(zeroed.aggregated, even.aggregated);
        assert!(zeroed.aggregated.divergence_p99 > Fx::ZERO);
    }

    /// A negative weight is meaningless as a population share, and letting it through
    /// would subtract a segment's results from the aggregate.
    #[test]
    fn a_negative_weight_is_treated_as_zero() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let negative = run_point(
            &s,
            config,
            &[
                weighted(NetworkSegment::lan(), -1, 1),
                weighted(NetworkSegment::hostile(), 1, 1),
            ],
            &[6],
        );
        let only_hostile = run_point(
            &s,
            config,
            &[weighted(NetworkSegment::hostile(), 1, 1)],
            &[6],
        );
        assert_eq!(negative.aggregated, only_hostile.aggregated);
    }

    /// A worst case that gets averaged stops being a worst case.
    #[test]
    fn max_fields_take_the_worst_rather_than_the_mean() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let quiet = NetworkSegment::lan();
        let loud = NetworkSegment::hostile();

        let loud_alone = run_point(&s, config, &[weighted(loud, 1, 1)], &[8])
            .aggregated
            .divergence_max;

        // the hostile segment is a tenth of the population, so an averaged max would
        // land far below what it alone reports
        let mixed = run_point(
            &s,
            config,
            &[weighted(quiet, 9, 10), weighted(loud, 1, 10)],
            &[8],
        );
        assert_eq!(mixed.aggregated.divergence_max, loud_alone);
    }

    #[test]
    fn an_empty_request_returns_an_identified_but_empty_point() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let point = run_point(&s, config, &[], &[1]);
        assert_eq!(point.config_hash, config.config_hash());
        assert_eq!(point.aggregated, Metrics::default());
        assert_eq!(
            run_point(&s, config, &[weighted(NetworkSegment::lan(), 1, 1)], &[]).aggregated,
            Metrics::default()
        );
    }

    /// Techniques exist to make the client smoother, so turning them all off must
    /// cost smoothness. A score that moved the other way would mean the sign is wrong.
    #[test]
    fn no_techniques_scores_worse_on_smoothness_than_all_of_them() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::average_broadband(), 1, 1)];
        let all = run_point(&s, NetcodeConfig::default(), &segments, &[1, 2, 3]);
        let none = run_point(
            &s,
            NetcodeConfig {
                techniques: TechniqueSet::NONE,
                ..NetcodeConfig::default()
            },
            &segments,
            &[1, 2, 3],
        );
        assert!(
            none.smoothness_score > all.smoothness_score,
            "compensation did not improve the smoothness score"
        );
    }

    /// Both scores must be driven by the metrics rather than being constants that
    /// happen to look plausible.
    #[test]
    fn both_scores_respond_to_the_conditions() {
        let s = scenario();
        let config = NetcodeConfig::default();
        let quiet = run_point(&s, config, &[weighted(NetworkSegment::lan(), 1, 1)], &[2]);
        let loud = run_point(
            &s,
            config,
            &[weighted(NetworkSegment::transcontinental(), 1, 1)],
            &[2],
        );
        assert!(loud.responsiveness_score > quiet.responsiveness_score);
        assert!(loud.smoothness_score > quiet.smoothness_score);
    }

    /// A score anchored to the sweep would move when a neighbour changed. Anchored to
    /// fixed references it must not, which is what makes two sweeps comparable.
    #[test]
    fn a_score_does_not_depend_on_the_other_configs_in_the_sweep() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::good_broadband(), 1, 1)];
        let target = NetcodeConfig::default();

        let alone = sweep(SweepRequest {
            scenario: &s,
            configs: &[target],
            segments: &segments,
            seeds: &[5],
        });

        let beside_others = sweep(SweepRequest {
            scenario: &s,
            configs: &[
                target,
                NetcodeConfig {
                    techniques: TechniqueSet::NONE,
                    ..target
                },
                NetcodeConfig {
                    interpolation_delay_ticks: 20,
                    ..target
                },
            ],
            segments: &segments,
            seeds: &[5],
        });

        assert_eq!(alone[0], beside_others[0]);
    }

    /// The scenario's length must not change the correction rate, or a longer run
    /// would score worse while running identical netcode.
    #[test]
    fn the_correction_rate_is_independent_of_run_length() {
        let short = build_scenario(&BuildScenario {
            duration_ticks: 200,
            ..BuildScenario {
                tick_rate: 64,
                duration_ticks: 200,
                accel: 10,
                max_speed: 100,
                friction_permille: 1000,
                bounds: 1000,
                move_from_tick: 0,
                stop_at_tick: 0,
            }
        });
        let long = build_scenario(&BuildScenario {
            tick_rate: 64,
            duration_ticks: 800,
            accel: 10,
            max_speed: 100,
            friction_permille: 1000,
            bounds: 1000,
            move_from_tick: 0,
            stop_at_tick: 0,
        });
        let segments = [weighted(NetworkSegment::average_broadband(), 1, 1)];
        let config = NetcodeConfig::default();

        let a = run_point(&short, config, &segments, &[3]);
        let b = run_point(&long, config, &segments, &[3]);

        let rate_a = corrections_per_minute(&a.aggregated, &short);
        let rate_b = corrections_per_minute(&b.aggregated, &long);
        // a correction lands on most ticks either way, so the per-minute rate should
        // sit close despite the run being four times longer
        let spread = crate::fx::abs(rate_a - rate_b) / rate_a;
        assert!(
            spread < ratio(15, 100),
            "rate moved from {rate_a} to {rate_b} on run length alone"
        );
    }

    /// The state hash must cover every run behind the point, so two sweeps that agree
    /// on the averages but not on the simulations underneath still differ.
    #[test]
    fn the_point_hash_covers_every_underlying_run() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::hostile(), 1, 1)];
        let config = NetcodeConfig::default();
        let two = run_point(&s, config, &segments, &[1, 2]);
        let swapped = run_point(&s, config, &segments, &[2, 1]);
        let different = run_point(&s, config, &segments, &[1, 3]);

        assert_ne!(two.state_hash, different.state_hash);
        // order changes the hash even though the aggregate is order independent,
        // which is correct: the hash identifies the exact run list
        assert_ne!(two.state_hash, swapped.state_hash);
    }

    #[test]
    fn sweep_returns_one_point_per_config() {
        let s = scenario();
        let configs = [
            NetcodeConfig::default(),
            NetcodeConfig {
                interpolation_delay_ticks: 5,
                ..NetcodeConfig::default()
            },
        ];
        let points = sweep(SweepRequest {
            scenario: &s,
            configs: &configs,
            segments: &[weighted(NetworkSegment::lan(), 1, 1)],
            seeds: &[1],
        });
        assert_eq!(points.len(), 2);
        assert_ne!(points[0].config_hash, points[1].config_hash);
    }

    /// Splitting the config list across workers must produce the same points, since
    /// that is exactly what the pool does.
    #[test]
    fn splitting_the_config_list_does_not_change_any_point() {
        let s = scenario();
        let configs: Vec<NetcodeConfig> = (0..6)
            .map(|i| NetcodeConfig {
                interpolation_delay_ticks: i,
                ..NetcodeConfig::default()
            })
            .collect();
        let segments = [weighted(NetworkSegment::mobile_4g(), 1, 1)];

        let whole = sweep(SweepRequest {
            scenario: &s,
            configs: &configs,
            segments: &segments,
            seeds: &[1, 2],
        });

        let mut split = Vec::new();
        for chunk in configs.chunks(2) {
            split.extend(sweep(SweepRequest {
                scenario: &s,
                configs: chunk,
                segments: &segments,
                seeds: &[1, 2],
            }));
        }

        assert_eq!(whole, split);
    }

    /// A client that interpolates rather than predicting. Interpolation delay only
    /// reaches the simulation on this shape of client: a predicting client runs its
    /// own copy of the world and draws that, so it never reads the state buffer the
    /// delay indexes into.
    ///
    /// Discovered by these oracle tests failing with a zero difference, which is what
    /// an inert constant looks like. Recorded here so a later reader does not conclude
    /// the sweep is failing to reach the core.
    fn interpolating_viewer() -> TechniqueSet {
        TechniqueSet {
            entity_interpolation: true,
            ..TechniqueSet::NONE
        }
    }

    fn clean_link() -> NetworkSegment {
        // a real one-way delay so packets still take time to arrive, but no jitter
        // and no loss, so nothing ever arrives late or goes missing
        NetworkSegment {
            rtt_mean_ms: 40,
            rtt_jitter_ms: 0,
            loss_pct: 0,
            reorder_pct: 0,
            duplicate_pct: 0,
            ..NetworkSegment::default()
        }
    }

    /// Smoothness at one interpolation depth, for a client that actually interpolates.
    fn smoothness_at_depth(segment: NetworkSegment, delay: u8) -> Fx {
        let s = scenario();
        let weighted = WeightedSegment {
            segment,
            weight: from_int(1),
        };
        run_point(
            &s,
            NetcodeConfig {
                techniques: interpolating_viewer(),
                interpolation_delay_ticks: delay,
                ..NetcodeConfig::default()
            },
            std::slice::from_ref(&weighted),
            &[1, 2, 3, 4],
        )
        .smoothness_score
    }

    /// The optimizer's known-answer case, and the one that says the front points the
    /// right way rather than merely being self-consistent.
    ///
    /// Interpolation delay buys tolerance to late and missing packets by rendering
    /// further in the past. On a link where nothing is late and nothing is lost there
    /// is nothing to tolerate, so the delay is pure cost and deeper must score worse.
    #[test]
    fn on_a_clean_link_more_interpolation_delay_is_pure_cost() {
        let shallow = smoothness_at_depth(clean_link(), 1);
        let deep = smoothness_at_depth(clean_link(), 12);
        assert!(
            deep > shallow,
            "deeper interpolation did not cost anything on a link with nothing to absorb: {deep} against {shallow}"
        );
    }

    /// The other direction of the same oracle. Under heavy burst loss the buffer has
    /// gaps to bridge, so depth must cost less than it does on a clean link.
    ///
    /// Asserted as a relative claim rather than as an absolute improvement: what the
    /// technique guarantees is that depth is worth more where packets go missing, not
    /// that it is free there.
    #[test]
    fn depth_costs_less_under_loss_than_on_a_clean_link() {
        let penalty = |segment: NetworkSegment| {
            smoothness_at_depth(segment, 12) - smoothness_at_depth(segment, 1)
        };
        let clean = penalty(clean_link());
        let lossy = penalty(NetworkSegment::hostile());

        assert!(
            lossy < clean,
            "depth cost as much under loss as on a clean link: {lossy} against {clean}"
        );
    }

    /// Turning every technique off must not be free. If it changes nothing the sweep
    /// is not reaching the simulation and every recommendation is noise.
    #[test]
    fn the_technique_set_changes_the_scores() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::transcontinental(), 1, 1)];
        let with = run_point(&s, NetcodeConfig::default(), &segments, &[1, 2]);
        let without = run_point(
            &s,
            NetcodeConfig {
                techniques: TechniqueSet::NONE,
                ..NetcodeConfig::default()
            },
            &segments,
            &[1, 2],
        );
        assert_ne!(with.smoothness_score, without.smoothness_score);
    }

    /// Interpolation delay is inert under prediction, which is correct rather than a
    /// defect: a predicting client draws its own simulation instead of the buffer.
    ///
    /// Pinned so the sweep's parameter ranges stay honest. A grid that varies this
    /// constant while prediction is on produces identical points under different
    /// labels, which would read as a flat region of the front rather than as a knob
    /// that does nothing.
    #[test]
    fn interpolation_delay_does_nothing_while_the_client_predicts() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::average_broadband(), 1, 1)];
        let at = |delay: u8| {
            run_point(
                &s,
                NetcodeConfig {
                    interpolation_delay_ticks: delay,
                    ..NetcodeConfig::default()
                },
                &segments,
                &[1, 2],
            )
        };
        assert_eq!(at(1).aggregated, at(12).aggregated);
    }

    /// Both smoothness terms must be able to move the score.
    ///
    /// The first version of this scoring included a correction-frequency term against
    /// a 600-per-minute anchor. A correction fires on nearly every tick on any
    /// imperfect link, about 2,900 per minute, so that term sat pinned near 1 and
    /// contributed 0.94 of a 1.05 total while divergence contributed 0.01. The front
    /// collapsed to two points out of 144.
    ///
    /// This holds each term to carrying a real share of the score, so a term that
    /// saturates cannot be reintroduced without failing here.
    #[test]
    fn no_single_smoothness_term_swamps_the_score() {
        let s = scenario();
        let segments = [weighted(NetworkSegment::hostile(), 1, 1)];
        let point = run_point(&s, NetcodeConfig::default(), &segments, &[1, 2, 3, 4]);
        let m = point.aggregated;

        let divergence = m.divergence_p99 / anchors::divergence_units() * weights::divergence_p99();
        let correction =
            m.correction_magnitude_max / anchors::correction_units() * weights::correction_max();
        let total = divergence + correction;

        assert!(total > Fx::ZERO, "the smoothness score was zero");
        // neither term may be so small next to the other that it cannot move the
        // result. a tenth of the total is the floor for a term that is meant to count
        let floor = total / from_int(10);
        assert!(
            divergence > floor,
            "divergence contributed {divergence} of {total}"
        );
        assert!(
            correction > floor,
            "correction contributed {correction} of {total}"
        );
    }

    /// An anchor far above what the simulation produces compresses every result into
    /// the bottom of the range, where the term cannot separate anything.
    ///
    /// A hostile link is the worst conditions the presets offer, so each metric should
    /// reach a real fraction of its anchor there. The original anchors put it at four
    /// percent, which is what made the smoothness score unable to rank anything.
    #[test]
    fn a_hostile_link_reaches_a_real_fraction_of_each_anchor() {
        let s = scenario();
        let hostile = [weighted(NetworkSegment::hostile(), 1, 1)];
        let m = run_point(&s, NetcodeConfig::default(), &hostile, &[1, 2, 3, 4]).aggregated;

        let share = |value: Fx, anchor: Fx| value / anchor;
        let divergence = share(m.divergence_p99, anchors::divergence_units());
        let correction = share(m.correction_magnitude_max, anchors::correction_units());

        // a fifth of the anchor at the worst preset. below that the term is flat
        // across everything a caller can actually configure
        let floor = ratio(1, 5);
        assert!(
            divergence > floor,
            "hostile p99 reached only {divergence} of its anchor"
        );
        assert!(
            correction > floor,
            "hostile worst correction reached only {correction} of its anchor"
        );
    }

    #[test]
    fn counts_round_rather_than_truncate() {
        assert_eq!(to_count(ratio(3, 2)), 2);
        assert_eq!(to_count(ratio(14, 10)), 1);
        assert_eq!(to_count(from_int(-5)), 0);
        assert_eq!(to_count(Fx::ZERO), 0);
    }

    /// The weighted round trip feeds the peeker's advantage term, so it has to follow
    /// the population rather than the segment list's first entry.
    #[test]
    fn the_scoring_rtt_follows_the_weights() {
        let quiet = weighted(NetworkSegment::lan(), 9, 10);
        let loud = weighted(NetworkSegment::transcontinental(), 1, 10);
        let mostly_quiet = weighted_rtt_ms(&[quiet, loud]);

        let quiet = weighted(NetworkSegment::lan(), 1, 10);
        let loud = weighted(NetworkSegment::transcontinental(), 9, 10);
        let mostly_loud = weighted_rtt_ms(&[quiet, loud]);

        assert!(mostly_loud > mostly_quiet);
        assert!(mostly_quiet < NetworkSegment::transcontinental().rtt_mean_ms);
    }
}
