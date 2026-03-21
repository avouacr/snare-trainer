# snare-trainer — CLAUDE.md

Personal web app for snare drumming practice. Plays a metronome + synthesized snare patterns and listens via mic to give real-time feedback on timing accuracy and dynamics.

## Ignored paths

Do not read or index these:
- `.venv/`
- `__pycache__/`
- `static/*.js` — unless explicitly asked (generated logic, not config)

## How to run

```bash
uv run python main.py
# Open http://localhost:8000
```

No packages to install — `main.py` uses the Python standard library only. `uv` is used for Python version management and consistent invocation.

## Architecture

**All real-time audio lives in the browser.** Python cannot access the microphone in a browser context. The backend is intentionally thin.

```
Browser
  ├── Metronome (Web Audio API, look-ahead scheduler)
  ├── Mic → GainNode → AudioWorklet (onset.js) → main thread
  ├── Onset matching: detected hit vs expected beat → timing error (ms)
  ├── Dynamic mapping: detected peak amplitude → loud_accent/accent/tap/low_tap
  └── Visual feedback panels (vanilla JS, no framework)

Python (main.py)
  ├── GET /              → static/index.html
  ├── GET /static/*      → static files
  ├── GET /patterns/*    → pattern JSON files
  └── GET /api/patterns  → list of available pattern names
```

## Key files

| File | Purpose |
|------|---------|
| `main.py` | Stdlib-only static server + `/api/patterns` endpoint |
| `static/onset.js` | AudioWorklet processor: RMS onset detection + true-peak reporting |
| `static/app.js` | Metronome scheduler, onset matching, calibration, feedback rendering |
| `static/index.html` | Single-page UI |
| `static/style.css` | Dark monospace theme |
| `patterns/*.json` | Practice patterns (add files here to make them available in the UI) |

## Pattern format

```json
{
  "name": "Human-readable name",
  "beats_per_bar": 4,
  "subdivisions": 2,
  "notes": [
    { "beat": 1, "sub": 1, "dynamic": "accent" },
    { "beat": 2, "sub": 1, "dynamic": "loud_accent" }
  ]
}
```

- `beat`: 1-indexed beat within the bar
- `sub`: 1-indexed subdivision within the beat (1 = on the beat, 2 = "and" for 8th notes)
- `dynamic`: `loud_accent` | `accent` | `tap` | `low_tap`
- Rests = absence from the `notes` array
- **No `bpm` field** — tempo is a UI control, not stored in the pattern

To add a pattern: drop a `.json` file in `patterns/` and reload the page.

## Onset detection (`onset.js`)

- RMS energy over ~5ms window vs. slowly-decaying background
- Onset fires when `instantRMS > background × thresholdRatio`
- **Peak reported as true peak** (max |sample| in window), not RMS — snare transients
  are ~0.5ms, so RMS over 5ms badly underestimates impact strength
- Refractory period: 80ms (prevents double-triggering)

## Calibration

One-time, stored in `localStorage`. User hits each dynamic level 3× to set amplitude
thresholds. Midpoints between adjacent levels become the classification boundaries.

**Must redo calibration after changing Input Gain.**

## UI controls

| Control | Purpose |
|---------|---------|
| Pattern | Select from `patterns/*.json` |
| BPM | Tempo (live, affects running metronome immediately on next bar) |
| Start / Stop | Toggle metronome + mic capture |
| Calibrate | 4-step dynamic threshold calibration |
| Sensitivity | Onset detection threshold ratio (1.5–6×). Higher = less sensitive |
| Input Gain | Pre-amplify mic signal before analysis (1–10×). Raise if velocity meter stays low |
| Latency offset | Compensates audio I/O roundtrip. Start at 200ms, adjust until on-time hits show green |

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
  is used for feedback colouring).
- Pattern files are served statically. No write endpoint exists — edit files directly.
