/**
 * Client-side rebuild of the two backend responses that are too large to ship
 * baked per date and per grid point.
 *
 * These functions mirror the Python originals field by field under
 * `DISPLAY_MODE=fold1`:
 *
 * - `buildGridResponse`  → `real_data.gen_time_series` (`/api/grid`)
 * - `buildFieldFrame`    → `dataset_evaluation.frame` (`/api/dataset/.../preview`)
 * - `rainfallColorLimit` → `dataset_evaluation.rainfall_color_limit`
 *
 * They live in their own module (no `import.meta.env`, no fetch) so the plain
 * `node --test` suite can exercise them, and so `src/staticMode.js` stays the
 * only file that talks to the network shim.
 *
 * Calibration rules: `r` is read from the baked pearson product and never
 * recomputed from the series; values are float32 exactly as stored on disk.
 */

/**
 * Mirror of `real_data.gen_time_series(lead, year, grid_i, grid_j)`.
 *
 * The arrays are C-order `(rows, cols, steps)` float32 blocks; a grid point's
 * 112-day series is therefore strided by `steps`.
 */
export function buildGridResponse(arrays, i, j) {
  const { predict2, real2, pearsonR, rows, cols, steps } = arrays;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= rows || j >= cols) {
    throw new Error(`Grid point (${i}, ${j}) is outside the ${rows}x${cols} field`);
  }
  const pred = new Array(steps);
  const real = new Array(steps);
  const offset = (i * cols + j) * steps;
  for (let step = 0; step < steps; step += 1) {
    pred[step] = predict2[offset + step];
    real[step] = real2[offset + step];
  }
  return { real, pred, r: pearsonR[i * cols + j], source: 'dataset' };
}

/**
 * Mirror of `dataset_evaluation.rainfall_color_limit`: symmetric limit over
 * the complete time window (never one date), floored at 1e-6.
 */
export function rainfallColorLimit(...fields) {
  let maximum = 0;
  for (const values of fields) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (Number.isFinite(value)) {
        const magnitude = Math.abs(value);
        if (magnitude > maximum) maximum = magnitude;
      }
    }
  }
  return Math.max(maximum, 1e-6);
}

/**
 * Mirror of `dataset_evaluation.frame(values, index, scale_max)`.
 *
 * `which` picks the field: `'prediction'` uses predict2, `'truth'` uses real2.
 * `scaleMax` stays the shared prediction/truth window limit while
 * `fieldScaleMax` is this field's own window limit — both are compared with
 * the backend by `scripts/bake_demo_data.py`.
 */
export function buildFieldFrame(arrays, which, timeIndex) {
  const { predict2, real2, rows, cols, steps } = arrays;
  if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= steps) {
    throw new Error(`time_index ${timeIndex} is outside the ${steps}-day window`);
  }
  const values = which === 'truth' ? real2 : predict2;
  const scaleMax = rainfallColorLimit(predict2, real2);
  let min = Infinity;
  let max = -Infinity;
  const data = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const line = new Array(cols);
    for (let col = 0; col < cols; col += 1) {
      const value = values[(row * cols + col) * steps + timeIndex];
      line[col] = Number.isFinite(value) ? value : null;
      if (Number.isFinite(value)) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    data[row] = line;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('This date has no valid data');
  }
  return {
    timeIndex,
    rows,
    cols,
    min,
    max,
    scaleMax,
    fieldScaleMax: rainfallColorLimit(values),
    data,
  };
}

