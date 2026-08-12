//! The thing being tuned: which techniques are on, and the constants they run with.
//!
//! Every field is a knob the Phase 4 sweep varies, so this struct is the tool's
//! output as much as its input. It crosses into the simulation, so it is fixed point
//! and integers only.

use crate::fx::{ratio, Fx};
use crate::hash::Hasher;

/// Which latency compensation techniques are enabled.
///
/// Independently toggleable because the product's value is in comparing
/// combinations, not in a single recommended stack.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TechniqueSet {
    pub client_prediction: bool,
    pub server_reconciliation: bool,
    pub entity_interpolation: bool,
    pub extrapolation: bool,
    pub server_rewind: bool,
    pub rollback: bool,
}

/// Number of distinct technique combinations. The zero-latency equivalence test is
/// exhaustive over this, which is only tractable because it is small.
pub const TECHNIQUE_COMBINATIONS: u32 = 64;

impl TechniqueSet {
    pub const NONE: Self = Self {
        client_prediction: false,
        server_reconciliation: false,
        entity_interpolation: false,
        extrapolation: false,
        server_rewind: false,
        rollback: false,
    };

    pub const ALL: Self = Self {
        client_prediction: true,
        server_reconciliation: true,
        entity_interpolation: true,
        extrapolation: true,
        server_rewind: true,
        rollback: true,
    };

    /// Unpacks the low six bits, one per technique. Lets the exhaustive test walk
    /// `0..64` rather than hand-listing every combination and missing one.
    pub fn from_bits(bits: u32) -> Self {
        Self {
            client_prediction: bits & 1 != 0,
            server_reconciliation: bits & 2 != 0,
            entity_interpolation: bits & 4 != 0,
            extrapolation: bits & 8 != 0,
            server_rewind: bits & 16 != 0,
            rollback: bits & 32 != 0,
        }
    }

