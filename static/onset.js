/**
 * AudioWorklet processor for real-time onset detection.
 *
 * Detection: RMS energy over a short window vs. a slowly-decaying background.
 * Peak reporting: true peak (max |sample|) over the window at onset time.
 *   RMS is fine for detecting *when* a hit occurs, but it averages out the sharp
 *   transient, badly underestimating hit strength. True peak captures the actual
 *   impact amplitude and gives much better dynamics discrimination.
 */

const THRESHOLD_RATIO  = 3.0;   // onset if instantRMS > background * ratio
const REFRACTORY_MS    = 80;    // min ms between onsets (avoid double-trigger)
const WINDOW_SAMPLES   = 220;   // ~5ms at 44100 Hz — detection energy window
const BACKGROUND_DECAY = 0.995; // per-sample decay of background energy estimate

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bgEnergy          = 0;
    this._samplesSinceOnset = Infinity;
    this._refractorySamples = Math.round(sampleRate * REFRACTORY_MS / 1000);
    this._windowBuffer      = new Float32Array(WINDOW_SAMPLES);
    this._windowIdx         = 0;
    this._windowSum         = 0; // sum of squares for RMS

    this._thresholdRatio = THRESHOLD_RATIO;
    this.port.onmessage = (e) => {
      if (e.data.type === 'setThreshold') this._thresholdRatio = e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];

    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];

      // Maintain rolling window for RMS-based detection
      this._windowSum -= this._windowBuffer[this._windowIdx] ** 2;
      this._windowBuffer[this._windowIdx] = sample;
      this._windowSum += sample * sample;
      this._windowIdx = (this._windowIdx + 1) % WINDOW_SAMPLES;

      const instantRMS = Math.sqrt(Math.max(0, this._windowSum) / WINDOW_SAMPLES);

      this._bgEnergy =
        this._bgEnergy * BACKGROUND_DECAY + instantRMS * (1 - BACKGROUND_DECAY);

      this._samplesSinceOnset++;

      const threshold = Math.max(this._bgEnergy * this._thresholdRatio, 0.005);
      if (instantRMS > threshold && this._samplesSinceOnset > this._refractorySamples) {
        this._samplesSinceOnset = 0;

        // True peak: scan the window for max |sample|.
        // Only runs once per onset (cheap) and captures the actual impact strength
        // far better than RMS, which averages the transient across 5ms.
        let truePeak = 0;
        for (let j = 0; j < WINDOW_SAMPLES; j++) {
          const abs = Math.abs(this._windowBuffer[j]);
          if (abs > truePeak) truePeak = abs;
        }

        this.port.postMessage({
          type: 'onset',
          time: currentTime + i / sampleRate,
          peak: truePeak,
        });
      }
    }

    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
