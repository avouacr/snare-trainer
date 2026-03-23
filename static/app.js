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

const CAL_STEPS    = ['loud_accent', 'accent', 'tap', 'low_tap'];
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

let latencyOffsetMs = parseInt(localStorage.getItem(LS_LATENCY) || '200', 10);

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
  inputGainNode.gain.value = parseFloat(document.getElementById('input-gain-slider').value);
  onsetNode = new AudioWorkletNode(audioCtx, 'onset-processor');
  onsetNode.port.onmessage = (e) => {
    if (e.data.type !== 'onset') return;
    updateVelocityMeter(e.data.peak);
    processOnset(e.data);
  };
  micSource.connect(inputGainNode);
  inputGainNode.connect(onsetNode);
}

function applyInputGain(val) {
  if (inputGainNode) inputGainNode.gain.value = val;
  document.getElementById('input-gain-value').textContent = `${parseFloat(val).toFixed(0)}×`;
}

function applyThreshold(ratio) {
  if (onsetNode) onsetNode.port.postMessage({ type: 'setThreshold', value: ratio });
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
  calState = { phase: 'delay', beats: [], taps: [] };
  scheduleDelayCalBeats();
  renderDelayCalPrompt();
}

function scheduleDelayCalBeats() {
  const beatDur = 60 / CAL_DELAY_BPM;
  let t = audioCtx.currentTime + 0.5;
  for (let i = 0; i < CAL_DELAY_BEATS; i++) {
    scheduleSnareHit(t, 'accent');
    calState.beats.push({ time: t, matched: false });
    t += beatDur;
  }
  setTimeout(finalizeDelayCalibration, Math.ceil((t - audioCtx.currentTime + 0.5) * 1000));
}

function handleDelayCalOnset(time) {
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
  }
}

function finalizeDelayCalibration() {
  if (!calState || calState.phase !== 'delay') return;
  const taps = calState.taps;
  if (taps.length >= 3) {
    const sorted = [...taps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    latencyOffsetMs = Math.max(-50, Math.min(500, Math.round(median * 1000)));
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
    cal[CAL_STEPS[calState.step]] = sorted[Math.floor(sorted.length / 2)];
    calState.step++;
    calState.readings = [];
    if (calState.step >= CAL_STEPS.length) {
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
  renderTimingPanel();
  renderDynamicsPanel();
}

function renderTimingPanel() {
  const container = document.getElementById('timing-bars');
  container.innerHTML = '';
  const matched = hitHistory.filter(h => h.matched && h.timingMs !== null);
  if (matched.length === 0) {
    container.innerHTML = '<span class="placeholder">Play to see timing feedback</span>';
    return;
  }
  const maxMs = 200;
  matched.forEach((hit, idx) => {
    const opacity  = 0.25 + 0.75 * (idx + 1) / matched.length;
    const pct      = Math.max(-1, Math.min(1, hit.timingMs / maxMs));
    const xPct     = ((pct + 1) / 2) * 100;
    let colorClass = 'hit-red';
    if (Math.abs(hit.timingMs) <= TIMING_GREEN_MS)  colorClass = 'hit-green';
    else if (Math.abs(hit.timingMs) <= TIMING_YELLOW_MS) colorClass = 'hit-yellow';

    const row   = document.createElement('div');
    row.className = 'timing-row';
    row.style.opacity = opacity;

    const track  = document.createElement('div');
    track.className = 'timing-track';

    const center = document.createElement('div');
    center.className = 'timing-center';
    track.appendChild(center);

    const dot = document.createElement('div');
    dot.className = `timing-dot ${colorClass}`;
    dot.style.left = `${xPct}%`;
    dot.title = `${hit.timingMs > 0 ? '+' : ''}${hit.timingMs}ms`;
    track.appendChild(dot);

    const label = document.createElement('span');
    label.className = `timing-label ${colorClass}`;
    label.textContent = `${hit.timingMs > 0 ? '+' : ''}${hit.timingMs}ms`;

    row.appendChild(track);
    row.appendChild(label);
    container.appendChild(row);
  });
}

function renderDynamicsPanel() {
  const grid = document.getElementById('dynamics-grid');
  grid.innerHTML = '';
  if (hitHistory.length === 0) {
    grid.innerHTML = '<span class="placeholder">Play to see dynamics feedback</span>';
    return;
  }
  hitHistory.forEach((hit, idx) => {
    const opacity = 0.25 + 0.75 * (idx + 1) / hitHistory.length;
    const cell    = document.createElement('div');
    cell.className    = 'dyn-cell';
    cell.style.opacity = opacity;

    const expEl = document.createElement('div');
    expEl.className   = 'dyn-expected';
    expEl.textContent = hit.expected ? DYNAMIC_LABELS[hit.expected] : '?';

    const detEl = document.createElement('div');
    detEl.className   = 'dyn-detected';
    detEl.textContent = DYNAMIC_LABELS[hit.detected] || hit.detected;

    let colorClass = 'dyn-unmatched';
    if (hit.matched && hit.expected) {
      const dist = Math.abs(dynamicOrdinal(hit.detected) - dynamicOrdinal(hit.expected));
      colorClass = dist === 0 ? 'dyn-ok' : dist === 1 ? 'dyn-close' : 'dyn-off';
    }
    detEl.classList.add(colorClass);
    cell.appendChild(expEl);
    cell.appendChild(detEl);
    grid.appendChild(cell);
  });
}

// ─── Render: calibration ──────────────────────────────────────────────────────

function renderDelayCalPrompt() {
  const el = document.getElementById('cal-status');
  el.textContent = `Delay calibration: tap on each beat (${CAL_DELAY_BEATS} beats at ${CAL_DELAY_BPM} BPM)…`;
  el.className   = 'cal-active';
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
  el.textContent = `Calibration complete — latency: ${latencyOffsetMs}ms, thresholds saved.`;
  el.className   = 'cal-done';
  document.getElementById('cal-progress').textContent = '';
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
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

function onSensitivity(val) {
  document.getElementById('sensitivity-value').textContent = parseFloat(val).toFixed(1);
  applyThreshold(parseFloat(val));
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
  document.getElementById('sensitivity-slider').addEventListener('input', (e) => {
    onSensitivity(e.target.value);
  });
  document.getElementById('input-gain-slider').addEventListener('input', (e) => {
    applyInputGain(parseFloat(e.target.value));
  });

  window.addEventListener('resize', renderPatternStrip);

  await fetchPatterns();
});
