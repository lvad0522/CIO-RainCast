import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFieldFrame,
  buildGridResponse,
  buildProjectionFrame,
  decodeFrameBundle,
  decodeInputPool,
  float64Payload,
  rainfallColorLimit,
  REMOTE_PREFIX,
  resolveAssetUrl,
} from '../src/utils/staticRebuild.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'public', 'demo-data');
const DATA_ROOT = '/demo-data/';

// ── formula unit tests (no data files needed) ───────────────────────────────

test('grid rebuild slices the (rows, cols, steps) block at the clicked point', () => {
  const arrays = {
    rows: 2,
    cols: 3,
    steps: 2,
    // index = (row * cols + col) * steps + step
    predict2: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    real2: Float32Array.from([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]),
    pearsonR: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
  };
  assert.deepStrictEqual(buildGridResponse(arrays, 0, 0), {
    real: [21, 22], pred: [1, 2], r: Math.fround(0.1), source: 'dataset',
  });
  assert.deepStrictEqual(buildGridResponse(arrays, 1, 2), {
    real: [31, 32], pred: [11, 12], r: Math.fround(0.6), source: 'dataset',
  });
  assert.throws(() => buildGridResponse(arrays, 2, 0), /outside the 2x3 field/);
  assert.throws(() => buildGridResponse(arrays, 0, -1), /outside the 2x3 field/);
});

test('frame rebuild keeps window limits separate from the daily extremes', () => {
  const arrays = {
    rows: 2,
    cols: 2,
    steps: 2,
    predict2: Float32Array.from([0, 1, 2, -3, 40, 5, 6, 7]), // window max |v| = 40
    real2: Float32Array.from([8, 9, 10, 11, 12, 13, 14, 15]),
    pearsonR: new Float32Array(4),
  };
  const frame = buildFieldFrame(arrays, 'prediction', 1);
  assert.equal(frame.timeIndex, 1);
  assert.equal(frame.rows, 2);
  assert.equal(frame.cols, 2);
  assert.deepStrictEqual(frame.data, [[1, -3], [5, 7]]);
  assert.equal(frame.min, -3);
  assert.equal(frame.max, 7);
  assert.equal(frame.scaleMax, 40); // shared prediction/truth window limit
  assert.equal(frame.fieldScaleMax, 40); // this field's own window limit
  assert.deepStrictEqual(buildFieldFrame(arrays, 'truth', 0).data, [[8, 10], [12, 14]]);
  assert.throws(() => buildFieldFrame(arrays, 'prediction', 2), /outside the 2-day window/);
});

test('non-finite values become null and never enter the window limit', () => {
  const values = Float32Array.from([Number.NaN, 3, Infinity, -4]);
  assert.equal(rainfallColorLimit(values), 4);
  assert.equal(rainfallColorLimit(Float32Array.from([Number.NaN])), 1e-6);
  assert.equal(rainfallColorLimit(new Float32Array(0)), 1e-6);
  const arrays = {
    rows: 1,
    cols: 3,
    steps: 1,
    predict2: Float32Array.from([Number.NaN, 2, -5]),
    real2: Float32Array.from([1, Number.NaN, 3]),
    pearsonR: new Float32Array(3),
  };
  const frame = buildFieldFrame(arrays, 'prediction', 0);
  assert.deepStrictEqual(frame.data, [[null, 2, -5]]);
  assert.equal(frame.min, -5);
  assert.equal(frame.max, 2);
  assert.equal(frame.scaleMax, 5); // truth's NaN is skipped, its 3 is kept
});

test('asset paths split into the repository layer and the external host', () => {
  const manifest = { remoteBase: 'https://example.org/datasets/demo/resolve/main/' };
  assert.equal(
    resolveAssetUrl(manifest, 'cases/2000-pre1/run.json', DATA_ROOT),
    `${DATA_ROOT}cases/2000-pre1/run.json`,
  );
  assert.equal(
    resolveAssetUrl(manifest, `${REMOTE_PREFIX}cases/2000-pre1/frames.bin.gz`, DATA_ROOT),
    'https://example.org/datasets/demo/resolve/main/cases/2000-pre1/frames.bin.gz',
  );
  // A base without the trailing slash must not glue paths together.
  assert.equal(
    resolveAssetUrl({ remoteBase: 'https://example.org/data' }, `${REMOTE_PREFIX}input/2000.f32.gz`, DATA_ROOT),
    'https://example.org/data/input/2000.f32.gz',
  );
  assert.throws(
    () => resolveAssetUrl({}, `${REMOTE_PREFIX}input/2000.f32.gz`, DATA_ROOT),
    /remoteBase/,
  );
});

// ── parity with the baked backend responses ────────────────────────────────

function loadBytes(relpath) {
  const raw = readFileSync(join(dataDir, relpath));
  return relpath.endsWith('.gz') ? gunzipSync(raw) : raw;
}

function loadFloat32(relpath) {
  const buffer = loadBytes(relpath);
  assert.equal(buffer.byteLength % 4, 0, `${relpath}: not a float32 payload`);
  return new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
}

