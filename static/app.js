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
  const beats = pat.notes.map(n => ({
    pos: (n.beat - 1) * pat.subdivisions + (n.sub - 1),
    dynamic: n.dynamic,
  }));
  beats.sort((a, b) => a.pos - b.pos);
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
      document.getElementById('latency-input').value = auto;
      document.getElementById('latency-display').textContent = `${auto}ms`;
      showLatencyHint(auto);
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

// Subtle subdivision tick so the drummer can hear the grid.
function scheduleMetronomeTick(time, isOnBeat) {
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = isOnBeat ? 1000 : 700;
  gain.gain.setValueAtTime(isOnBeat ? 0.2 : 0.08, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);
  osc.start(time);
  osc.stop(time + 0.04);
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
  const totalSubs = pattern.beats_per_bar * pattern.subdivisions;
  const subdivDur = 60 / (bpm * pattern.subdivisions);

  while (nextBeatTime < audioCtx.currentTime + LOOKAHEAD_SEC) {
    const subPos    = nextBeatIndex % totalSubs;
    const isOnBeat  = subPos % pattern.subdivisions === 0;

    scheduleMetronomeTick(nextBeatTime, isOnBeat);

    const note = beatList.find(b => b.pos === subPos);
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
  if (calState !== null) { handleCalOnset(peak); return; }
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
  calState = { step: 0, readings: [] };
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
  container.innerHTML = '';

  const totalSubs  = pattern.beats_per_bar * pattern.subdivisions;
  const beatList   = buildBeatList(pattern);
  const currentSub = isRunning ? (nextBeatIndex - 1 + totalSubs) % totalSubs : -1;

  for (let i = 0; i < totalSubs; i++) {
    const cell = document.createElement('div');
    cell.className = 'strip-cell';
    if (i % pattern.subdivisions === 0) cell.classList.add('on-beat');
    if (i === currentSub) cell.classList.add('active');

    if (i % pattern.subdivisions === 0) {
      const num = document.createElement('div');
      num.className = 'beat-num';
      num.textContent = i / pattern.subdivisions + 1;
      cell.appendChild(num);
    }

    const note = beatList.find(b => b.pos === i);
    const el   = document.createElement('div');
    if (note) {
      el.className   = `strip-note dyn-${note.dynamic}`;
      el.textContent = DYNAMIC_LABELS[note.dynamic];
    } else {
      el.className   = 'strip-rest';
      el.textContent = '·';
    }
    cell.appendChild(el);
    container.appendChild(cell);
  }
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

function renderCalPrompt() {
  const dyn = CAL_STEPS[calState.step];
  const el  = document.getElementById('cal-status');
  el.textContent = `Step ${calState.step + 1}/${CAL_STEPS.length}: hit "${dyn.replace('_', ' ')}" (${DYNAMIC_LABELS[dyn]}) — ${CAL_HITS_NEEDED}×`;
  el.className   = 'cal-active';
  document.getElementById('cal-progress').textContent = '';
}

function updateCalProgress() {
  document.getElementById('cal-progress').textContent =
    `${calState.readings.length} / ${CAL_HITS_NEEDED}`;
}

function renderCalDone() {
  const el = document.getElementById('cal-status');
  el.textContent = 'Calibration complete — thresholds saved.';
  el.className   = 'cal-done';
  document.getElementById('cal-progress').textContent = '';
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
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

function showLatencyHint(ms) {
  const el = document.getElementById('latency-hint');
  if (!el) return;
  el.textContent = `Auto-detected ~${ms}ms — adjust if hits still appear consistently late.`;
  setTimeout(() => { el.textContent = ''; }, 6000);
}

// ─── Pattern loading from server ─────────────────────────────────────────────

async function fetchPatterns() {
  const res   = await fetch('/api/patterns');
  const names = await res.json();

  const sel = document.getElementById('pattern-select');
  sel.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (names.length > 0) await loadPattern(names[0]);
}

async function loadPattern(name) {
  const res = await fetch(`/patterns/${name}.json`);
  pattern   = await res.json();
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

function onLatencyChange(val) {
  latencyOffsetMs = parseInt(val, 10) || 0;
  document.getElementById('latency-display').textContent = `${latencyOffsetMs}ms`;
  localStorage.setItem(LS_LATENCY, String(latencyOffsetMs));
}

function onSensitivity(val) {
  document.getElementById('sensitivity-value').textContent = parseFloat(val).toFixed(1);
  applyThreshold(parseFloat(val));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('latency-input').value = latencyOffsetMs;
  document.getElementById('latency-display').textContent = `${latencyOffsetMs}ms`;

  document.getElementById('btn-play').addEventListener('click', onPlayStop);
  document.getElementById('btn-calibrate').addEventListener('click', onCalibrate);
  document.getElementById('pattern-select').addEventListener('change', () => {
    loadPattern(document.getElementById('pattern-select').value);
  });
  document.getElementById('sensitivity-slider').addEventListener('input', (e) => {
    onSensitivity(e.target.value);
  });
  document.getElementById('latency-input').addEventListener('input', (e) => {
    onLatencyChange(e.target.value);
  });
  document.getElementById('input-gain-slider').addEventListener('input', (e) => {
    applyInputGain(parseFloat(e.target.value));
  });

  await fetchPatterns();
});
