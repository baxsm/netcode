# netcode

Finds the netcode tuning parameters a multiplayer game should ship, by searching the configuration space against a deterministic simulation and scoring each result on responsiveness and smoothness.

## Setup

Requires Node 24+ and the Rust toolchain with the `wasm32-unknown-unknown` target.

```
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build:wasm
```

## Regression checks in CI

A tuned configuration can be pinned as a baseline and rechecked on every commit, so a
gameplay change that costs netcode quality fails the build instead of shipping quietly.

```bash
npm run baseline -- baselines/default.json
```

It runs the pinned scenario, network segment, seeds and config, then asserts each metric
against its threshold. A threshold that is missed exits non-zero and prints what it measured:

```
FAIL  divergenceP99           measured 1.5818 <= 0.5000  off by +1.0818
pass  correctionMagnitudeMax  measured 3.3223 <= 3.83
```

A baseline pins its own seeds, so the result is exact rather than an estimate. Set thresholds
above the values the build measures, not equal to them.

```json
{
  "schemaVersion": 1,
  "name": "Straight-line drift on average broadband",
  "scenarioId": "drift",
  "segmentIndex": 3,
  "seeds": [1, 2, 3, 4, 5, 6, 7, 8],
  "config": { "correctionBlendPermille": 800, "inputBufferTicks": 0 },
  "thresholds": [
    { "metric": "divergenceP99", "comparison": "atMost", "value": 1.82 },
    { "metric": "inputLatencyMeanMs", "comparison": "atMost", "value": 24.3 }
  ]
}
```

## Tests

```
npm test
```

Runs the typechecker, the Rust core suite, the TypeScript unit suite, the Node determinism
suite, a production build, and the cross-engine browser suite in Chromium and Firefox.

The simulation core uses fixed-point arithmetic so a given seed produces bit-identical results
in every engine. `npm run test:e2e` is what enforces that: the same seed must produce the same
state hash in Chromium, Firefox and Node, checked against hashes recorded from the native Rust
build.
