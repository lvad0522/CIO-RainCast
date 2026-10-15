/**
 * Static demo mode — serves the whole UI from pre-baked files on GitHub Pages.
 *
 * When the bundle is built with `VITE_STATIC_MODE=1` this module patches
 * `window.fetch` so every same-origin `/api/*` request is answered from the
 * baked demo dataset (see `scripts/bake_demo_data.py`) instead of a backend.
 * In a normal build/dev run the module exports its helpers but never touches
 * `window.fetch`, so nothing changes for the two live sites.
 *
 * The dataset has two layers:
 *
 * - **Repository layer** (`demo-data/`, committed next to the site): the small
 *   JSON payloads baked verbatim, the shared CIO files and the CSV exports.
 * - **External layer** (a dataset host such as Hugging Face, referenced by
 *   `manifest.remoteBase`): the heavy binary payloads.  Manifest paths carrying
 *   the `remote:` prefix resolve against that base, everything else against
 *   `demo-data/`.  Every case in the manifest ships its full heavy layer.
 *
 * Two response families:
 *
 * 1. **Baked verbatim** — every backend response captured byte-for-byte by the
 *    bake script (`run`, `default-cio`, CIO series/completeness/spectrum,
 *    model comparisons, focus-region cards, the daily projection constants).
 * 2. **Rebuilt in the browser** — the responses that are far too large to ship
 *    per date and per grid point (`/api/grid`, dataset daily frames, and the
 *    projection frames themselves, which are assembled from a per-case binary
 *    bundle plus a shared per-year U850 pool) are recomputed here from the
 *    baked raw float32 arrays.  The formulas live in `utils/staticRebuild.js`
 *    and mirror `real_data.gen_time_series` / `dataset_evaluation.frame` /
 *    `chain.chain_projection_preview` under `DISPLAY_MODE=fold1` exactly; the
 *    bake script re-checks them field by field and `test/staticData.test.js`
 *    replays the same fixtures, so a drift fails CI instead of silently
 *    changing the numbers on the site.
 *
 * Calibration rules this module must not break: `r` is read from the pearson
 * product, never recomputed from the series; nothing here may re-derive a
 * fold maximum or a different display mode.  The five per-day projection
 * scalars are read straight from the float64 block the bake wrote with the
 * backend's own formulas — they are *not* re-summed in JS.
 */

import {
  buildFieldFrame,
  buildGridResponse,
  buildProjectionFrame,
  decodeFrameBundle,
  decodeInputPool,
  float32Payload,
  float64Payload,
  resolveAssetUrl,
} from './utils/staticRebuild.js';

export { buildFieldFrame, buildGridResponse, rainfallColorLimit } from './utils/staticRebuild.js';

// `import.meta.env` is replaced by Vite at build time; the fallback keeps the
// module importable from plain Node so the shim can be driven without a
// browser (it is the only Vite-ism in this file — keep the fallback).
const ENV = import.meta.env || {};
// Static mode is normally fixed at build time; `setStaticMode` below lets a
// Node harness exercise the static branches without a Vite build.  Nothing in
// the shipped bundle calls it.
let staticMode = ENV.VITE_STATIC_MODE === '1';
// `base: './'` keeps the site working under the GitHub Pages project subpath.
const DATA_ROOT = `${ENV.BASE_URL || '/'}demo-data/`;
const NOT_INCLUDED = 'This (year, lead) case is not part of the static demo dataset; only the selected example cases include daily fields and grid-point series.';
const NO_PREVIEW = 'The daily CIO projection preview is only baked for a few example cases in this static demo; the rest of this case is complete.';
const NOT_AVAILABLE = 'This endpoint is not part of the static demo dataset.';

const originalFetch = typeof window === 'undefined' ? null : window.fetch.bind(window);

let manifestPromise = null;

/** True when this bundle was built for the static demo site. */
export function isStaticMode() {
  return staticMode;
}

