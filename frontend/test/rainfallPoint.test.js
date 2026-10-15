import assert from 'node:assert/strict';
import test from 'node:test';
import { rainfallGridPoint } from '../src/utils/rainfallPoint.js';

const rect = { left: 30, top: 50, width: 505, height: 405 };

test('rainfall inspection maps all four displayed corners to the correct array and coordinates', () => {
  for (const [x, y, i, j, lon, lat] of [
    [30, 50, 80, 0, 100, 40], [535, 50, 80, 100, 125, 40],
    [30, 455, 0, 0, 100, 20], [535, 455, 0, 100, 125, 20],
  ]) {
    const point = rainfallGridPoint(x, y, rect, 81, 101);
    assert.deepEqual([point.i, point.j, point.lon, point.lat], [i, j, lon, lat]);
  }
});

test('rainfall inspection selects the actual cell and retains its position across display resizing', () => {
  const point = rainfallGridPoint(30 + 56.5 * 5, 50 + (80 - 6 + .5) * 5, rect, 81, 101);
  assert.deepEqual([point.i, point.j, point.lon, point.lat], [6, 56, 114, 21.5]);
  const resized = rainfallGridPoint(30 + 56.5 * 2, 50 + (80 - 6 + .5) * 2,
    { ...rect, width: 202, height: 162 }, 81, 101);
  assert.deepEqual([resized.i, resized.j, resized.lon, resized.lat], [6, 56, 114, 21.5]);
});

test('rainfall inspection clamps border events and ignores unusable canvas geometry', () => {
  assert.equal(rainfallGridPoint(0, 0, rect, 81, 101).i, 80);
  assert.equal(rainfallGridPoint(1000, 1000, rect, 81, 101).j, 100);
  assert.equal(rainfallGridPoint(30, 50, { ...rect, width: 0 }, 81, 101), null);
  assert.equal(rainfallGridPoint(NaN, 50, rect, 81, 101), null);
});
