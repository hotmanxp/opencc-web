// @ts-nocheck
import * as React from 'react';
type Props = {
  voiceState: 'idle' | 'recording' | 'processing';
};

// Processing shimmer colors: dim gray to lighter gray (matches ThinkingShimmerText)
const PROCESSING_DIM = {
  r: 153,
  g: 153,
  b: 153
};
const PROCESSING_BRIGHT = {
  r: 185,
  g: 185,
  b: 185
};
const PULSE_PERIOD_S = 2; // 2 second period for all pulsing animations

export function VoiceIndicator(props) {
  return null;
}
function VoiceIndicatorImpl(t0) {
  return null;
}

// Static — the warmup window (~120ms between space #2 and activation)
// is too brief for a 1s-period shimmer to register, and a 50ms animation
// timer here runs concurrently with auto-repeat spaces arriving every
// 30-80ms, compounding re-renders during an already-busy window.
export function VoiceWarmupHint() {
  return null;
}
function ProcessingShimmer() {
  return null;
}