/** Used only by Node harnesses; see the note above `staticMode`. */
export function setStaticMode(enabled) {
  staticMode = Boolean(enabled);
}

/**
 * Manifest entry for one case (or null outside static mode / unknown case).
 * Every baked case carries `{ full: true }`: daily frames + raw arrays exist.
 */
export async function staticCaseInfo(year, lead) {
  if (!staticMode) return null;
  const manifest = await loadManifest();
  return manifest.cases[caseKey(year, lead)] || null;
}

/** Case keys that carry the full layer (daily frames + raw arrays). */
export async function staticFullCases() {
  if (!staticMode) return [];
  const manifest = await loadManifest();
  return Object.entries(manifest.cases)
    .filter(([, entry]) => entry.full)
    .map(([key]) => key);
}

/**
 * Rewrites a backend URL to the matching baked asset (used by `<a href>` /
 * `download` anchors, which bypass `fetch`).  Returns null when the asset is
 * not part of the bake.
 */
export async function staticAssetUrl(url) {
  if (!staticMode) return url;
  const parsed = new URL(url, window.location.href);
  const match = /^\/api\/dataset\/(\d{4})\/(\d{1,2})\/\d+\/download\/focus-region$/.exec(parsed.pathname);
  if (!match) return null;
  const entry = await staticCaseInfo(Number(match[1]), `pre${Number(match[2])}`);
  return entry ? `${DATA_ROOT}${entry.files.datasetFocusCsv}` : null;
}

export async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = originalFetch(`${DATA_ROOT}manifest.json`).then(response => {
      if (!response.ok) throw new Error(`Static demo manifest is missing (${response.status})`);
      return response.json();
    });
  }
  return manifestPromise;
}

// ── asset loading ──────────────────────────────────────────────────────────