    pub fn to_bits(self) -> u32 {
        u32::from(self.client_prediction)
            | u32::from(self.server_reconciliation) << 1
            | u32::from(self.entity_interpolation) << 2
            | u32::from(self.extrapolation) << 3
            | u32::from(self.server_rewind) << 4
            | u32::from(self.rollback) << 5
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct NetcodeConfig {
    pub techniques: TechniqueSet,
    pub interpolation_delay_ticks: u8,
    pub input_buffer_ticks: u8,
    pub rollback_window_ticks: u8,
    /// Share of the remaining error left in place each tick. 0 snaps immediately,
    /// values approaching 1 never converge.
    pub correction_blend_rate: Fx,
    /// World units. An error beyond this teleports instead of blending, because
    /// blending a large error is a long visible slide.
    pub snap_threshold: Fx,
    pub server_rewind_limit_ms: u32,
    pub extrapolation_limit_ticks: u8,
}

impl Default for NetcodeConfig {
    /// Values a shipped game would plausibly start from, not zeros. The blend rate
    /// and snap threshold come from the Phase 1 divergence baseline: p99 sat near 45
    /// world units on average broadband, so a 50 unit snap threshold catches genuine
    /// desync without firing on ordinary correction.
    fn default() -> Self {
        Self {
            techniques: TechniqueSet::ALL,
            interpolation_delay_ticks: 2,
            input_buffer_ticks: 2,
            rollback_window_ticks: 8,
            correction_blend_rate: ratio(8, 10),
            snap_threshold: crate::fx::from_int(50),
            extrapolation_limit_ticks: 6,
            server_rewind_limit_ms: 200,
        }
    }
}

/// Why a configuration was rejected. Carried as an enum rather than a string so the
/// boundary can report it numerically and the UI can phrase it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConfigError {
    /// Reconciliation replays unacknowledged inputs, so it has nothing to replay
    /// against without prediction producing them.
    ReconciliationWithoutPrediction,
    /// Rollback resimulates predicted history, which only exists under prediction.
    RollbackWithoutPrediction,
    /// The interpolation buffer cannot be deeper than the history that feeds it.
    InterpolationDelayExceedsBuffer,
    /// A blend rate of 1 leaves the whole error in place every tick, so the client
    /// never converges on the server.
    BlendRateNeverConverges,
    /// A rewind of zero would resolve every shot at the present tick, which is the
    /// no-compensation case wearing the technique's name.
    RewindLimitIsZero,
}

impl ConfigError {
    pub fn code(self) -> u32 {
        match self {
            ConfigError::ReconciliationWithoutPrediction => 1,
            ConfigError::RollbackWithoutPrediction => 2,
            ConfigError::InterpolationDelayExceedsBuffer => 3,
            ConfigError::BlendRateNeverConverges => 4,
            ConfigError::RewindLimitIsZero => 5,
        }
    }
}

/// Deepest history the core retains, in ticks. Interpolation delay is checked
/// against this rather than against a number the caller supplies, so a config that
/// asks to read further back than the buffer exists is rejected instead of silently
/// reading the oldest available entry.
pub const HISTORY_TICKS: usize = 64;

impl NetcodeConfig {
    /// Rejects combinations that cannot mean what they say.
    ///
    /// These are structural contradictions, not tuning preferences. A config that
    /// asks for reconciliation without prediction has no unacknowledged inputs to
    /// replay, so silently running it would report the baseline under a technique's
    /// name and make the comparison table lie.
    pub fn validate(&self) -> Result<(), ConfigError> {
        let t = self.techniques;
        if t.server_reconciliation && !t.client_prediction {
            return Err(ConfigError::ReconciliationWithoutPrediction);
        }
        if t.rollback && !t.client_prediction {
            return Err(ConfigError::RollbackWithoutPrediction);
        }
        if t.entity_interpolation && self.interpolation_delay_ticks as usize >= HISTORY_TICKS {
            return Err(ConfigError::InterpolationDelayExceedsBuffer);
        }
        if t.server_reconciliation && self.correction_blend_rate >= crate::fx::from_int(1) {
            return Err(ConfigError::BlendRateNeverConverges);
        }
        if t.server_rewind && self.server_rewind_limit_ms == 0 {
            return Err(ConfigError::RewindLimitIsZero);
        }
        Ok(())
    }

    /// Identity of the configuration, so a result can be traced back to what produced
    /// it. Separate from `state_hash`, which is the determinism mechanism.
    pub fn config_hash(&self) -> u64 {
        let mut h = Hasher::new();
        self.hash_into(&mut h);
        h.finish()
    }

    pub fn hash_into(&self, h: &mut Hasher) {
        h.write_u32(self.techniques.to_bits());
        h.write_u8(self.interpolation_delay_ticks);
        h.write_u8(self.input_buffer_ticks);
        h.write_u8(self.rollback_window_ticks);
        h.write_i64(self.correction_blend_rate.to_bits());
        h.write_i64(self.snap_threshold.to_bits());
        h.write_u32(self.server_rewind_limit_ms);
        h.write_u8(self.extrapolation_limit_ticks);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::from_int;

    #[test]
    fn bits_round_trip_for_every_combination() {
        for bits in 0..TECHNIQUE_COMBINATIONS {
            assert_eq!(TechniqueSet::from_bits(bits).to_bits(), bits);
        }
    }

    #[test]
    fn none_and_all_sit_at_the_ends_of_the_range() {
        assert_eq!(TechniqueSet::NONE.to_bits(), 0);
        assert_eq!(TechniqueSet::ALL.to_bits(), TECHNIQUE_COMBINATIONS - 1);
    }

    /// Each technique must occupy its own bit. A duplicated shift would make two
    /// techniques indistinguishable and quietly halve the combination space.
    #[test]
    fn every_technique_has_a_distinct_bit() {
        let mut seen = Vec::new();
        for bits in 0..TECHNIQUE_COMBINATIONS {
            let set = TechniqueSet::from_bits(bits);
            assert!(!seen.contains(&set), "combination {bits} was not unique");
            seen.push(set);
        }
        assert_eq!(seen.len(), TECHNIQUE_COMBINATIONS as usize);
    }

    #[test]
    fn the_default_config_is_valid() {
        assert_eq!(NetcodeConfig::default().validate(), Ok(()));
    }

    #[test]
    fn reconciliation_requires_prediction() {
        let config = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: false,
                server_reconciliation: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };
        assert_eq!(
            config.validate(),
            Err(ConfigError::ReconciliationWithoutPrediction)
        );
    }