function decodeBase64(text, label) {
  const buffer = Buffer.from(text, 'base64');
  assert.ok(buffer.byteLength > 0, `${label}: empty base64 payload`);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** The bake's own tolerance model: `abs(a - b) <= tol * max(1, abs(b))`. */
function assertClose(actual, expected, tol, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} != ${expected} (tol ${tol})`,
  );
}

function loadDemoData() {
  const manifestPath = join(dataDir, 'manifest.json');
  assert.ok(
    existsSync(manifestPath),
    `静态演示数据缺失：${manifestPath}。先运行 python scripts/bake_demo_data.py。`,
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { manifest, fixtures: manifest.testFixtures };
}

test('every manifest case ships the full heavy layer through the external host', () => {
  const { manifest, fixtures } = loadDemoData();
  assert.equal(manifest.version, 2, 'manifest 版本不是 2');
  assert.ok(manifest.remoteBase, 'manifest 缺少 remoteBase');
  const cases = Object.entries(manifest.cases);
  assert.ok(cases.length > 0, 'manifest 里没有任何用例');
  let heavy = 0;
  for (const [caseId, entry] of cases) {
    assert.ok(entry.full, `${caseId}: 不是完整层用例`);
    const paths = [
      entry.arrays.predict2, entry.arrays.real2, entry.arrays.pearsonR,
      entry.frames.index, entry.frames.bundle, entry.input,
    ];
    for (const path of paths) {
      assert.ok(path.startsWith(REMOTE_PREFIX), `${caseId}: ${path} 没有走外置层`);
      assert.ok(
        !existsSync(join(dataDir, path)),
        `${caseId}: ${path} 不该出现在仓库层（体积会失控）`,
      );
    }
    heavy += 1;
  }
  assert.equal(heavy, cases.length);
  assert.ok(fixtures?.parity && fixtures?.projection && fixtures?.arrays, '测试夹具不完整');
});

test('browser rebuild reproduces the baked backend responses exactly', () => {
  const { manifest, fixtures } = loadDemoData();
  const parity = JSON.parse(loadBytes(fixtures.parity).toString('utf8'));
  const entry = manifest.cases[parity.case];
  assert.ok(entry?.full, `${parity.case} 必须是完整层用例`);
  // The arrays live on the external host, so the fixture ships its own copy.
  const arrays = {
    predict2: loadFloat32(fixtures.arrays.predict2),
    real2: loadFloat32(fixtures.arrays.real2),
    pearsonR: loadFloat32(fixtures.arrays.pearsonR),
    rows: fixtures.shape.rows,
    cols: fixtures.shape.cols,
    steps: fixtures.shape.steps,
  };
  for (const sample of parity.grid) {
    assert.deepStrictEqual(
      buildGridResponse(arrays, sample.i, sample.j),
      sample.response,
      `grid (${sample.i}, ${sample.j}) 与后端响应不一致`,
    );
  }
  for (const frame of parity.frames) {
    assert.deepStrictEqual(
      buildFieldFrame(arrays, frame.which, frame.timeIndex),
      frame.response,
      `${frame.which} frame t=${frame.timeIndex} 与后端响应不一致`,
    );
  }
});

test('browser projection rebuild reproduces the baked backend responses', () => {
  const { manifest, fixtures } = loadDemoData();
  const payload = JSON.parse(loadBytes(fixtures.projection).toString('utf8'));
  assert.equal(payload.case, fixtures.case, '投影夹具与数组夹具必须来自同一用例');

  const bundle = decodeFrameBundle(decodeBase64(payload.bundle_b64, 'bundle'));
  const pool = decodeInputPool(decodeBase64(payload.pool_b64, 'pool'));
  const weights = float64Payload(decodeBase64(payload.weights_b64, 'weights'));
  assert.equal(bundle.rows, payload.grid.rows);
  assert.equal(bundle.cols, payload.grid.cols);
  assert.equal(bundle.steps, payload.samples.length);
  assert.equal(weights.length, payload.grid.rows * payload.grid.cols);

  const { lat, lon } = manifest.projection;
  payload.samples.forEach((sample, position) => {
    // The fixture bundle holds only the sampled days, so the position inside
    // the shrunken index is what the shim passes in; the date check below is
    // what proves the day was picked correctly.
    const frame = buildProjectionFrame(payload.index, bundle, weights, pool, position, lat, lon);
    assert.equal(frame.date, sample.date, `第 ${position} 帧的日期对不上`);
    assert.equal(frame.totalSteps, payload.samples.length);
    assert.equal(frame.targetYear, payload.index.targetYear);
    assertClose(frame.projectedCio, sample.projectedCio, 1e-9, `${sample.date} projectedCio`);
    assertClose(frame.contributionSum, sample.contributionSum, 1e-9, `${sample.date} contributionSum`);
    for (const key of ['projectedCio', 'positiveSum', 'negativeSum', 'net', 'closureError']) {
      assertClose(
        frame.selectedContribution[key], sample.selectedContribution[key],
        1e-9, `${sample.date} selectedContribution.${key}`,
      );
    }
    for (const [key, index] of [['input', 0], ['processed', 1], ['contribution', 2]]) {
      const stage = frame.stages[index];
      assertClose(stage.scaleMax, sample.scaleMax[key], 1e-12, `${sample.date} stages.${key}.scaleMax`);
      assert.equal(stage.data.length, payload.grid.rows, `${sample.date} stages.${key} 行数`);
      assert.equal(stage.data[0].length, payload.grid.cols, `${sample.date} stages.${key} 列数`);
    }
    assertClose(
      frame.windowContribution.scaleMax, sample.averageAbsScaleMax, 1e-12,
      `${sample.date} windowContribution.scaleMax`,
    );
    // The window average is baked as float64 and passed through untouched.
    assert.equal(frame.windowContribution.averageAbs, payload.index.averageAbs);
    // Cell samples: float32 payloads carry ~7 significant digits, so compare
    // with the bake's own tolerance model; `input` is float32 on both sides.
    for (const cell of sample.cells) {
      const [row, col] = [cell.row, cell.col];
      assert.equal(frame.stages[0].data[row][col], cell.input, `${sample.date} input[${row}][${col}]`);
      assertClose(frame.stages[1].data[row][col], cell.processed, 1e-6, `${sample.date} processed[${row}][${col}]`);
      assertClose(frame.stages[2].data[row][col], cell.contribution, 1e-6, `${sample.date} contribution[${row}][${col}]`);
    }
  });
});