// ── binary payloads served by the remote dataset host ───────────────────────
//
// The heavy demo payloads live outside the repository (see
// `scripts/bake_demo_data.py`).  Both formats start with a 16-byte header:
// magic | u16 version | u16 a | u16 b | u16 c | u32 reserved, then little-endian
// float32 data and float64 scalars.  All reads go through `DataView` so a
// big-endian host would still decode correctly.

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function magicOf(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

function typedArray(view, offset, length, Kind) {
  if (IS_LITTLE_ENDIAN) {
    const start = view.byteOffset + offset;
    return new Kind(view.buffer.slice(start, start + length * Kind.BYTES_PER_ELEMENT));
  }
  const bytes = Kind.BYTES_PER_ELEMENT;
  const out = new Kind(length);
  const read = Kind === Float32Array ? 'getFloat32' : Kind === Float64Array ? 'getFloat64' : 'getUint32';
  for (let k = 0; k < length; k += 1) out[k] = view[read](offset + k * bytes, true);
  return out;
}

/**
 * Wrap a headerless little-endian float32 payload (`*.f32`) as a typed array,
 * endian-safe like the decoders below.
 */
export function float32Payload(buffer) {
  return typedArray(new DataView(buffer), 0, buffer.byteLength / 4, Float32Array);
}

/** Wrap a headerless little-endian float64 payload (`*.f64`) as a typed array. */
export function float64Payload(buffer) {
  return typedArray(new DataView(buffer), 0, buffer.byteLength / 8, Float64Array);
}

/**
 * Decode `cases/<key>/frames.bin.gz` ('CRFB').
 *
 * Returns `{ version, rows, cols, steps, processed, scalars }` where
 * `processed` is a float32 `(steps, rows, cols)` C-order block and `scalars` is
 * a float64 `(steps, 5)` block: projectedCio, positiveSum, negativeSum, net,
 * closureError — the same five numbers `chain.chain_projection_preview`
 * reports per day (computed in float64 by the bake, so they are exact).
 */
export function decodeFrameBundle(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16 || magicOf(view, 0) !== 'CRFB') {
    throw new Error('Not a baked projection frame bundle');
  }
  const version = view.getUint16(4, true);
  const rows = view.getUint16(6, true);
  const cols = view.getUint16(8, true);
  const steps = view.getUint16(10, true);
  const expected = 16 + steps * rows * cols * 4 + steps * 5 * 8;
  if (version !== 1 || buffer.byteLength !== expected) {
    throw new Error(`Corrupt frame bundle (version ${version}, ${buffer.byteLength} bytes, expected ${expected})`);
  }
  const processed = typedArray(view, 16, steps * rows * cols, Float32Array);
  const scalars = typedArray(view, 16 + steps * rows * cols * 4, steps * 5, Float64Array);
  return { version, rows, cols, steps, processed, scalars };
}

/**
 * Decode `input/<year>.f32.gz` ('CRIB'): the U850 input pool of one target
 * year, one float32 grid per calendar day, shared by every case whose window
 * uses that day (the bake script asserts the fields are byte-identical across
 * cases before pooling them).
 */
export function decodeInputPool(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16 || magicOf(view, 0) !== 'CRIB') {
    throw new Error('Not a baked U850 input pool');
  }
  const version = view.getUint16(4, true);
  const rows = view.getUint16(6, true);
  const cols = view.getUint16(8, true);
  const days = view.getUint16(10, true);
  const expected = 16 + days * 4 + days * rows * cols * 4;
  if (version !== 1 || buffer.byteLength !== expected) {
    throw new Error(`Corrupt input pool (version ${version}, ${buffer.byteLength} bytes, expected ${expected})`);
  }
  const dateKeys = typedArray(view, 16, days, Uint32Array);
  const fields = typedArray(view, 16 + days * 4, days * rows * cols, Float32Array);
  return { version, rows, cols, days, dateKeys, fields };
}

/** One day's grid out of a decoded frame bundle, as `rows x cols` numbers. */
export function frameGridFromBundle(bundle, timeIndex, rows = bundle.rows, cols = bundle.cols) {
  const { processed, steps } = bundle;
  if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= steps) {
    throw new Error(`time_index ${timeIndex} is outside the ${steps}-day window`);
  }
  const stride = rows * cols;
  const start = timeIndex * stride;
  const grid = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const line = new Array(cols);
    for (let col = 0; col < cols; col += 1) {
      line[col] = processed[start + row * cols + col];
    }
    grid[row] = line;
  }
  return grid;
}

/** One day's grid out of a decoded input pool, as `rows x cols` numbers. */
export function frameGridFromPool(pool, dayIndex, rows = pool.rows, cols = pool.cols) {
  const stride = rows * cols;
  const start = dayIndex * stride;
  const grid = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const line = new Array(cols);
    for (let col = 0; col < cols; col += 1) {
      line[col] = pool.fields[start + row * cols + col];
    }
    grid[row] = line;
  }
  return grid;
}

/**
 * `'2003-05-27'` → index into a decoded pool's day axis, or -1.
 * The pool keys are integers: YYYYMMDD.
 */
export function findPoolDate(pool, dateString) {
  const key = Number(String(dateString).replace(/-/g, ''));
  for (let index = 0; index < pool.dateKeys.length; index += 1) {
    if (pool.dateKeys[index] === key) return index;
  }
  return -1;
}

/**
 * Mirror of `contribution = processed * weights` from
 * `chain._validate_projection_preview` (float64 product of the float32
 * processed value and the float64 projection weight — the same arithmetic the
 * bake parity check replays).
 */
