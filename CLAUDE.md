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

No packages to install — `main.py` uses the Python standard library only.

## Architecture

**All real-time audio lives in the browser.** Python cannot access the microphone in a browser context. The backend is intentionally thin — a pure static file server with no application logic.

```
Browser
  ├── Metronome (Web Audio API, look-ahead scheduler)
  ├── Mic → GainNode → AudioWorklet (onset.js) → main thread
  ├── Onset matching: detected hit vs expected beat → timing error (ms)
  ├── Dynamic mapping: detected peak amplitude → loud_accent / low_tap
  └── Visual feedback panels (vanilla JS, no framework)

Python (main.py)
  ├── GET /          → static/index.html
  └── GET /**        → static files (no API endpoints)
```

## Key files

| File | Purpose |
|------|---------|
| `main.py` | Stdlib-only static file server, no application logic |
| `static/onset.js` | AudioWorklet processor: RMS onset detection + true-peak reporting |
| `static/app.js` | Metronome scheduler, onset matching, calibration, feedback rendering |
| `static/index.html` | Single-page UI |
| `static/style.css` | Dark monospace theme |
| `patterns/patterns.json` | All practice patterns in a single file |

## Pattern format

All patterns live in `patterns/patterns.json` as a JSON array:

```json
[
  { "name": "Afro",  "pattern": "XooXooXo" },
  { "name": "Reggae","pattern": "ooXX" }
]
```

- Each character = one 16th note
- `X` = loud_accent, `o` = low_tap, `-` = rest (no expected hit)
- Pattern length determines the loop cycle — any length works (useful for odd-length patterns)
- Always 16th notes; tempo is a UI control, not stored in the pattern
- **No `beats_per_bar` or `subdivisions`** — beat markers appear every 4 positions in the UI

To add a pattern: append an entry to `patterns/patterns.json` and reload.

## Onset detection (`onset.js`)

- RMS energy over ~5ms window vs. slowly-decaying background
- Onset fires when `instantRMS > background × thresholdRatio`
- **Peak reported as true peak** (max |sample| in window), not RMS — snare transients
  are ~0.5ms, so RMS over 5ms badly underestimates impact strength
- Refractory period: 80ms (prevents double-triggering)

## Calibration

Two-phase, triggered by the **Calibrate** button. Results stored in `localStorage`.

**Phase 1 — Delay calibration**: plays 8 beats at 80 BPM; user taps along. The median
offset between detected tap times and scheduled beat times is saved as `latencyOffsetMs`.
Replaces the old manual latency slider.

**Phase 2 — Stroke calibration**: user hits each dynamic level (ff → f → p → pp) 3×.
Midpoints between adjacent median peaks become the classification boundaries.

**Must redo calibration after changing Input Gain.**

## UI controls

| Control | Purpose |
|---------|---------|
| Pattern | Select from `patterns/patterns.json` (hot-swap while playing) |
| BPM | Tempo — live, takes effect immediately even while playing |
| Start / Stop | Toggle metronome + mic capture |
| Calibrate | Two-phase calibration: delay then stroke strength |
| Sensitivity | Onset detection threshold ratio (1.5–6×). Higher = less sensitive |
| Input Gain | Pre-amplify mic signal before analysis (1–10×). Raise if velocity meter stays low |
| Latency offset | Read-only display of the calibrated latency value |

## Feedback panels

**Timing**: horizontal dot per hit. Centre = perfect. Left = early, right = late.
- Green ≤ 20ms, Yellow ≤ 80ms, Red > 80ms

**Dynamics**: grid of last 16 hits. Each cell shows expected (grey) vs detected (colour).
- Green = exact match, Orange = 1 level off, Red = 2+ levels off

**Velocity meter**: always-on vertical bar showing raw true-peak amplitude from mic.
Use this to verify the mic is picking up your playing and that gain is calibrated.

## Notes for future changes

- Do not move onset detection or metronome scheduling to Python — roundtrip WebSocket
  latency (~50–200ms) would make timing feedback unreliable. Keep all audio in JS.
- The metronome uses `AudioContext.currentTime` (sample-accurate). Never replace the
  look-ahead scheduler with `setTimeout` alone — it drifts under CPU load.
- If adding new dynamics, update `DYNAMICS` array order in `app.js` (ordinal distance
  is used for feedback colouring). Pattern format currently only uses `loud_accent` and
  `low_tap`; the full 4-level system exists in calibration and feedback classification.
- All patterns are in `patterns/patterns.json`. No write endpoint exists — edit the file directly.
- Switching patterns or changing BPM while playing takes effect immediately: the scheduler
  reads `bpm` and `pattern` globals each tick, and `loadPattern` resets beat position and
  clears stale expected-beat history.