    #[test]
    fn rollback_requires_prediction() {
        let config = NetcodeConfig {
            techniques: TechniqueSet {
                client_prediction: false,
                rollback: true,
                ..TechniqueSet::NONE
            },
            ..NetcodeConfig::default()
        };
        assert_eq!(
            config.validate(),
            Err(ConfigError::RollbackWithoutPrediction)
        );
    }

    #[test]
    fn interpolation_delay_cannot_exceed_the_history_buffer() {
        let config = NetcodeConfig {
            techniques: TechniqueSet {
                entity_interpolation: true,
                ..TechniqueSet::NONE
            },
            interpolation_delay_ticks: HISTORY_TICKS as u8,
            ..NetcodeConfig::default()
        };
        assert_eq!(
            config.validate(),
            Err(ConfigError::InterpolationDelayExceedsBuffer)
        );
    }

    #[test]
    fn a_blend_rate_of_one_is_rejected() {
        let config = NetcodeConfig {
            correction_blend_rate: from_int(1),
            ..NetcodeConfig::default()
        };
        assert_eq!(config.validate(), Err(ConfigError::BlendRateNeverConverges));
    }

    #[test]
    fn a_zero_rewind_limit_is_rejected() {
        let config = NetcodeConfig {
            server_rewind_limit_ms: 0,
            ..NetcodeConfig::default()
        };
        assert_eq!(config.validate(), Err(ConfigError::RewindLimitIsZero));
    }

    /// A validation rule that only fires on techniques that are off would let an
    /// invalid constant through whenever its technique is disabled.
    #[test]
    fn constants_are_only_checked_when_their_technique_is_on() {
        let config = NetcodeConfig {
            techniques: TechniqueSet::NONE,
            interpolation_delay_ticks: 200,
            server_rewind_limit_ms: 0,
            correction_blend_rate: from_int(1),
            ..NetcodeConfig::default()
        };
        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn config_hash_separates_techniques_from_constants() {
        let base = NetcodeConfig::default();
        let other_technique = NetcodeConfig {
            techniques: TechniqueSet::NONE,
            ..base
        };
        let other_constant = NetcodeConfig {
            interpolation_delay_ticks: base.interpolation_delay_ticks + 1,
            ..base
        };
        assert_ne!(base.config_hash(), other_technique.config_hash());
        assert_ne!(base.config_hash(), other_constant.config_hash());
    }

    /// Every field must reach the hash. A field left out would make two genuinely
    /// different configurations share an identity in the sweep's results.
    #[test]
    fn every_field_changes_the_config_hash() {
        let base = NetcodeConfig::default();
        let variants = [
            NetcodeConfig {
                interpolation_delay_ticks: 9,
                ..base
            },
            NetcodeConfig {
                input_buffer_ticks: 9,
                ..base
            },
            NetcodeConfig {
                rollback_window_ticks: 9,
                ..base
            },
            NetcodeConfig {
                correction_blend_rate: ratio(1, 3),
                ..base
            },
            NetcodeConfig {
                snap_threshold: from_int(77),
                ..base
            },
            NetcodeConfig {
                server_rewind_limit_ms: 333,
                ..base
            },
            NetcodeConfig {
                extrapolation_limit_ticks: 9,
                ..base
            },
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_ne!(
                base.config_hash(),
                v.config_hash(),
                "field {i} did not hash"
            );
        }
    }
}
