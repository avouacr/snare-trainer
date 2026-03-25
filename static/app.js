/**
 * Batuc Trainer — main application logic
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DYNAMICS = ['tap', 'accent'];
const DYNAMIC_LABELS = { tap: 'p', accent: 'f' };

const TIMING_GREEN_MS  = 20;
const TIMING_YELLOW_MS = 80;

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.1;

const HISTORY_SIZE = 16;
const MATCH_WINDOW_SEC = 0.5;

const LS_LATENCY = 'batuc-trainer-latency';

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
let hitsSinceCorrection = 0;

const _storedLatency = parseInt(localStorage.getItem(LS_LATENCY), 10);
let latencyOffsetMs = (!isNaN(_storedLatency) && _storedLatency > 0) ? _storedLatency : 200;

let schedulerTimer = null;

// ─── Utility ─────────────────────────────────────────────────────────────────

function peakToDynamic(peak) {
  return peak >= 0.4 ? 'accent' : 'tap';
}

function buildBeatList(pat) {
  const beats = [];
  for (let i = 0; i < pat.pattern.length; i++) {
    const ch = pat.pattern[i];
    if (ch === 'X') beats.push({ pos: i, dynamic: 'accent' });
    else if (ch === 'o') beats.push({ pos: i, dynamic: 'tap' });
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
    if (auto > 0) latencyOffsetMs = auto;
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
    if (e.data.type === 'onset') processOnset(e.data);
  };
  micSource.connect(inputGainNode);
  inputGainNode.connect(onsetNode);
}


// ─── Sound synthesis ──────────────────────────────────────────────────────────

// Synthesize a snare hit: noise burst (snare wires) + pitched transient (drum head).
// Volume scales with dynamic level.
function scheduleSnareHit(time, dynamic) {
  const vol = { accent: 1.0, tap: 0.2 }[dynamic] ?? 0.5;

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
  hitsSinceCorrection = 0;
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

  if (best && timingMs !== null) {
    hitsSinceCorrection++;
    if (hitsSinceCorrection >= HISTORY_SIZE) {
      autoCorrectLatency();
      hitsSinceCorrection = 0;
    }
  }

  renderFeedback();
}

function autoCorrectLatency() {
  const matched = hitHistory.filter(h => h.matched && h.timingMs !== null);
  if (matched.length < 8) return;
  const sorted = matched.map(h => h.timingMs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (Math.abs(median) < 5) return;  // ignore negligible bias
  latencyOffsetMs = Math.max(0, Math.min(500, latencyOffsetMs + median));
  localStorage.setItem(LS_LATENCY, String(latencyOffsetMs));
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

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-play').addEventListener('click', onPlayStop);
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
