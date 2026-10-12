import assert from 'node:assert/strict';
import test from 'node:test';
import { rainfallScaleMax } from '../src/utils/rainfallScale.js';
import { getHeatColor, heatNormPosition } from '../src/utils/heatColor.js';

test('one case keeps its field scale across dates, independent of observation extremes', () => {
  const frames = [
    { min: -8, max: 4.5, fieldScaleMax: 12, scaleMax: 75 },
    { min: -3, max: 10, fieldScaleMax: 12, scaleMax: 75 },
    { min: -12, max: 9, fieldScaleMax: 12, scaleMax: 75 },
  ];
  for (const frame of frames) assert.equal(rainfallScaleMax(frame, 'window'), 12);
  const limit = rainfallScaleMax(frames[0], 'window');
  assert.equal(heatNormPosition(frames[0].min, -limit, limit), 1 / 6);
  assert.equal(getHeatColor(-12, -limit, limit), 'rgb(58, 95, 205)');
  assert.equal(getHeatColor(12, -limit, limit), 'rgb(103, 0, 31)');
  assert.equal(getHeatColor(0, -limit, limit), 'rgb(247, 247, 247)');
});

test('switching case or view can load a different complete-window range', () => {
  assert.equal(rainfallScaleMax({ fieldScaleMax: 12, scaleMax: 75 }, 'window'), 12);
  assert.equal(rainfallScaleMax({ fieldScaleMax: 18, scaleMax: 90 }, 'window'), 18);
  assert.equal(rainfallScaleMax({ fieldScaleMax: 75, scaleMax: 75 }, 'window'), 75);
});

test('shared mode retains the full-window range across dates and views', () => {
  for (const frame of [
    { min: -8, max: 4, scaleMax: 75 },
    { min: -20, max: 11, scaleMax: 75 },
  ]) assert.equal(rainfallScaleMax(frame, 'shared'), 75);
});

test('fixed-window mode never falls back to the currently displayed date', () => {
  assert.equal(rainfallScaleMax(null, 'window'), null);
  assert.equal(rainfallScaleMax({ fieldScaleMax: 0 }, 'window'), 1e-6);
  assert.equal(rainfallScaleMax({ min: -8, max: 4, scaleMax: 75 }, 'window'), 75);
  assert.equal(rainfallScaleMax({ min: -8, max: 4 }, 'window'), null);
  assert.equal(rainfallScaleMax({ fieldScaleMax: NaN, scaleMax: Infinity, data: [[-8, 4]] }, 'window'), null);
});

test('upload previews without window metadata retain their existing fallback', () => {
  assert.equal(rainfallScaleMax({ min: -5, max: 2, scaleMax: NaN }, 'shared'), 5);
  assert.equal(rainfallScaleMax({ min: 0, max: 0 }, 'shared'), 1e-6);
});
