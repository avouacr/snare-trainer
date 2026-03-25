# batuc-trainer — CLAUDE.md

Personal web app for batuc drumming practice. Plays a metronome + synthesized snare patterns and listens via mic to give real-time feedback on timing accuracy.

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

Or with Docker:

```bash
docker build -t batuc-trainer .
docker run -p 8000:8000 batuc-trainer
```

## Architecture

**All real-time audio lives in the browser.** Python cannot access the microphone in a browser context. The backend is intentionally thin — a pure static file server with no application logic.

```
Browser
  ├── Metronome (Web Audio API, look-ahead scheduler)
  ├── Snare synthesis (noise burst + pitched oscillator, scheduled per beat)
  ├── Mic → GainNode (hardcoded 3×) → AudioWorklet (onset.js) → main thread
  ├── Onset matching: detected hit vs expected beat → timing error (ms)
  ├── Dynamic mapping: detected peak amplitude → accent / tap (threshold 0.4)
  ├── Auto latency correction: adjusts latencyOffsetMs every 16 matched hits
  └── Visual feedback: pattern strip (SVG notation) + timing bars

Python (main.py)
  ├── GET /          → static/index.html
  ├── GET /patterns/ → patterns/patterns.json
  └── GET /**        → static files (no API endpoints)
```

## Key files

| File | Purpose |
|------|---------|
| `main.py` | Stdlib-only static file server, validates patterns on startup |
| `Dockerfile` | Container build (python:3.13-slim, port 8000) |
| `static/onset.js` | AudioWorklet processor: RMS onset detection + true-peak reporting |
| `static/app.js` | Metronome scheduler, onset matching, auto-correction, feedback rendering |
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
- `X` = accent, `o` = tap, `-` = rest (no expected hit)
- **Pattern length must be a multiple of 4** — enforced by `main.py` at startup (raises `ValueError` otherwise)
- Always 16th notes; tempo is a UI control, not stored in the pattern
- **No `beats_per_bar` or `subdivisions`** — beat markers appear every 4 positions
- The pattern strip always displays 2 bars of 4/4 (32 16th notes), repeating the pattern cyclically

To add a pattern: append an entry to `patterns/patterns.json` and reload.

## Onset detection (`onset.js`)

- RMS energy over ~5ms window (220 samples at 44.1 kHz) vs. slowly-decaying background
- Onset fires when `instantRMS > background × thresholdRatio` (default 3.0×, min floor 0.005)
- **Peak reported as true peak** (max |sample| in window), not RMS — snare transients are ~0.5ms, so RMS over 5ms badly underestimates impact strength
- Refractory period: 80ms (prevents double-triggering)
- Worklet accepts `setThreshold` messages to adjust ratio at runtime (no current UI for this)

## Snare synthesis

Each scheduled beat plays a synthesized snare composed of:
- **Noise burst** (bandpass ~3500 Hz, Q=0.8) decaying over 180ms — "snare wires" component
- **Pitched oscillator** (triangle, 220→80 Hz sweep) decaying over 70ms — drum head "crack"
- Volume scales with dynamic: `accent=1.0, tap=0.2`

## Dynamics

Two levels only:
- `accent` — full volume (1.0), mapped from `X` in pattern
- `tap` — quiet (0.2), mapped from `o` in pattern

Peak amplitude threshold for detection: `peak >= 0.4 → accent`, else `tap`. Hardcoded, no calibration UI.

## Latency handling

`latencyOffsetMs` is added to each scheduled beat time to define the expected hit window. It is:
- Initialised from `localStorage` (`batuc-trainer-latency`), defaulting to `AudioContext.outputLatency + baseLatency` on first run, or 200ms if neither is available
- **Auto-corrected every 16 matched hits**: the median timing error over the last 16 hits is computed; if |median| ≥ 5ms, it is added to `latencyOffsetMs` and saved to `localStorage`. This silently converges to the correct value without any manual calibration step.

## UI controls

| Control | Purpose |
|---------|---------|
| Pattern | Select from `patterns/patterns.json` (hot-swap while playing) |
| BPM | Tempo (40–300) — live, takes effect immediately even while playing |
| Start / Stop | Toggle metronome + mic capture |

Input gain is hardcoded at 3× in `startMic()`; onset threshold is hardcoded at 3.0× in `onset.js`.

## Feedback

**Pattern strip**: SVG musical notation showing 2 bars of 4/4. Percussion clef + 4/4 time signature. `X` = bright filled notehead with accent mark (`>`); `o` = dim notehead. Beamed in groups of 4 (16th notes). Redraws on each loop cycle and on resize.

**Timing panel**: horizontal bar chart of the last 16 matched hits.
- Each row = one hit; dot positioned left (early) to right (late) on a ±200ms scale
- Colour: Green = |error| ≤ 20ms; Yellow = |error| ≤ 80ms; Red = otherwise
- Rows fade from transparent (oldest) to opaque (newest)

## Notes for future changes

- Do not move onset detection or metronome scheduling to Python — roundtrip WebSocket latency (~50–200ms) would make timing feedback unreliable. Keep all audio in JS.
- The metronome uses `AudioContext.currentTime` (sample-accurate). Never replace the look-ahead scheduler with `setTimeout` alone — it drifts under CPU load.
- If adding dynamics beyond the current two levels, update `DYNAMICS` in `app.js` and `peakToDynamic` threshold logic. Pattern format currently uses only `X` (accent) and `o` (tap).
- All patterns are in `patterns/patterns.json`. No write endpoint exists — edit the file directly.
- Pattern length must be a multiple of 4 — `main.py` rejects invalid patterns at startup.
- Switching patterns or changing BPM while playing takes effect immediately: the scheduler reads `bpm` and `pattern` globals each tick, and `loadPattern` resets beat position and clears stale expected-beat history.
