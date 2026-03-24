/**
 * Snare Trainer — main application logic
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DYNAMICS = ['low_tap', 'tap', 'accent', 'loud_accent'];
const DYNAMIC_LABELS = { low_tap: 'pp', tap: 'p', accent: 'f', loud_accent: 'ff' };

const TIMING_GREEN_MS  = 20;
const TIMING_YELLOW_MS = 80;

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.1;

const HISTORY_SIZE = 16;
const MATCH_WINDOW_SEC = 0.5;

const CAL_STEPS    = ['loud_accent', 'low_tap'];
const CAL_HITS_NEEDED = 3;

const CAL_DELAY_BPM   = 80;
const CAL_DELAY_BEATS = 8;
// True-peak defaults (with 3× input gain). Calibrate for your setup.
const DEFAULT_CAL  = { loud_accent: 0.8, accent: 0.5, tap: 0.22, low_tap: 0.07 };

const LS_CAL     = 'snare-trainer-cal';
const LS_LATENCY = 'snare-trainer-latency';

// ─── State ────────────────────────────────────────────────────────────────────

let audioCtx  = null;
let onsetNode = null;
let micSource = null;

let pattern     = null;
let bpm         = 90;   // UI-only, not stored in pattern

let isRunning     = false;
let nextBeatTime  = 0;
let nextBeatIndex = 0;

let expectedBeats = [];
let hitHistory    = [];

let cal      = loadCalibration();
let calState = null;

const _storedLatency = parseInt(localStorage.getItem(LS_LATENCY), 10);
let latencyOffsetMs = (!isNaN(_storedLatency) && _storedLatency > 0) ? _storedLatency : 200;

let schedulerTimer = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadCalibration() {
  try {
    const s = localStorage.getItem(LS_CAL);
    if (s) return JSON.parse(s);
  } catch (_) {}
  return { ...DEFAULT_CAL };
}
function saveCalibration() {
  localStorage.setItem(LS_CAL, JSON.stringify(cal));
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function peakToDynamic(peak) {
  const { low_tap: lo, tap: ta, accent: ac, loud_accent: la } = cal;
  if (peak >= (ac + la) / 2) return 'loud_accent';
  if (peak >= (ta + ac) / 2) return 'accent';
  if (peak >= (lo + ta) / 2) return 'tap';
  return 'low_tap';
}

function dynamicOrdinal(d) { return DYNAMICS.indexOf(d); }

function buildBeatList(pat) {
  const beats = [];
  for (let i = 0; i < pat.pattern.length; i++) {
    const ch = pat.pattern[i];
    if (ch === 'X') beats.push({ pos: i, dynamic: 'loud_accent' });
    else if (ch === 'o') beats.push({ pos: i, dynamic: 'low_tap' });
    // '-' = rest, omitted
  }
  return beats;
}

// ─── Audio init ───────────────────────────────────────────────────────────────

async function initAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('/static/onset.js');

  if (!localStorage.getItem(LS_LATENCY)) {
    const auto = Math.round(
      ((audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0)) * 1000
    );
    if (auto > 0) {
      latencyOffsetMs = auto;
      document.getElementById('latency-display').textContent = `${auto}ms`;
    }
  }
}

let inputGainNode = null;

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  micSource     = audioCtx.createMediaStreamSource(stream);
  inputGainNode = audioCtx.createGain();
  inputGainNode.gain.value = 3;
  onsetNode = new AudioWorkletNode(audioCtx, 'onset-processor');
  onsetNode.port.onmessage = (e) => {
    if (e.data.type === 'onset') {
      updateVelocityMeter(e.data.peak);
      processOnset(e.data);
    }
  };
  micSource.connect(inputGainNode);
  inputGainNode.connect(onsetNode);
}


// ─── Sound synthesis ──────────────────────────────────────────────────────────

// Synthesize a snare hit: noise burst (snare wires) + pitched transient (drum head).
// Volume scales with dynamic level.
function scheduleSnareHit(time, dynamic) {
  const vol = { loud_accent: 1.0, accent: 0.7, tap: 0.42, low_tap: 0.2 }[dynamic] ?? 0.5;

  const master = audioCtx.createGain();
  master.gain.value = vol;
  master.connect(audioCtx.destination);

  // Noise burst — "snare wires" component
  const bufLen = Math.ceil(audioCtx.sampleRate * 0.25);
  const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = buf;

  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 3500;
  bandpass.Q.value = 0.8;

  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(1, time);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);

  noise.connect(bandpass);
  bandpass.connect(noiseGain);
  noiseGain.connect(master);
  noise.start(time);
  noise.stop(time + 0.2);

  // Pitched transient — drum head "crack" component
  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, time);
  osc.frequency.exponentialRampToValueAtTime(80, time + 0.06);

  const oscGain = audioCtx.createGain();
  oscGain.gain.setValueAtTime(0.6, time);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);

  osc.connect(oscGain);
  oscGain.connect(master);
  osc.start(time);
  osc.stop(time + 0.08);

  return [noise, osc];
}


// ─── Metronome ────────────────────────────────────────────────────────────────

function startMetronome() {
  if (!pattern) return;
  isRunning     = true;
  nextBeatIndex = 0;
  nextBeatTime  = audioCtx.currentTime + 0.1;
  expectedBeats = [];
  hitHistory    = [];
  renderFeedback();
  renderPatternStrip();
  schedulerTimer = setInterval(schedulerTick, SCHEDULE_INTERVAL_MS);
}

function stopMetronome() {
  isRunning = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  updatePlayButton();
  renderPatternStrip();
}

function schedulerTick() {
  if (!isRunning || !pattern) return;
  const beatList  = buildBeatList(pattern);
  const totalSubs = pattern.pattern.length;
  const subdivDur = 60 / (bpm * 4); // always 16th notes

  while (nextBeatTime < audioCtx.currentTime + LOOKAHEAD_SEC) {
    const subPos = nextBeatIndex % totalSubs;
    const note   = beatList.find(b => b.pos === subPos);
    if (note) {
      scheduleSnareHit(nextBeatTime, note.dynamic);
      expectedBeats.push({
        time: nextBeatTime + latencyOffsetMs / 1000,
        dynamic: note.dynamic,
        matched: false,
      });
      if (expectedBeats.length > 200) expectedBeats.shift();
    }

    nextBeatTime += subdivDur;
    nextBeatIndex++;

    if (nextBeatIndex % totalSubs === 0) {
      const delay = Math.max(0, (nextBeatTime - subdivDur - audioCtx.currentTime) * 1000);
      setTimeout(renderPatternStrip, delay);
    }
  }
}

// ─── Onset processing ─────────────────────────────────────────────────────────

function processOnset({ time, peak }) {
  const detectedDynamic = peakToDynamic(peak);
  if (calState !== null) {
    if (calState.phase === 'delay') { handleDelayCalOnset(time); return; }
    handleCalOnset(peak); return;
  }
  if (!isRunning) return;

  let best = null, bestDist = Infinity;
  for (const eb of expectedBeats) {
    if (eb.matched) continue;
    const dist = Math.abs(time - eb.time);
    if (dist < bestDist && dist <= MATCH_WINDOW_SEC) { bestDist = dist; best = eb; }
  }

  const timingMs = best ? Math.round((time - best.time) * 1000) : null;
  if (best) best.matched = true;

  hitHistory.push({
    timingMs,
    expected: best ? best.dynamic : null,
    detected: detectedDynamic,
    matched:  best !== null,
  });
  if (hitHistory.length > HISTORY_SIZE) hitHistory.shift();
  renderFeedback();
}

// ─── Calibration ─────────────────────────────────────────────────────────────

function startCalibration() {
  if (isRunning) stopMetronome();
  if (!onsetNode) return;
  calState = { phase: 'delay', started: false, beats: [], taps: [] };
  scheduleDelayCalBeats();
  renderDelayCalPrompt();
}

function scheduleDelayCalBeats() {
  const beatDur = 60 / CAL_DELAY_BPM;
  let t = audioCtx.currentTime + 0.5;
  // Schedule extra beats so the user has time to find the rhythm before the count starts
  for (let i = 0; i < CAL_DELAY_BEATS * 3; i++) {
    const nodes = scheduleSnareHit(t, 'accent');
    calState.beats.push({ time: t, matched: false, nodes });
    t += beatDur;
  }
  // No timeout — finalization is triggered by collecting CAL_DELAY_BEATS taps
}

function handleDelayCalOnset(time) {
  if (!calState.started) {
    calState.started = true;
    renderDelayCalActive();
  }
  let best = null, bestDist = Infinity;
  for (const b of calState.beats) {
    if (b.matched) continue;
    const dist = Math.abs(time - b.time);
    if (dist < bestDist && dist < 0.5) { bestDist = dist; best = b; }
  }
  if (best) {
    best.matched = true;
    calState.taps.push(time - best.time);
    updateDelayCalProgress();
    if (calState.taps.length >= CAL_DELAY_BEATS) finalizeDelayCalibration();
  }
}

function finalizeDelayCalibration() {
  if (!calState || calState.phase !== 'delay') return;
  // Stop any beats that haven't played yet
  const now = audioCtx.currentTime;
  for (const b of calState.beats) {
    if (b.time > now) {
      for (const node of b.nodes) { try { node.stop(now); } catch (_) {} }
    }
  }
  const taps = calState.taps;
  if (taps.length >= 3) {
    const sorted = [...taps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    latencyOffsetMs = Math.max(0, Math.min(500, Math.round(median * 1000)));
    document.getElementById('latency-display').textContent = `${latencyOffsetMs}ms`;
    localStorage.setItem(LS_LATENCY, String(latencyOffsetMs));
  }
  calState = { phase: 'strength', step: 0, readings: [] };
  renderCalPrompt();
}

function handleCalOnset(peak) {
  calState.readings.push(peak);
  updateCalProgress();
  if (calState.readings.length >= CAL_HITS_NEEDED) {
    const sorted = [...calState.readings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    cal[CAL_STEPS[calState.step]] = median;

    calState.step++;
    calState.readings = [];
    if (calState.step >= CAL_STEPS.length) {
      // Derive the two intermediate levels from the calibrated endpoints
      const range = cal.loud_accent - cal.low_tap;
      cal.accent = cal.low_tap + range * (2 / 3);
      cal.tap    = cal.low_tap + range * (1 / 3);
      calState = null;
      saveCalibration();
      renderCalDone();
    } else {
      renderCalPrompt();
    }
  }
}

// ─── Render: pattern strip ────────────────────────────────────────────────────

function renderPatternStrip() {
  const container = document.getElementById('pattern-strip');
  if (!pattern) { container.innerHTML = '<em>No pattern loaded</em>'; return; }

  const W = container.clientWidth;
  if (W === 0) { requestAnimationFrame(renderPatternStrip); return; }

  // Always show 2 bars of 4/4 = 32 16th notes, repeating the pattern as needed
  const BARS = 2, N = 16, TOTAL = BARS * N;
  const seq  = Array.from({ length: TOTAL }, (_, i) => pattern.pattern[i % pattern.pattern.length]);

  const H     = 92;
  const mL    = 52, mR = 22;
  const lineH = 9;
  const sT    = 34;                  // staff top (shifted down to leave room for accents)
  const midY  = sT + 2 * lineH;     // middle staff line (snare position)
  const stemT = sT - 22;            // top of stems
  const beamH = 4;
  const barW  = (W - mL - mR) / BARS;
  const noteW = barW / N;

  const sc = '#484848';  // staff lines, stems, beams
  const nc = '#d4d4d8';  // loud accent notehead
  const dc = '#2c2c2e';  // low tap notehead (dim)

  // x centre for note i
  const nx = i => mL + Math.floor(i / N) * barW + (i % N + 0.5) * noteW;

  const p = [];

  // Staff lines
  for (let l = 0; l < 5; l++)
    p.push(`<line x1="${mL - 4}" y1="${sT + l*lineH}" x2="${W - mR}" y2="${sT + l*lineH}" stroke="${sc}" stroke-width="1"/>`);

  // Percussion clef: two thick vertical bars
  p.push(`<rect x="8"  y="${sT}" width="3.5" height="${4*lineH}" fill="${sc}"/>`);
  p.push(`<rect x="15" y="${sT}" width="3.5" height="${4*lineH}" fill="${sc}"/>`);

  // Time signature 4/4
  const tf = `text-anchor="middle" dominant-baseline="middle" font-size="15" font-family="serif" fill="${nc}"`;
  p.push(`<text x="34" y="${sT +   lineH}" ${tf}>4</text>`);
  p.push(`<text x="34" y="${sT + 3*lineH}" ${tf}>4</text>`);

  // Barlines: opening, middle, and final double barline
  p.push(`<line x1="${mL}" y1="${sT}" x2="${mL}" y2="${sT + 4*lineH}" stroke="${sc}" stroke-width="1.5"/>`);
  for (let b = 1; b <= BARS; b++) {
    const bx = mL + b * barW;
    p.push(`<line x1="${bx}" y1="${sT}" x2="${bx}" y2="${sT + 4*lineH}" stroke="${sc}" stroke-width="1.5"/>`);
    if (b === BARS)
      p.push(`<line x1="${bx + 4}" y1="${sT}" x2="${bx + 4}" y2="${sT + 4*lineH}" stroke="${sc}" stroke-width="4"/>`);
  }

  // Beams: 2 beams per beat group (8 beat groups = 4 beats × 2 bars)
  for (let beat = 0; beat < 8; beat++) {
    const x1 = nx(beat*4) - 1, x2 = nx(beat*4 + 3) + 1;
    p.push(`<rect x="${x1}" y="${stemT}"         width="${x2 - x1}" height="${beamH}" fill="${sc}"/>`);
    p.push(`<rect x="${x1}" y="${stemT+beamH+2}" width="${x2 - x1}" height="${beamH}" fill="${sc}"/>`);
  }

  // Stems, noteheads, and accent marks
  const accentY = stemT - 7;           // accent mark row, above the beams
  for (let i = 0; i < TOTAL; i++) {
    const x = nx(i), ch = seq[i];

    // Stem
    p.push(`<line x1="${x}" y1="${midY - 3}" x2="${x}" y2="${stemT + beamH}" stroke="${sc}" stroke-width="1.2"/>`);

    if (ch === 'X') {
      // Loud accent: bright notehead + ">" mark below the staff
      p.push(`<ellipse cx="${x}" cy="${midY}" rx="5" ry="3.5" fill="${nc}"/>`);
      p.push(`<path d="M${x-4},${accentY-3} L${x+4},${accentY} L${x-4},${accentY+3}" stroke="${nc}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`);
    } else if (ch === 'o') {
      // Low tap: dim notehead, no accent mark
      p.push(`<ellipse cx="${x}" cy="${midY}" rx="5" ry="3.5" fill="${dc}"/>`);
    }
  }

  container.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${p.join('')}</svg>`;
}

// ─── Render: feedback panels ──────────────────────────────────────────────────

function renderFeedback() {
  renderPerfCanvas();
}

function renderPerfCanvas() {
  const canvas = document.getElementById('perf-canvas');
  if (!canvas) return;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  if (W === 0 || H === 0) return;

  // Setting width/height clears the canvas and matches its intrinsic size to CSS size
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const MAX_MS  = 200;   // ±200 ms timing range
  const MAX_DYN = 3;     // ±3 ordinal dynamic levels

  const padX = 36, padY = 20;
  const plotW = W - 2 * padX;
  const plotH = H - 2 * padY;
  const cx = padX + plotW / 2;
  const cy = padY + plotH / 2;

  // Map timing error (ms) to canvas x
  const toX = ms  => padX + (Math.max(-MAX_MS, Math.min(MAX_MS, ms))  / MAX_MS  + 1) / 2 * plotW;
  // Map dynamic ordinal error to canvas y (positive = too loud = top)
  const toY = err => padY + (-Math.max(-MAX_DYN, Math.min(MAX_DYN, err)) / MAX_DYN + 1) / 2 * plotH;

  // Bullseye rings
  ctx.lineWidth = 1;
  for (const r of [0.33, 0.66, 1.0]) {
    ctx.strokeStyle = r === 0.33 ? '#2a3a2a' : '#252525';
    ctx.beginPath();
    ctx.ellipse(cx, cy, plotW / 2 * r, plotH / 2 * r, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Crosshair
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, cy); ctx.lineTo(W - padX, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, padY); ctx.lineTo(cx, H - padY); ctx.stroke();

  // Axis labels
  ctx.font = '11px monospace';
  ctx.fillStyle = '#888';
  ctx.textAlign = 'left';  ctx.fillText('early', padX + 3, cy - 4);
  ctx.textAlign = 'right'; ctx.fillText('late',  W - padX - 3, cy - 4);
  ctx.textAlign = 'center';
  ctx.fillText('loud', cx, padY + 10);
  ctx.fillText('soft', cx, H - padY - 4);

  // Hits
  const hits = hitHistory.filter(h => h.matched && h.timingMs !== null && h.expected);
  if (hits.length === 0) {
    ctx.fillStyle = '#444';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Play to see feedback', cx, cy + 4);
    return;
  }

  hits.forEach((hit, idx) => {
    const opacity  = 0.2 + 0.8 * (idx + 1) / hits.length;
    const dynErr   = dynamicOrdinal(hit.detected) - dynamicOrdinal(hit.expected);
    const x = toX(hit.timingMs);
    const y = toY(dynErr);

    const timingOk    = Math.abs(hit.timingMs) <= TIMING_GREEN_MS;
    const timingClose = Math.abs(hit.timingMs) <= TIMING_YELLOW_MS;
    const dynOk       = dynErr === 0;
    const dynClose    = Math.abs(dynErr) <= 1;

    let [r, g, b] =
      (timingOk    && dynOk)    ? [48, 209, 88]   :  // green
      (timingClose && dynClose) ? [255, 214, 10]   :  // yellow
                                  [255, 69, 58];       // red

    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},${opacity})`;
    ctx.fill();
  });
}

// ─── Render: calibration ──────────────────────────────────────────────────────

function renderDelayCalPrompt() {
  const el = document.getElementById('cal-status');
  el.textContent = `Delay calibration: beats are playing — start tapping when ready…`;
  el.className   = 'cal-active';
  document.getElementById('cal-progress').textContent = '';
}

function renderDelayCalActive() {
  document.getElementById('cal-status').textContent =
    `Delay calibration: keep tapping (${CAL_DELAY_BEATS} beats at ${CAL_DELAY_BPM} BPM)…`;
  document.getElementById('cal-progress').textContent = `0 / ${CAL_DELAY_BEATS}`;
}

function updateDelayCalProgress() {
  document.getElementById('cal-progress').textContent =
    `${calState.taps.length} / ${CAL_DELAY_BEATS}`;
}

function renderCalPrompt() {
  const dyn = CAL_STEPS[calState.step];
  const el  = document.getElementById('cal-status');
  el.textContent = `Stroke calibration ${calState.step + 1}/${CAL_STEPS.length}: hit "${dyn.replace('_', ' ')}" (${DYNAMIC_LABELS[dyn]}) — ${CAL_HITS_NEEDED}×`;
  el.className   = 'cal-active';
  document.getElementById('cal-progress').textContent = '';
}

function updateCalProgress() {
  document.getElementById('cal-progress').textContent =
    `${calState.readings.length} / ${CAL_HITS_NEEDED}`;
}

function renderCalDone() {
  const el = document.getElementById('cal-status');
  el.textContent = '';
  el.className   = '';
  document.getElementById('cal-progress').textContent = '';
}

// ─── Render: velocity meter ───────────────────────────────────────────────────

function updateVelocityMeter(peak) {
  // True peak is 0–1 (clipping = 1.0). Show as percentage with a bit of headroom.
  document.getElementById('vel-fill').style.height = `${Math.min(100, peak * 110)}%`;
  document.getElementById('vel-label').textContent  = DYNAMIC_LABELS[peakToDynamic(peak)];
}

// ─── Render: play button ──────────────────────────────────────────────────────

function updatePlayButton() {
  const btn = document.getElementById('btn-play');
  btn.textContent = isRunning ? 'Stop' : 'Start';
  btn.classList.toggle('running', isRunning);
}


// ─── Pattern loading from server ─────────────────────────────────────────────

let allPatterns = [];

async function fetchPatterns() {
  const res  = await fetch('/patterns/patterns.json');
  allPatterns = await res.json();

  const sel = document.getElementById('pattern-select');
  sel.innerHTML = '';
  for (const pat of allPatterns) {
    const opt = document.createElement('option');
    opt.value = pat.name;
    opt.textContent = pat.name;
    sel.appendChild(opt);
  }
  if (allPatterns.length > 0) loadPattern(allPatterns[0].name);
}

function loadPattern(name) {
  pattern = allPatterns.find(p => p.name === name) || null;
  if (isRunning) {
    nextBeatIndex = 0;
    expectedBeats = [];
    hitHistory    = [];
    renderFeedback();
  }
  renderPatternStrip();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function onPlayStop() {
  if (!audioCtx) { await initAudio(); await startMic(); }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (isRunning) {
    stopMetronome();
  } else {
    bpm = parseInt(document.getElementById('bpm-input').value, 10) || 90;
    startMetronome();
  }
  updatePlayButton();
}

async function onCalibrate() {
  if (!audioCtx) { await initAudio(); await startMic(); }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  startCalibration();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('latency-display').textContent = `${latencyOffsetMs}ms`;

  document.getElementById('btn-play').addEventListener('click', onPlayStop);
  document.getElementById('btn-calibrate').addEventListener('click', onCalibrate);
  document.getElementById('pattern-select').addEventListener('change', () => {
    loadPattern(document.getElementById('pattern-select').value);
  });
  document.getElementById('bpm-input').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 40 && v <= 300) bpm = v;
  });
  window.addEventListener('resize', renderPatternStrip);

  await fetchPatterns();
});