export function multiplyGrid(grid, weights) {
  const rows = grid.length;
  const cols = grid[0].length;
  const out = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const line = new Array(cols);
    for (let col = 0; col < cols; col += 1) {
      line[col] = grid[row][col] * weights[row * cols + col];
    }
    out[row] = line;
  }
  return out;
}

/** Largest value of a decoded grid (used for `windowContribution.scaleMax`). */
export function gridMaximum(grid) {
  let maximum = -Infinity;
  for (const line of grid) {
    for (const value of line) {
      if (value > maximum) maximum = value;
    }
  }
  return maximum;
}

// ── asset locations ────────────────────────────────────────────────────────

/** Manifest paths hosted outside the site carry this prefix. */
export const REMOTE_PREFIX = 'remote:';

/**
 * `remote:cases/...` → the external dataset host (e.g. Hugging Face),
 * anything else → a file shipped next to the site under `dataRoot`.
 */
export function resolveAssetUrl(manifest, path, dataRoot) {
  if (!path.startsWith(REMOTE_PREFIX)) return `${dataRoot}${path}`;
  const base = manifest.remoteBase;
  if (!base) {
    throw new Error('This demo dataset expects an external host but demo-data/manifest.json has no "remoteBase".');
  }
  return `${base.endsWith('/') ? base : `${base}/`}${path.slice(REMOTE_PREFIX.length)}`;
}

// ── projection frame assembly ──────────────────────────────────────────────

/**
 * Mirror of `chain.chain_projection_preview` for one day.
 *
 * The stage grids come from the binary payloads (float32, as written); the
 * per-day scalars are the float64 block the bake computed with the backend's
 * own formulas, so the summary panel does not depend on a JS re-summation
 * order.  The `contribution` stage is derived here as `processed * weights` —
 * the same float64 product the backend uses.
 */
export function buildProjectionFrame(index, bundle, weights, pool, timeIndex, lat, lon) {
  const { rows, cols, dates } = index;
  const date = dates[timeIndex];
  const position = findPoolDate(pool, date);
  if (position < 0) throw new Error(`The baked U850 pool for ${index.year} has no field for ${date}`);
  const processed = frameGridFromBundle(bundle, timeIndex, rows, cols);
  const contribution = multiplyGrid(processed, weights);
  const input = frameGridFromPool(pool, position, rows, cols);
  const scalar = offset => bundle.scalars[timeIndex * 5 + offset];
  const stage = (key, title, description, unit, data, scaleMax) => ({
    key,
    title,
    description,
    unit,
    scaleMax: Math.max(scaleMax, 1e-12),
    data,
    lat,
    lon,
  });
  return {
    timeIndex,
    totalSteps: index.steps,
    date,
    dates: [...dates],
    targetYear: index.targetYear,
    window: index.window,
    calendarKnown: index.calendarKnown,
    projectedCio: scalar(0),
    contributionSum: scalar(3),
    selectedContribution: {
      positiveSum: scalar(1),
      negativeSum: scalar(2),
      net: scalar(3),
      projectedCio: scalar(0),
      closureError: scalar(4),
    },
    windowContribution: {
      averageAbs: index.averageAbs,
      dates: [...dates],
      rows: index.averageAbs.length,
      cols: index.averageAbs[0].length,
      scaleMin: 0,
      scaleMax: Math.max(gridMaximum(index.averageAbs), 1e-12),
      unit: 'CIO 贡献',
      lat,
      lon,
    },
    stages: [
      stage(
        'input', '目标年真实 U850 场',
        '裁剪并插值到 1° 网格的目标年真实 U850 场，尚未执行训练预处理',
        'm/s', input, index.scaleMax.input,
      ),
      stage(
        'processed', '训练口径中间量（不是 U850 原始场）',
        '不是 U850 原始场：日序平均 = 把各年同一日序的场平均得到的当日气候态；'
        + '本图 = 原始 U850 场 − 日序平均 − 历史纬向高通项，再按训练常数标准化',
        '标准化值', processed, index.scaleMax.processed,
      ),
      stage(
        'contribution', '格点投影贡献',
        '等于上面的预处理中间量乘按官方历史排列还原的实际计算权重；'
        + '沿格点求和得到 CIO。模态文件中的空间参考图与此处计算权重的网格排列不同',
        'CIO 贡献', contribution, index.scaleMax.contribution,
      ),
    ],
  };
}