function caseKey(year, lead) {
  return `${Number(year)}-${String(lead).startsWith('pre') ? lead : `pre${Number(lead)}`}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function missing(detail) {
  return jsonResponse({ detail }, 404);
}

/** `remote:cases/...` → the dataset host; anything else → this site. */
function assetUrl(manifest, path) {
  return resolveAssetUrl(manifest, path, DATA_ROOT);
}

function unreachable(url, reason) {
  return new Error(
    `Cannot reach the static demo dataset host (${reason?.message || 'network error'}): ${url}`
    + ' — the heavy demo files live outside the site; check the connection, or fix "remoteBase" in demo-data/manifest.json.',
  );
}

/**
 * Open a baked asset, transparently un-gzipping `*.gz` names.
 * Returns null when the host answered but the file is not there (404), and
 * throws a readable error when the host itself is unreachable.
 */
async function openAsset(manifest, path) {
  const url = assetUrl(manifest, path);
  let response;
  try {
    response = await originalFetch(url);
  } catch (reason) {
    throw unreachable(url, reason);
  }
  if (!response.ok) return null;
  if (!path.endsWith('.gz')) return response;
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
}

async function readBakedFile(manifest, path, contentType) {
  const response = await openAsset(manifest, path);
  if (!response) return missing(`Baked demo file is missing: ${path}`);
  return contentType
    ? new Response(response.body, { headers: { 'Content-Type': contentType } })
    : response;
}

async function readBinary(manifest, path) {
  const response = await openAsset(manifest, path);
  if (!response) throw new Error(`Baked demo file is missing: ${path}`);
  return response.arrayBuffer();
}

async function readJson(manifest, path) {
  const response = await openAsset(manifest, path);
  if (!response) throw new Error(`Baked demo file is missing: ${path}`);
  return response.json();
}

// Caches: the UI revisits one case at a time, so a single slot per family is
// enough.  Keeping only the newest entry bounds memory (one case's arrays are
// ~80 MB decoded) while still serving the per-frame and per-grid-point bursts.
let arraysSlot = null;
let projectionSlot = null;
let weightsPromise = null;
const POOL_CACHE_LIMIT = 3;
const poolCache = new Map();

function cached(slot, key, load) {
  if (slot.value?.key === key) return slot.value.promise;
  const promise = load().catch(reason => {
    // Do not cache a transient failure: the next request retries.
    if (slot.value?.promise === promise) slot.value = null;
    throw reason;
  });
  slot.value = { key, promise };
  return promise;
}

/** The three raw arrays of one case (predict2 / real2 / pearsonR), float32. */
function loadArrays(manifest, caseId, entry) {
  if (!entry.arrays) throw new Error(NOT_INCLUDED);
  return cached(arraysSlot = arraysSlot || {}, caseId, async () => {
    const [predict2, real2, pearsonR] = await Promise.all([
      readBinary(manifest, entry.arrays.predict2).then(float32Payload),
      readBinary(manifest, entry.arrays.real2).then(float32Payload),
      readBinary(manifest, entry.arrays.pearsonR).then(float32Payload),
    ]);
    return { predict2, real2, pearsonR, rows: entry.rows, cols: entry.cols, steps: entry.steps };
  });
}

/** The CIO projection weights — a float64 grid shared by every case. */
function loadWeights(manifest) {
  if (!weightsPromise) {
    weightsPromise = readBinary(manifest, manifest.shared.weights)
      .then(float64Payload)
      .catch(reason => {
        weightsPromise = null;
        throw reason;
      });
  }
  return weightsPromise;
}

/** The per-case projection payload: frame constants + binary bundle + weights. */
function loadProjection(manifest, caseId, entry, indexDoc) {
  return cached(projectionSlot = projectionSlot || {}, caseId, async () => {
    const [index, bundleBuffer, weights] = await Promise.all([
      indexDoc || readJson(manifest, entry.frames.index),
      readBinary(manifest, entry.frames.bundle),
      loadWeights(manifest),
    ]);
    return { index, bundle: decodeFrameBundle(bundleBuffer), weights };
  });
}

/** The U850 input pool of a case's target year (shared by every lead). */
function loadInputPool(manifest, entry) {
  const year = entry.year;
  if (!poolCache.has(year)) {
    if (poolCache.size >= POOL_CACHE_LIMIT) poolCache.delete(poolCache.keys().next().value);
    const promise = readBinary(manifest, entry.input)
      .then(decodeInputPool)
      .catch(reason => {
        poolCache.delete(year);
        throw reason;
      });
    poolCache.set(year, promise);
  }
  return poolCache.get(year);
}

// ── fetch shim ─────────────────────────────────────────────────────────────

function caseOfJob(manifest, jobId) {
  return Object.entries(manifest.cases).find(([, entry]) => entry.jobId === jobId) || null;
}

/**
 * Resolves one `/api/*` request to a `Response` (or null to pass through).
 * Exported so a harness can drive every endpoint the interface calls without a
 * browser.
 */
export async function resolveApi(parsed) {
  const path = parsed.pathname;
  const query = parsed.searchParams;
  const manifest = await loadManifest();

  if (path === '/api/cio/capabilities') return readBakedFile(manifest, manifest.shared.capabilities);
  if (path === '/api/cio/reference') return readBakedFile(manifest, manifest.shared.reference);
  if (path === '/api/cio/mode/u850') return readBakedFile(manifest, manifest.shared.mode);

  if (path === '/api/run' || path === '/api/default-cio') {
    const entry = manifest.cases[caseKey(query.get('year'), query.get('lead'))];
    if (!entry) return missing(NOT_INCLUDED);
    return readBakedFile(manifest, entry.files[path === '/api/run' ? 'run' : 'default-cio']);
  }

  if (path === '/api/grid') {
    const id = caseKey(query.get('year'), query.get('lead'));
    const entry = manifest.cases[id];
    if (!entry) return missing(NOT_INCLUDED);
    const arrays = await loadArrays(manifest, id, entry);
    return jsonResponse(buildGridResponse(
      arrays, Number(query.get('i')), Number(query.get('j')),
    ));
  }

  if (path === '/api/regional-model-series') {
    const year = Number(query.get('year') ?? 2018);
    const pre = Number(String(query.get('lead') ?? 5).replace(/^pre/, ''));
    const region = query.get('region') ?? 'focus';
    if (!Number.isInteger(year) || year < 2000 || year > 2019
      || !Number.isInteger(pre) || pre < 1 || pre > 20 || !['focus', 'eastasia'].includes(region)) {
      return jsonResponse({ detail: 'Invalid year, input-window configuration, or region.' }, 422);
    }
    return readBakedFile(manifest, `regional-model-series/${year}-pre${pre}_${region}.json`);
  }

  if (path === '/api/model-comparison') {
    const entry = manifest.cases[caseKey(query.get('year'), query.get('lead'))];
    const variant = entry?.files.comparison?.[query.get('region')]?.[query.get('scope')];
    return variant ? readBakedFile(manifest, variant) : missing(NOT_INCLUDED);
  }

  const chain = /^\/api\/chain\/jobs\/([^/]+)\/(series|completeness|spectrum|projection-preview)$/.exec(path);
  if (chain) {
    const found = caseOfJob(manifest, decodeURIComponent(chain[1]));
    if (!found) return missing(NOT_INCLUDED);
    const [id, entry] = found;
    const [, , endpoint] = chain;
    if (endpoint !== 'projection-preview') return readBakedFile(manifest, entry.files[endpoint]);
    if (!entry.frames) return missing(NO_PREVIEW);
    const timeIndex = Number(query.get('time_index') || 0);
    if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= entry.frameCount) {
      return jsonResponse({ detail: `time_index 必须小于 ${entry.frameCount}` }, 422);
    }
    const { index, bundle, weights } = await loadProjection(manifest, id, entry);
    const pool = await loadInputPool(manifest, entry);
    return jsonResponse(buildProjectionFrame(
      index, bundle, weights, pool, timeIndex,
      manifest.projection.lat, manifest.projection.lon,
    ));
  }
  if (path.startsWith('/api/chain/jobs/')) return missing(NOT_AVAILABLE);

  const dataset = /^\/api\/dataset\/(\d{4})\/(\d{1,2})\/(\d+)\/(.+)$/.exec(path);
  if (dataset) {
    const [, year, lead, fold, rest] = dataset;
    const id = caseKey(Number(year), `pre${Number(lead)}`);
    const entry = manifest.cases[id];
    if (!entry || Number(fold) !== entry.fold) return missing(NOT_INCLUDED);
    if (rest === 'focus-region') return readBakedFile(manifest, entry.files.datasetFocus);
    if (rest === 'download/focus-region') return readBakedFile(manifest, entry.files.datasetFocusCsv, 'text/csv');
    const frame = /^(truth\/)?preview$/.exec(rest);
    if (frame) {
      const arrays = await loadArrays(manifest, id, entry);
      const which = frame[1] ? 'truth' : 'prediction';
      try {
        return jsonResponse(buildFieldFrame(arrays, which, Number(query.get('time_index') || 0)));
      } catch (reason) {
        return jsonResponse({ detail: reason.message }, 422);
      }
    }
    return missing(NOT_AVAILABLE);
  }

  return missing(NOT_AVAILABLE);
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function patchFetch() {
  window.fetch = async (input, init) => {
    const requestUrl = typeof input === 'string' ? input : input?.url;
    if (!requestUrl) return originalFetch(input, init);
    let parsed;
    try {
      parsed = new URL(requestUrl, window.location.href);
    } catch {
      return originalFetch(input, init);
    }
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/')) {
      return originalFetch(input, init);
    }
    // Keep the abort contract: callers' catch blocks branch on
    // `reason.name === 'AbortError'` to ignore cancelled requests.
    const signal = init?.signal || (typeof input === 'object' ? input.signal : null);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      resolveApi(parsed).then(resolve, reject);
    });
  };
}

if (staticMode && originalFetch) {
  patchFetch();
}
