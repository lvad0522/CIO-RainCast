// Symmetric limits keep zero at the same color and both signs on the same scale.
const MIN_SCALE = 1e-6;

export function rainfallScaleMax(frame, mode = 'shared') {
  if (!frame) return null;
  if (mode === 'window') {
    // The backend computes these limits over all 112 dates for this case.
    // Older responses may use their shared full-window limit, never daily extrema.
    for (const limit of [frame.fieldScaleMax, frame.scaleMax]) {
      if (Number.isFinite(limit) && limit >= 0) return Math.max(limit, MIN_SCALE);
    }
    return null;
  }
  if (mode === 'shared' && Number.isFinite(frame.scaleMax) && frame.scaleMax > 0) {
    return frame.scaleMax;
  }

  const extremes = [frame.min, frame.max].filter(Number.isFinite);
  const values = extremes.length === 2
    ? extremes
    : (frame.data || []).flat().filter(Number.isFinite);
  let maxAbs = 0;
  for (const value of values) maxAbs = Math.max(maxAbs, Math.abs(value));
  return maxAbs > 0 ? maxAbs : MIN_SCALE;
}
