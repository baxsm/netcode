//! Property tests for the determinism guarantees.
//!
//! These run across many seeds rather than the handful a unit test pins, which is
//! what catches a divergence that only shows up in a particular arithmetic path.

use netcode_core::sim::{run_to_hash, World, MAX_ENTITIES};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn same_seed_reproduces_hash(seed in any::<u64>(), ticks in 0u32..500, count in 1usize..24) {
        prop_assert_eq!(run_to_hash(seed, ticks, count), run_to_hash(seed, ticks, count));
    }

    /// Running N ticks then M more must equal running N+M in one go. A tick loop
    /// that carried hidden state between batches would fail here and nowhere else.
    #[test]
    fn split_run_equals_single_run(seed in any::<u64>(), a in 0u32..300, b in 0u32..300) {
        let mut single = World::new(seed, 12);
        single.run(a + b);

        let mut split = World::new(seed, 12);
        split.run(a);
        split.run(b);

        prop_assert_eq!(single.state_hash(), split.state_hash());
    }

    #[test]
    fn entities_never_leave_bounds(seed in any::<u64>(), ticks in 0u32..800) {
        let mut w = World::new(seed, 16);
        w.run(ticks);
        let limit = fixed::types::I32F32::from_num(100);
        for e in &w.entities {
            prop_assert!(e.x >= -limit && e.x <= limit);
            prop_assert!(e.y >= -limit && e.y <= limit);
        }
    }

    /// Guards against a hash that is stable but blind. If this ever passes for all
    /// pairs, the hash has stopped reading state and every determinism test above
    /// is worthless.
    #[test]
    fn distinct_seeds_mostly_differ(a in any::<u64>(), b in any::<u64>()) {
        prop_assume!(a != b);
        prop_assert_ne!(run_to_hash(a, 200, 8), run_to_hash(b, 200, 8));
    }

    #[test]
    fn full_arena_never_overflows(seed in any::<u64>()) {
        let mut w = World::new(seed, MAX_ENTITIES);
        w.run(1000);
        prop_assert_eq!(w.tick, 1000);
    }
}
