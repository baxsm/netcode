//! Peeker's advantage, reproducing Riot's published model.
//!
//! This is the project's only external correctness claim. The numbers come from a
//! different implementation by a different team, so agreement means something that
//! comparing the code against itself cannot.
//!
//! Source: "Peeking into VALORANT's Netcode", Riot Games, 28 July 2020.
//! <https://technology.riotgames.com/news/peeking-valorants-netcode>

use crate::fx::{from_int, ratio, Fx};

/// Server-side buffering, in frames at the server tick rate.
///
/// From the article: 0.5 frames average wait to be queued, 0.5 frames of target
/// network buffer, and 1 full frame to apply and broadcast.
pub const SERVER_BUFFER_FRAMES: i32 = 2;

/// Client-side buffering, in frames at the client's render rate.
///
/// Same decomposition as the server except the network buffer target is a full frame
/// rather than half, plus roughly half a frame of GPU and swap chain delay.
pub const CLIENT_BUFFER_FRAMES: i32 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PeekConditions {
    pub rtt_ms: u32,
    pub tick_rate: u32,
    pub client_fps: u32,
}

/// Milliseconds of extra reaction time the peeking player enjoys.
///
/// Rearranged from the article's inequality, which solves for the holder:
/// `ReactionTime(Holder) = ReactionTime(Peeker) - RTT(Holder) - Buffering`.
/// What the peeker gains is therefore the holder's round trip plus both buffers.
///
/// A zero tick rate or frame rate contributes no buffering rather than dividing by
/// zero, which keeps a degenerate config from trapping mid-sweep.
pub fn peekers_advantage_ms(c: PeekConditions) -> Fx {
    from_int(c.rtt_ms as i32) + server_buffer_ms(c.tick_rate) + client_buffer_ms(c.client_fps)
}

pub fn server_buffer_ms(tick_rate: u32) -> Fx {
    if tick_rate == 0 {
        return Fx::ZERO;
    }
    ratio(SERVER_BUFFER_FRAMES * 1000, tick_rate as i32)
}

pub fn client_buffer_ms(client_fps: u32) -> Fx {
    if client_fps == 0 {
        return Fx::ZERO;
    }
    ratio(CLIENT_BUFFER_FRAMES * 1000, client_fps as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::{abs, to_f64_for_display};

    /// Milliseconds either side of the published figure that still counts as a match.
    ///
    /// The article rounds all three figures to the nearest millisecond and says
    /// outright that it hand-waves the buffering term. The worst residual across the
    /// three points is 0.6 ms, so 2 ms absorbs the rounding while still failing on a
    /// real regression: one frame is 7.8 ms at 128 tick and 6.9 ms at 144 FPS, so an
    /// off-by-one-frame error is three times this and cannot slip through.
    const TOLERANCE_MS: f64 = 2.0;

    fn assert_matches_published(label: &str, c: PeekConditions, published_ms: f64) {
        let got = to_f64_for_display(peekers_advantage_ms(c));
        let delta = (got - published_ms).abs();
        assert!(
            delta <= TOLERANCE_MS,
            "{label}: computed {got:.1} ms against published {published_ms:.0} ms, \
             off by {delta:.1} ms which exceeds the {TOLERANCE_MS} ms tolerance"
        );
    }

    /// The baseline the article opens with, before Riot Direct and 128 tick.
    #[test]
    fn reproduces_the_published_baseline() {
        assert_matches_published(
            "baseline",
            PeekConditions {
                rtt_ms: 100,
                tick_rate: 64,
                client_fps: 60,
            },
            181.0,
        );
    }

    /// The article's "~40ms (28%)" improvement. See `docs/phases/phase-2.md` for why
    /// this runs at 75 ms rather than the 35 ms the phase doc originally claimed.
    #[test]
    fn reproduces_the_published_improved_point() {
        assert_matches_published(
            "improved",
            PeekConditions {
                rtt_ms: 75,
                tick_rate: 128,
                client_fps: 60,
            },
            141.0,
        );
    }

    #[test]
    fn reproduces_the_published_high_frame_rate_point() {
        assert_matches_published(
            "high frame rate",
            PeekConditions {
                rtt_ms: 35,
                tick_rate: 128,
                client_fps: 144,
            },
            71.0,
        );
    }

    /// The 35 ms reading of the middle point, kept as a test so the correction cannot
    /// be quietly reverted. If someone restores the phase doc's original condition,
    /// this documents what it actually produces.
    #[test]
    fn the_original_phase_doc_reading_does_not_reproduce() {
        let got = to_f64_for_display(peekers_advantage_ms(PeekConditions {
            rtt_ms: 35,
            tick_rate: 128,
            client_fps: 60,
        }));
        assert!(
            (got - 141.0).abs() > 10.0,
            "35 ms at 60 FPS computed {got:.1} ms, which now matches the published 141 ms. \
             If the model changed to make this true, the correction in phase-2.md needs revisiting."
        );
    }

    /// Halving the frame time must remove exactly half the client buffering. This is
    /// arithmetic rather than a published figure, so it holds regardless of tuning.
    #[test]
    fn doubling_the_frame_rate_halves_the_client_buffer() {
        assert_eq!(client_buffer_ms(120), client_buffer_ms(60) / from_int(2));
        assert_eq!(server_buffer_ms(128), server_buffer_ms(64) / from_int(2));
    }

    /// Every published lever must move the number the way the article claims.
    #[test]
    fn each_lever_moves_the_advantage_downward() {
        let base = PeekConditions {
            rtt_ms: 100,
            tick_rate: 64,
            client_fps: 60,
        };
        let lower_rtt = PeekConditions { rtt_ms: 50, ..base };
        let higher_tick = PeekConditions {
            tick_rate: 128,
            ..base
        };
        let higher_fps = PeekConditions {
            client_fps: 144,
            ..base
        };
        for better in [lower_rtt, higher_tick, higher_fps] {
            assert!(peekers_advantage_ms(better) < peekers_advantage_ms(base));
        }
    }

    #[test]
    fn a_zero_rate_contributes_nothing_rather_than_dividing_by_zero() {
        assert_eq!(server_buffer_ms(0), Fx::ZERO);
        assert_eq!(client_buffer_ms(0), Fx::ZERO);
        let c = PeekConditions {
            rtt_ms: 50,
            tick_rate: 0,
            client_fps: 0,
        };
        assert_eq!(peekers_advantage_ms(c), from_int(50));
    }

    /// The buffering terms are what the article decomposes, so they are pinned
    /// individually. A change to either constant fails here rather than being
    /// absorbed into the 2 ms tolerance on the totals.
    #[test]
    fn buffering_terms_match_the_published_decomposition() {
        // 2 frames at 128 tick is 15.625 ms
        assert!(abs(server_buffer_ms(128) - ratio(15625, 1000)) < ratio(1, 1000));
        // 3 frames at 60 fps is 50 ms exactly
        assert_eq!(client_buffer_ms(60), from_int(50));
        // 3 frames at 144 fps is 20.833 ms
        assert!(abs(client_buffer_ms(144) - ratio(20833, 1000)) < ratio(1, 100));
    }
}
