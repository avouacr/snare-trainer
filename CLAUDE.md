# snare-trainer — CLAUDE.md

Personal web app for snare drumming practice. Plays a metronome + synthesized snare patterns and listens via mic to give real-time feedback on timing accuracy and dynamics.

## Ignored paths

Do not read or index these:
- `.venv/`
- `__pycache__/`
- `static/*.js` — unless explicitly asked (generated logic, not config)

## How to run

```bash
python main.py
```

Serves on `http://localhost:8000`. No packages to install — `main.py` uses the Python standard library only.

## Architecture

**All real-time audio lives in the browser.** Python cannot access the microphone in a browser context. The backend is intentionally thin — a pure static file server with no application logic.

```
Browser
  ├── Metronome (Web Audio API, look-ahead scheduler)
  ├── Snare synthesis (noise burst + pitched oscillator, scheduled per beat)
  ├── Mic → GainNode (hardcoded 3×) → AudioWorklet (onset.js) → main thread
  ├── Onset matching: detected hit vs expected beat → timing error (ms)
  ├── Dynamic mapping: detected peak amplitude → loud_accent / tap / accent / low_tap
  └── Visual feedback: pattern strip (SVG notation) + performance canvas (2D scatter)

Python (main.py)
  ├── GET /          → static/index.html
  ├── GET /patterns/ → patterns/patterns.json
  └── GET /**        → static files (no API endpoints)
```

## Key files

| File | Purpose |
|------|---------|
| `main.py` | Stdlib-only static file server, validates patterns on startup |
| `static/onset.js` | AudioWorklet processor: RMS onset detection + true-peak reporting |
| `static/app.js` | Metronome scheduler, onset matching, calibration, feedback rendering |
| `static/index.html` | Single-page UI |
| `static/style.css` | Dark monospace theme |
| `patterns/patterns.json` | All practice patterns in a single file |

## Pattern format

All patterns live in `patterns/patterns.json` as a JSON array:

```json
[
  { "name": "Afro",   "pattern": "XooXooXo" },
  { "name": "Reggae", "pattern": "ooXX" }
]
```

- Each character = one 16th note
- `X` = loud_accent, `o` = low_tap, `-` = rest (no expected hit)
- **Pattern length must be a multiple of 4** — enforced by `main.py` at startup (raises `ValueError` otherwise)
- Always 16th notes; tempo is a UI control, not stored in the pattern
- **No `beats_per_bar` or `subdivisions`** — beat markers appear every 4 positions
- The pattern strip always displays 2 bars of 4/4 (32 16th notes), repeating the pattern cyclically

To add a pattern: append an entry to `patterns/patterns.json` and reload.

## Onset detection (`onset.js`)

- RMS energy over ~5ms window (220 samples at 44.1 kHz) vs. slowly-decaying background
- Onset fires when `instantRMS > background × thresholdRatio` (default 3.0×, min floor 0.005)
- **Peak reported as true peak** (max |sample| in window), not RMS — snare transients
  are ~0.5ms, so RMS over 5ms badly underestimates impact strength
- Refractory period: 80ms (prevents double-triggering)
- Worklet accepts `setThreshold` messages to adjust ratio at runtime (no current UI for this)

## Snare synthesis

Each scheduled beat plays a synthesized snare composed of:
- **Noise burst** (bandpass ~3500 Hz, Q=0.8) decaying over 180ms — "snare wires" component
- **Pitched oscillator** (triangle, 220→80 Hz sweep) decaying over 70ms — drum head "crack"
- Volume scales with dynamic: `loud_accent=1.0, accent=0.7, tap=0.42, low_tap=0.2`

## Calibration

Two-phase, triggered by the **Calibrate** button. Results stored in `localStorage`.

**Phase 1 — Delay calibration**: plays 8 beats at 80 BPM; user taps along. The median
offset between detected tap times and scheduled beat times is saved as `latencyOffsetMs`.
Falls back to `AudioContext.outputLatency + baseLatency` if never calibrated manually.

**Phase 2 — Stroke calibration**: user hits only **2 levels** (`loud_accent` then `low_tap`),
3 hits each. The two intermediate levels are derived mathematically:
```
cal.accent = cal.low_tap + range * (2/3)
cal.tap    = cal.low_tap + range * (1/3)
```
Defaults (for 3× input gain): `loud_accent=0.8, accent=0.5, tap=0.22, low_tap=0.07`.

## UI controls

| Control | Purpose |
|---------|---------|
| Pattern | Select from `patterns/patterns.json` (hot-swap while playing) |
| BPM | Tempo (40–300) — live, takes effect immediately even while playing |
| Start / Stop | Toggle metronome + mic capture |
| Calibrate | Two-phase calibration: delay then stroke strength |
| Latency offset | Read-only display of the calibrated latency value |

**No Sensitivity or Input Gain sliders exist in the current UI.** Input gain is hardcoded
at 3× in `startMic()`; onset threshold is hardcoded at 3.0× in `onset.js`.

## Feedback

**Pattern strip**: SVG musical notation showing 2 bars of 4/4. Percussion clef + 4/4
time signature. `X` = bright filled notehead with accent mark (`>`); `o` = dim notehead.
Beamed in groups of 4 (16th notes). Redraws on each loop cycle and on resize.

**Performance canvas**: 2D scatter plot (bullseye) of the last 16 matched hits.
- X axis: timing error (±200ms) — left = early, right = late
- Y axis: dynamic ordinal error (±3 levels) — top = too loud, bottom = too soft
- Colour: Green = timing ≤20ms AND dynamic exact; Yellow = timing ≤80ms AND dynamic ≤1 off; Red = otherwise
- Dots fade from transparent (oldest) to opaque (newest)

**Velocity meter**: always-on vertical bar (right of canvas) showing raw true-peak amplitude.
Use to verify the mic is picking up playing. Label shows current dynamic classification.

## Notes for future changes

- Do not move onset detection or metronome scheduling to Python — roundtrip WebSocket
  latency (~50–200ms) would make timing feedback unreliable. Keep all audio in JS.
- The metronome uses `AudioContext.currentTime` (sample-accurate). Never replace the
  look-ahead scheduler with `setTimeout` alone — it drifts under CPU load.
- If adding new dynamics, update `DYNAMICS` array order in `app.js` (ordinal distance
  is used for feedback colouring). Pattern format currently only uses `X` (loud_accent)
  and `o` (low_tap); the full 4-level system exists in calibration and feedback.
- All patterns are in `patterns/patterns.json`. No write endpoint exists — edit the file directly.
- Pattern length must be a multiple of 4 — `main.py` rejects invalid patterns at startup.
- Switching patterns or changing BPM while playing takes effect immediately: the scheduler
  reads `bpm` and `pattern` globals each tick, and `loadPattern` resets beat position and
  clears stale expected-beat history.
