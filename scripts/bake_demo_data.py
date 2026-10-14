#!/usr/bin/env python3
"""Bake the static demo dataset consumed by the GitHub Pages build.

The published site is a pure static bundle: no backend, no model weights, no
torch.  This script replays every request the mounted UI makes against the
**real** FastAPI app through ``TestClient`` (in-process, no server, no port)
and writes two destinations:

* **repository layer** — ``<frontend>/public/demo-data/``: the small per-case
  JSON (run summary, CIO series/completeness/spectrum, model comparison,
  focus-region cards + CSV) plus the shared CIO reference.  Committed to the
  demo repository: the site must load with no backend and no external host.
  The landing case (``--inline-cases``, default ``2000-pre20``) additionally
  keeps its heavy payload here — including the projection weights every daily
  frame needs — so the page a visitor opens first is complete even when the
  dataset host is unreachable.
* **remote layer** — ``--remote-out`` (default ``tmp/demo-data-remote/``):
  every heavy payload, meant for a public dataset host (Hugging Face).  The
  manifest records those paths with a ``remote:`` prefix and the site resolves
  them against ``manifest.remoteBase``.  Layout::

      cases/<key>/arrays/predict2.f32.gz    (81x101x112 float32, verbatim)
      cases/<key>/arrays/pearson_r.f32.gz   (81x101 float32, fold 1)
      cases/<key>/frames.bin.gz             (binary projection frames, below)
      cases/<key>/frame-index.json.gz       (per-case frame constants)
      years/<year>/real2.f32.gz             (81x101x112 float32; one per year,
                                             identical across the 20 leads —
                                             asserted, not assumed)
      input/<year>.f32.gz                   U850 input pool: one float32 grid per
                                             calendar day of that year, shared by
                                             every case whose window uses the day
      shared/weights.f64.gz                 (41x81 float64 projection weights,
                                             identical across all 400 cases)

Coverage: all 400 (year x lead) combinations are complete — every case ships
the arrays, its 112 daily projection frames and its input pool.

Binary formats
--------------
``frames.bin.gz`` (gzipped)::

    header 16 B : 'CRFB' | u16 version=1 | u16 rows | u16 cols | u16 steps | u32 reserved
    processed   : float32 little-endian, (steps, rows, cols), C order
    scalars     : float64 little-endian, (steps, 5), C order:
                  projectedCio, positiveSum, negativeSum, net, closureError

The ``contribution`` stage is *derived* in the browser (``processed * weights``
in float64) exactly the way ``chain._validate_projection_preview`` derives it.

``input/<year>.f32.gz`` (gzipped)::

    header 16 B : 'CRIB' | u16 version=1 | u16 rows | u16 cols | u16 days | u32 reserved
    dates       : uint32 little-endian, (days,), value YYYYMMDD
    fields      : float32 little-endian, (days, rows, cols), C order

Calibration discipline (do not "fix" these):

* ``DISPLAY_MODE`` is pinned to ``fold1`` — the outward-facing calibration.
* ``DATA_FAMILY``/``DATA_ROOT`` are pinned to the ASTGRN tree so the baked
  ``model`` field can never be mislabelled.
* ``r`` values come from the pearson product itself (``pearson2[..., 2]`` on
  fold 1), never recomputed from the predict/real series.
* The U850 input field is pooled per calendar day only after asserting
  byte-identical float32 values across every case sharing that date; a mismatch
  aborts the bake before anything is written.
* Projection frames are float32 by default (float32 keeps ~7 significant
  digits; the color map cannot resolve the difference).  ``--frame-precision
  f64`` stores the untouched float64 grids instead (~2x the remote size).

Usage::

    python scripts/bake_demo_data.py                    # everything
    python scripts/bake_demo_data.py --reuse-light      # reuse the baked light layer
    python scripts/bake_demo_data.py --heavy-only --reuse-light
    python scripts/bake_demo_data.py --limit 2          # smoke test
    python scripts/bake_demo_data.py --light-only       # repository layer only
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import random
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = next(
    (path for path in (ROOT / "frontend", ROOT / "网站前端框架") if path.is_dir()),
    ROOT / "frontend",
)
DEFAULT_OUT = FRONTEND / "public" / "demo-data"
DEFAULT_REMOTE_OUT = ROOT / "tmp" / "demo-data-remote"
# Baked into the manifest; edit here (or pass --remote-base) when the dataset
# repository lives under another account.
DEFAULT_REMOTE_BASE = (
    "https://huggingface.co/datasets/Anthony1919826/CIO-RainCast-demo-data/resolve/main/"
)
ALL_YEARS = tuple(range(2000, 2020))
ALL_LEADS = tuple(range(1, 21))
GZ_THRESHOLD = 20 * 1024  # larger responses are stored gzip-compressed
ARRAY_SHAPE = (81, 101, 112)      # dataset rainfall grids (lat, lon, steps)
PROJ_SHAPE = (41, 81, 112)        # projection preview grids (lat, lon, steps)
PROJ_STEPS = 112
REMOTE_PREFIX = "remote:"
# Cases whose heavy payload is copied into the repository layer instead of the
# dataset host (the landing page must survive an unreachable external host).
# ~10 MB for the default case, shared weights included; pass `--inline-cases ""`
# to disable.
DEFAULT_INLINE_CASES = ("2000-pre20",)
# Legacy heavy paths from the first bake; removed from the repository layer
# once the payloads live on the remote host.
LEGACY_REPO_DIRS = ("cases/{case}/arrays", "cases/{case}/frames")

# Cases whose written remote payload is re-read and compared field-by-field
# against live API responses (the browser rebuild path, end to end).
DEFAULT_PARITY_CASES = (
    "2000-pre20",  # 网站默认组合
    "2000-pre1",
    "2003-pre3",
    "2009-pre2",
    "2015-pre1",
    "2019-pre20",
)

# Filled in by main() once the backend package is importable.
real_data_mod = None  # type: ignore[assignment]


# ── environment / imports ───────────────────────────────────────────────────


def configure_env() -> None:
    """Pin every calibration-relevant knob *before* importing the backend."""
    os.environ["MODEL_PREWARM"] = "0"  # no external weight scan, no torch
    os.environ["DISPLAY_MODE"] = "fold1"  # outward-facing calibration
    os.environ["DATA_FAMILY"] = "ASTGRN"
    os.environ.setdefault("DATA_ROOT", str(ROOT / "Dataset-AGCRN"))
    os.environ.setdefault("CHAIN_JOB_ROOT", str(BACKEND / "uploads" / "chain_jobs"))
    os.environ.setdefault("CIOPROJ_MAT", str(BACKEND / "assets" / "CIOmode_1982_2017.mat"))


def import_backend():
    sys.path.insert(0, str(BACKEND))
    import main  # noqa: E402  (import after configure_env on purpose)
    import real_data  # noqa: E402

    return main, real_data


# ── writing helpers ─────────────────────────────────────────────────────────


class Writer:
    def __init__(self, out_dir: Path, prefix: str = ""):
        self.out_dir = out_dir
        self.prefix = prefix
        self.entries: list[tuple[str, int, int]] = []  # (relpath, raw, stored)
        self.cases: dict[str, dict] = {}               # case key -> manifest entry

    def write_bytes(self, relpath: str, data: bytes, *, force_gz: bool = False) -> str:
        """Store raw bytes; gzip when it pays off.  Returns the manifest path."""
        path = self.out_dir / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        if force_gz or len(data) >= GZ_THRESHOLD:
            relpath += ".gz"
            path = self.out_dir / relpath
            stored = gzip.compress(data, compresslevel=6, mtime=0)
        else:
            stored = data
        path.write_bytes(stored)
        self.entries.append((relpath, len(data), len(stored)))
        return self.prefix + relpath

    def path_of(self, relpath: str) -> str:
        """Record that this path is expected to exist (written elsewhere)."""
        return self.prefix + relpath


def read_maybe_gz(path: Path) -> bytes:
    blob = path.read_bytes()
    return gzip.decompress(blob) if path.suffix == ".gz" else blob


def read_json(path: Path) -> dict:
    return json.loads(read_maybe_gz(path))


# ── binary frame / pool formats ─────────────────────────────────────────────


def encode_frame_bundle(processed_f32, scalars_f64, rows: int, cols: int, steps: int) -> bytes:
    import numpy as np

    assert processed_f32.dtype == np.float32 and processed_f32.shape == (steps, rows, cols)
    assert scalars_f64.dtype == np.float64 and scalars_f64.shape == (steps, 5)
    header = struct.pack("<4sHHHHI", b"CRFB", 1, rows, cols, steps, 0)
    return header + processed_f32.tobytes() + scalars_f64.tobytes()


def decode_frame_bundle(blob: bytes):
    """Read back what encode_frame_bundle wrote (also the parity-check reader)."""
    import numpy as np

    if len(blob) < 16 or blob[:4] != b"CRFB":
        raise SystemExit("[format] frame bundle magic mismatch")
    _magic, version, rows, cols, steps, _ = struct.unpack("<4sHHHHI", blob[:16])
    if version != 1:
        raise SystemExit(f"[format] frame bundle version {version}")
    expected = 16 + steps * rows * cols * 4 + steps * 5 * 8
    if len(blob) != expected:
        raise SystemExit(f"[format] frame bundle length {len(blob)} != {expected}")
    processed = np.frombuffer(blob, dtype="<f4", count=steps * rows * cols, offset=16)
    scalars = np.frombuffer(blob, dtype="<f8", count=steps * 5,
                            offset=16 + steps * rows * cols * 4)
    return processed.reshape(steps, rows, cols), scalars.reshape(steps, 5)


def encode_input_pool(date_keys, fields_f32, rows: int, cols: int) -> bytes:
    import numpy as np

    days = len(date_keys)
    assert fields_f32.dtype == np.float32 and fields_f32.shape == (days, rows, cols)
    header = struct.pack("<4sHHHHI", b"CRIB", 1, rows, cols, days, 0)
    keys = np.asarray(date_keys, dtype="<u4").tobytes()
    return header + keys + fields_f32.tobytes()


def decode_input_pool(blob: bytes):
    import numpy as np

    if len(blob) < 16 or blob[:4] != b"CRIB":
        raise SystemExit("[format] input pool magic mismatch")
    _magic, version, rows, cols, days, _ = struct.unpack("<4sHHHHI", blob[:16])
    if version != 1:
        raise SystemExit(f"[format] input pool version {version}")
    expected = 16 + days * 4 + days * rows * cols * 4
    if len(blob) != expected:
        raise SystemExit(f"[format] input pool length {len(blob)} != {expected}")
    keys = np.frombuffer(blob, dtype="<u4", count=days, offset=16)
    fields = np.frombuffer(blob, dtype="<f4", count=days * rows * cols, offset=16 + days * 4)
    return keys, fields.reshape(days, rows, cols)


# ── client-side rebuild formulas (kept in lockstep with src/staticRebuild.js) ──


def rebuild_grid(predict2, real2, pearson_r, i: int, j: int) -> dict:
    """Mirror of real_data.gen_time_series under DISPLAY_MODE=fold1."""
    return {
        "real": [float(v) for v in real2[i, j, :]],
        "pred": [float(v) for v in predict2[i, j, :]],
        "r": float(pearson_r[i, j]),
        "source": "dataset",
    }


def rainfall_color_limit(*fields) -> float:
    """Mirror of dataset_evaluation.rainfall_color_limit (window-wide max |v|)."""
    import numpy as np

    maximum = 0.0
    for values in fields:
        finite = values[np.isfinite(values)]
        if finite.size:
            maximum = max(maximum, float(np.max(np.abs(finite))))
    return max(maximum, 1e-6)


def rebuild_frame(values, index: int, scale_max: float) -> dict:
    """Mirror of dataset_evaluation.frame() for one array (prediction or truth)."""
    import numpy as np

    v = values[:, :, index]
    finite = v[np.isfinite(v)]
    if not finite.size:
        raise RuntimeError("baked array has no finite value at the sampled index")
    return {
        "timeIndex": index,
        "rows": 81,
        "cols": 101,
        "min": float(finite.min()),
        "max": float(finite.max()),
        "scaleMax": scale_max,
        "fieldScaleMax": rainfall_color_limit(values),
        "data": [[float(x) if np.isfinite(x) else None for x in row] for row in v],
    }


def _as_nested(values) -> list:
    return [[float(x) for x in row] for row in values]


def rebuild_projection_frame(index: dict, t: int, processed_t, scalars_t, weights, input_t,
                             lat, lon) -> dict:
    """Mirror of the browser-side frame assembly for the projection card.

    ``processed_t``/``input_t`` are the float32 grids read back from the remote
    bundles, widened to float64 exactly like ``Float32Array`` values are in JS;
    ``weights`` stays float64.  ``contribution`` is derived the same way.
    """
    import numpy as np

    contribution_t = processed_t * weights
    net = float(np.sum(contribution_t, dtype=np.float64))
    positive = float(np.sum(contribution_t[contribution_t > 0], dtype=np.float64))
    negative = float(np.sum(contribution_t[contribution_t < 0], dtype=np.float64))
    average_abs = np.asarray(index["averageAbs"], dtype=np.float64)

    def stage(key, title, description, unit, data, scale_max):
        return {
            "key": key, "title": title, "description": description, "unit": unit,
            "scaleMax": float(max(scale_max, 1e-12)),
            "data": _as_nested(data), "lat": lat, "lon": lon,
        }

    return {
        "timeIndex": t,
        "totalSteps": int(index["steps"]),
        "date": index["dates"][t],
        "dates": list(index["dates"]),
        "targetYear": index["targetYear"],
        "window": index["window"],
        "calendarKnown": index["calendarKnown"],
        "projectedCio": float(scalars_t[0]),
        "contributionSum": net,
        "selectedContribution": {
            "positiveSum": positive,
            "negativeSum": negative,
            "net": net,
            "projectedCio": float(scalars_t[0]),
            "closureError": float(scalars_t[4]),
        },
        "windowContribution": {
            "averageAbs": _as_nested(average_abs),
            "dates": list(index["dates"]),
            "rows": int(average_abs.shape[0]),
            "cols": int(average_abs.shape[1]),
            "scaleMin": 0.0,
            "scaleMax": float(max(float(np.max(average_abs)), 1e-12)),
            "unit": "CIO 贡献",
            "lat": lat,
            "lon": lon,
        },
        "stages": [
            stage("input", "目标年真实 U850 场",
                  "裁剪并插值到 1° 网格的目标年真实 U850 场，尚未执行训练预处理",
                  "m/s", input_t, index["scaleMax"]["input"]),
            stage("processed", "训练口径中间量（不是 U850 原始场）",
                  "不是 U850 原始场：日序平均 = 把各年同一日序的场平均得到的当日气候态；"
                  "本图 = 原始 U850 场 − 日序平均 − 历史纬向高通项，再按训练常数标准化",
                  "标准化值", processed_t, index["scaleMax"]["processed"]),
            stage("contribution", "格点投影贡献",
                  "等于上面的预处理中间量乘按官方历史排列还原的实际计算权重；"
                  "沿格点求和得到 CIO。模态文件中的空间参考图与此处计算权重的网格排列不同",
                  "CIO 贡献", contribution_t, index["scaleMax"]["contribution"]),
        ],
    }


def _close(a, b, tol: float) -> bool:
    return abs(float(a) - float(b)) <= tol * max(1.0, abs(float(b)))


def _compare(tree_api, tree_rebuilt, path: str, tol: float, errors: list) -> None:
    """Walk the rebuilt structure; every leaf must match the API leaf."""
    if isinstance(tree_rebuilt, list):
        if not isinstance(tree_api, list) or len(tree_api) != len(tree_rebuilt):
            errors.append(f"{path}: shape mismatch")
            return
        for k, (x, y) in enumerate(zip(tree_api, tree_rebuilt)):
            _compare(x, y, f"{path}[{k}]", tol, errors)
        return
    if isinstance(tree_rebuilt, dict):
        for key in set(tree_api) - set(tree_rebuilt):
            errors.append(f"{path}.{key}: 线上响应里的字段没有被重建覆盖")
        for key in tree_rebuilt:
            if key not in tree_api:
                errors.append(f"{path}.{key}: missing from API response")
                continue
            _compare(tree_api[key], tree_rebuilt[key], f"{path}.{key}", tol, errors)
        return
    if isinstance(tree_rebuilt, bool) or isinstance(tree_rebuilt, str) or tree_rebuilt is None:
        if tree_api != tree_rebuilt:
            errors.append(f"{path}: {tree_api!r} != {tree_rebuilt!r}")
        return
    if not _close(tree_api, tree_rebuilt, tol):
        errors.append(f"{path}: {tree_api!r} != {tree_rebuilt!r}")


def check_grid_parity(case, api_grid, predict2, real2, pearson_r, samples) -> None:
    import numpy as np

    for i, j in samples:
        expected = rebuild_grid(predict2, real2, pearson_r, i, j)
        for key in ("pred", "real"):
            got, want = api_grid[key], expected[key]
            if len(got) != len(want) or not all(_close(x, y, 1e-6) for x, y in zip(got, want)):
                raise SystemExit(f"[parity] {case} /api/grid i={i} j={j} field '{key}' mismatch")
        if not np.isnan(api_grid.get("r") or np.nan):  # r may legitimately be NaN
            if not _close(api_grid["r"], expected["r"], 1e-6):
                raise SystemExit(f"[parity] {case} /api/grid i={i} j={j} r mismatch")


def check_frame_parity(case, kind, api_frame, values, index, scale_max) -> None:
    expected = rebuild_frame(values, index, scale_max)
    for key in ("timeIndex", "rows", "cols"):
        if api_frame[key] != expected[key]:
            raise SystemExit(f"[parity] {case} {kind} frame t={index} key '{key}' mismatch")
    for key in ("min", "max", "scaleMax", "fieldScaleMax"):
        if not _close(api_frame[key], expected[key], 1e-6):
            raise SystemExit(
                f"[parity] {case} {kind} frame t={index} key '{key}' mismatch: "
                f"{api_frame[key]!r} != {expected[key]!r}"
            )
    for row_index, (got_row, want_row) in enumerate(zip(api_frame["data"], expected["data"])):
        for col_index, (got, want) in enumerate(zip(got_row, want_row)):
            if (got is None) != (want is None):
                raise SystemExit(f"[parity] {case} {kind} frame t={index} null mismatch at {row_index},{col_index}")
            if got is not None and not _close(got, want, 1e-6):
                raise SystemExit(f"[parity] {case} {kind} frame t={index} value mismatch at {row_index},{col_index}")


def check_projection_parity(case, api_frame, rebuilt, errors: list, tol: float) -> None:
    """Full-field comparison of one API projection frame against the rebuilt one."""
    _compare(api_frame, rebuilt, f"{case} t={api_frame.get('timeIndex')}", tol, errors)


# ── baking: repository (light) layer ────────────────────────────────────────


def fetch(client, path: str, params: dict | None = None) -> bytes:
    response = client.get(path, params=params)
    if response.status_code != 200:
        raise SystemExit(f"[fetch] GET {path} {params} -> {response.status_code}: {response.text[:300]}")
    return response.content


def ensure_job(client, case: str) -> str:
    """Register a precomputed chain job and return its id.

    ``/api/default-cio`` is the call that puts the job into ``chain._jobs``;
    every job-scoped endpoint 404s until it has been requested once.  The light
    layer does this while baking, so ``--reuse-light`` / ``--heavy-only`` runs
    (which skip that loop) must ask again before any parity or fixture request.
    """
    year, lead = case.split("-pre")
    fetch(client, "/api/default-cio", {"year": int(year), "lead": f"pre{lead}"})
    return f"default-{case}"


def bake_shared(client, writer: Writer) -> dict:
    files = {}
    for key, path in (
        ("capabilities", "/api/cio/capabilities"),
        ("reference", "/api/cio/reference"),
        ("mode", "/api/cio/mode/u850"),
    ):
        data = fetch(client, path)
        files[key] = writer.write_bytes(f"shared/cio_{key}.json", data)
    return files


def bake_case_light(client, writer: Writer, year: int, lead: int) -> dict:
    """Bake the repository (light) layer of one case; returns its manifest entry."""
    case = f"{year}-pre{lead}"
    case_dir = f"cases/{case}"
    params = {"year": year, "lead": f"pre{lead}"}

    # 1. /api/run — also yields the fold the site displays for this case.
    run_bytes = fetch(client, "/api/run", {**params, "region": "eastasia"})
    run = json.loads(run_bytes)
    fold = (run.get("table") or [{}])[0].get("experiment")
    if not isinstance(fold, int):
        raise SystemExit(f"[bake] {case}: /api/run returned no displayable fold")
    files = {"run": writer.write_bytes(f"{case_dir}/run.json", run_bytes)}

    # 2. /api/default-cio registers the precomputed job in chain._jobs; every
    #    /api/chain/jobs/{id}/* request 404s until it has been called once.
    files["default-cio"] = writer.write_bytes(
        f"{case_dir}/default-cio.json", fetch(client, "/api/default-cio", params)
    )
    job_id = f"default-{year}-pre{lead}"

    # 3. CIO projection chain (系列 / 完整性 / 谱).
    for key, suffix in (
        ("series", "series"),
        ("completeness", "completeness"),
        ("spectrum", "spectrum"),
    ):
        data = fetch(client, f"/api/chain/jobs/{job_id}/{suffix}")
        files[key] = writer.write_bytes(f"{case_dir}/chain_{key}.json", data)

    # 4. Paired model comparison — four variants the UI can select.
    comparison = {}
    for region in ("focus", "eastasia"):
        comparison[region] = {}
        for scope in ("year", "all"):
            data = fetch(
                client, "/api/model-comparison",
                {"year": year, "lead": lead, "region": region, "scope": scope},
            )
            comparison[region][scope] = writer.write_bytes(
                f"{case_dir}/comparison_{region}_{scope}.json", data
            )
    files["comparison"] = comparison

    # 5. Dataset focus-region card + CSV download.
    focus_bytes = fetch(client, f"/api/dataset/{year}/{lead}/{fold}/focus-region")
    files["datasetFocus"] = writer.write_bytes(f"{case_dir}/dataset_focus_region.json", focus_bytes)
    csv_bytes = fetch(client, f"/api/dataset/{year}/{lead}/{fold}/download/focus-region")
    files["datasetFocusCsv"] = writer.write_bytes(f"{case_dir}/dataset_focus_region.csv", csv_bytes)

    return {
        "year": year,
        "lead": lead,
        "fold": fold,
        # The light layer alone has no daily fields; `bake_heavy` flips this on
        # for every case it writes, which is what the frontend trusts.
        "full": False,
        "jobId": job_id,
        "rows": ARRAY_SHAPE[0],
        "cols": ARRAY_SHAPE[1],
        "steps": ARRAY_SHAPE[2],
        "files": files,
    }


# ── baking: remote (heavy) layer ────────────────────────────────────────────


def scan_projection_sources(cases) -> tuple[dict, "object"]:
    """Verify the pooling assumptions over every case *before* writing a byte.

    Returns ``(pool, weights)``: ``pool`` maps YYYYMMDD -> float32 field bytes
    (one grid per calendar day, asserted identical across cases), ``weights``
    is the float64 41x81 projection weight field (asserted identical across
    cases).  Any mismatch aborts the bake here.
    """
    import numpy as np
    import chain

    npz_root = Path(chain.JOB_ROOT)
    pool: dict[int, bytes] = {}
    weights_ref = None
    weights_owner = None
    print(f"[scan] 校验 {len(cases)} 例的输入场池化与权重一致性 …", flush=True)
    for year, lead in cases:
        case = f"{year}-pre{lead}"
        npz = npz_root / f"default-{year}-pre{lead}" / "projection_preview.npz"
        if not npz.is_file():
            raise SystemExit(f"[scan] {case}: 缺少 {npz}（先跑 precompute_default）")
        with np.load(npz, allow_pickle=False) as z:
            raw = np.asarray(z["raw"], dtype=np.float64)
            weights = np.asarray(z["weights"], dtype=np.float64)
            dates = [str(item) for item in z["dates"]]
        if raw.shape != PROJ_SHAPE:
            raise SystemExit(f"[scan] {case}: raw {raw.shape} != {PROJ_SHAPE}")
        if weights.shape != PROJ_SHAPE[:2]:
            raise SystemExit(f"[scan] {case}: weights {weights.shape} != {PROJ_SHAPE[:2]}")
        if len(dates) != PROJ_STEPS:
            raise SystemExit(f"[scan] {case}: {len(dates)} dates != {PROJ_STEPS}")
        if weights_ref is None:
            weights_ref, weights_owner = weights, case
        elif not np.array_equal(weights_ref, weights):
            raise SystemExit(
                f"[scan] {case}: 投影权重与 {weights_owner} 不同 —— 权重不能全局共享"
            )
        raw_f32 = raw.astype("<f4")
        for t, date in enumerate(dates):
            key = int(date.replace("-", ""))
            field = np.ascontiguousarray(raw_f32[:, :, t]).tobytes()
            seen = pool.get(key)
            if seen is None:
                pool[key] = field
            elif seen != field:
                a = np.frombuffer(seen, dtype="<f4").astype(np.float64)
                b = np.frombuffer(field, dtype="<f4").astype(np.float64)
                raise SystemExit(
                    f"[scan] {case}: {date} 的 U850 输入场与池中已有副本不同 "
                    f"(max |diff| = {np.max(np.abs(a - b)):.3e}) —— 池化假设不成立，禁止继续"
                )
    years = sorted({key // 10000 for key in pool})
    print(f"[scan] 通过：{len(pool)} 个日历日（{years[0]}–{years[-1]}），权重组一致")
    return pool, weights_ref


def write_pool(remote: Writer, pool: dict, weights) -> tuple[str, dict]:
    """Write the shared weights file and the per-year input pools.

    Returns ``(weights_path, {year: pool_path})`` as recorded in the manifest.
    """
    import numpy as np

    weights_path = remote.write_bytes(
        "shared/weights.f64",
        np.ascontiguousarray(weights, dtype="<f8").tobytes(), force_gz=True,
    )
    pool_paths = {}
    for year in sorted({key // 10000 for key in pool}):
        keys = sorted(key for key in pool if key // 10000 == year)
        fields = np.stack([np.frombuffer(pool[key], dtype="<f4").reshape(PROJ_SHAPE[:2]) for key in keys])
        pool_paths[year] = remote.write_bytes(
            f"input/{year}.f32",
            encode_input_pool(keys, fields, *PROJ_SHAPE[:2]), force_gz=True,
        )
        print(f"  pool {year}: {len(keys)} 天", flush=True)
    return weights_path, pool_paths


def bake_heavy(client, repo: Writer, remote: Writer, cases, *, precision: str,
               parity_cases, want_fixture: bool, lat, lon) -> dict:
    """Write every heavy payload for ``cases``; returns the manifest refs."""
    import numpy as np
    import chain

    npz_root = Path(chain.JOB_ROOT)
    dtype = "<f4" if precision == "f32" else "<f8"
    grid_tol = 1e-6 if precision == "f32" else 1e-12
    started = time.time()

    # 1. Verify pooling over every case first: nothing is written on a mismatch.
    pool, weights = scan_projection_sources(cases)

    # 2. Shared weights + the per-year input pools.
    weights_path, pool_paths = write_pool(remote, pool, weights)

    # 3. Per-case frames and arrays.
    refs: dict[str, dict] = {}
    year_obs: dict[int, bytes] = {}
    obs_owner: dict[int, str] = {}
    obs_paths: dict[int, str] = {}
    for number, (year, lead) in enumerate(cases, start=1):
        case = f"{year}-pre{lead}"
        entry = repo.cases.get(case)
        if entry is None:
            raise SystemExit(f"[heavy] {case}: 仓库层条目缺失（先跑轻量层或 --reuse-light）")
        fold = int(entry["fold"])
        default_doc = read_json(repo.out_dir / entry["files"]["default-cio"])
        state = default_doc.get("projection") or {}

        with np.load(npz_root / f"default-{year}-pre{lead}" / "projection_preview.npz",
                     allow_pickle=False) as z:
            raw = np.asarray(z["raw"], dtype=np.float64)
            processed = np.asarray(z["processed"], dtype=np.float64)
            projected = np.asarray(z["projected"], dtype=np.float64)
            dates = [str(item) for item in z["dates"]]

        # Frame constants (float64, exactly the values the route reports).
        contribution = processed * weights[:, :, None]
        net_all = np.sum(contribution, axis=(0, 1), dtype=np.float64)
        scalars = np.empty((PROJ_STEPS, 5), dtype="<f8")
        scalars[:, 0] = projected
        scalars[:, 1] = np.sum(np.where(contribution > 0, contribution, 0.0), axis=(0, 1), dtype=np.float64)
        scalars[:, 2] = np.sum(np.where(contribution < 0, contribution, 0.0), axis=(0, 1), dtype=np.float64)
        scalars[:, 3] = net_all
        scalars[:, 4] = net_all - projected
        average_abs = np.mean(np.abs(contribution), axis=2, dtype=np.float64)

        frame_index = {
            "case": case,
            "year": int(year),
            "lead": int(lead),
            "rows": PROJ_SHAPE[0],
            "cols": PROJ_SHAPE[1],
            "steps": PROJ_STEPS,
            "dates": dates,
            "targetYear": state.get("year", int(year)),
            "window": [list(bound) for bound in state["window"]] if state.get("window") else None,
            "calendarKnown": bool(default_doc.get("calendarKnown")),
            "scaleMax": {
                "input": float(np.max(np.abs(raw))),
                "processed": float(np.max(np.abs(processed))),
                "contribution": float(np.max(np.abs(contribution))),
            },
            "averageAbs": _as_nested(average_abs),
            "precision": precision,
        }
        index_path = remote.write_bytes(
            f"cases/{case}/frame-index.json",
            json.dumps(frame_index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            force_gz=True,
        )
        bundle_path = remote.write_bytes(
            f"cases/{case}/frames.bin",
            encode_frame_bundle(
                np.ascontiguousarray(processed.transpose(2, 0, 1).astype(dtype)),
                scalars, *PROJ_SHAPE[:2], PROJ_STEPS,
            ),
            force_gz=True,
        )

        # Dataset arrays: float32 verbatim from disk.
        predict2 = np.ascontiguousarray(real_data_mod._load_npy(lead, year, fold, "predict2"))
        real2 = np.ascontiguousarray(real_data_mod._load_npy(lead, year, fold, "real2"))
        pearson_r = np.ascontiguousarray(
            real_data_mod._display_pearson(lead, year).astype(np.float32)
        )
        for source, name in ((predict2, "predict2"), (real2, "real2"), (pearson_r, "pearsonR")):
            if source.dtype != np.float32:
                raise SystemExit(f"[heavy] {case}: {name} is {source.dtype}, expected float32")
        if predict2.shape != ARRAY_SHAPE or real2.shape != ARRAY_SHAPE:
            raise SystemExit(f"[heavy] {case}: unexpected array shape {predict2.shape}")
        real2_bytes = real2.tobytes()
        seen = year_obs.get(year)
        if seen is None:
            year_obs[year], obs_owner[year] = real2_bytes, case
            obs_paths[year] = remote.write_bytes(f"years/{year}/real2.f32", real2_bytes, force_gz=True)
        elif seen != real2_bytes:
            raise SystemExit(
                f"[heavy] {case}: real2 与 {obs_owner[year]} 不同 —— 观测按年共享的假设不成立"
            )
        refs[case] = {
            "arrays": {
                "predict2": remote.write_bytes(
                    f"cases/{case}/arrays/predict2.f32", predict2.tobytes(), force_gz=True),
                "pearsonR": remote.write_bytes(
                    f"cases/{case}/arrays/pearson_r.f32", pearson_r.tobytes(), force_gz=True),
                "real2": obs_paths[year],
            },
            "frames": {"index": index_path, "bundle": bundle_path},
            "input": pool_paths[year],
            "frameCount": PROJ_STEPS,
        }
        if number % 50 == 0:
            print(f"  … heavy {number}/{len(cases)} ({time.time() - started:.0f}s)", flush=True)

    # 4. Parity: rebuild sampled frames from the *written* files and compare
    #    every field with the live API response.
    errors: list[str] = []
    for case in sorted(parity_cases):
        year, lead = int(case.split("-")[0]), int(case.split("-pre")[1])
        if case not in refs:
            raise SystemExit(f"[parity] {case}: 不在本批烘焙用例内，无法对拍")
        ref = refs[case]
        index_doc = json.loads(read_maybe_gz(remote.out_dir / ref["frames"]["index"][len(REMOTE_PREFIX):]))
        bundle_blob = read_maybe_gz(remote.out_dir / ref["frames"]["bundle"][len(REMOTE_PREFIX):])
        processed_all, scalars_all = decode_frame_bundle(bundle_blob)
        pool_blob = read_maybe_gz(remote.out_dir / ref["input"][len(REMOTE_PREFIX):])
        pool_keys, pool_fields = decode_input_pool(pool_blob)
        positions = {int(key): pos for pos, key in enumerate(pool_keys)}
        job_id = ensure_job(client, case)
        for t in (0, PROJ_STEPS // 2, PROJ_STEPS - 1):
            api = json.loads(fetch(client, f"/api/chain/jobs/{job_id}/projection-preview",
                                   {"time_index": t}))
            date_key = int(index_doc["dates"][t].replace("-", ""))
            pos = positions.get(date_key)
            if pos is None:
                errors.append(f"{case} t={t}: {index_doc['dates'][t]} 不在输入池中")
                continue
            rebuilt = rebuild_projection_frame(
                index_doc, t,
                processed_all[t].astype(np.float64),
                scalars_all[t].astype(np.float64),
                weights.astype(np.float64),
                pool_fields[pos].astype(np.float64),
                lat, lon,
            )
            check_projection_parity(case, api, rebuilt, errors, grid_tol)
        print(f"  parity {case}: {'OK' if not errors else 'FAIL'}", flush=True)
    if errors:
        raise SystemExit("[parity] 重建结果与线上 API 不一致：\n  " + "\n  ".join(errors[:20]))
    print(f"[parity] {len(parity_cases)} 例 × 3 帧逐字段对拍通过（容差 {grid_tol:g}）")

    return {
        "refs": refs,
        "weights": weights_path,
        "fixture": write_projection_fixture(client, repo, remote, refs, pool, weights, parity_cases)
        if want_fixture else None,
    }


def write_projection_fixture(client, repo: Writer, remote: Writer, refs, pool, weights,
                             parity_cases) -> str:
    """Front-end fixture: three days of the binary payloads + the API's own numbers.

    The JS test decodes the same bytes the browser decodes, rebuilds the frame,
    and checks the scalars, the scale limits and a set of grid cells against the
    values the API returned for those three days.  Written into the *repository*
    layer: tests must run without network access.
    """
    import numpy as np

    case = sorted(parity_cases)[0]
    ref = refs[case]
    index_doc = json.loads(read_maybe_gz(remote.out_dir / ref["frames"]["index"][len(REMOTE_PREFIX):]))
    processed_all, scalars_all = decode_frame_bundle(
        read_maybe_gz(remote.out_dir / ref["frames"]["bundle"][len(REMOTE_PREFIX):]))
    pool_keys, pool_fields = decode_input_pool(
        read_maybe_gz(remote.out_dir / ref["input"][len(REMOTE_PREFIX):]))
    positions = {int(key): pos for pos, key in enumerate(pool_keys)}

    rows, cols = PROJ_SHAPE[:2]
    days = (0, PROJ_STEPS // 2, PROJ_STEPS - 1)
    # Shrink the index to the sampled days so the fixture stays small.
    index_small = dict(index_doc)
    index_small["steps"] = len(days)
    index_small["dates"] = [index_doc["dates"][t] for t in days]
    samples = []
    job_id = ensure_job(client, case)
    for t in days:
        api = json.loads(fetch(client, f"/api/chain/jobs/{job_id}/projection-preview",
                               {"time_index": t}))
        date_key = int(index_doc["dates"][t].replace("-", ""))
        pos = positions[date_key]
        processed_t = processed_all[t].astype(np.float64)
        cells = []
        for row, col in ((0, 0), (0, cols - 1), (rows - 1, 0), (rows - 1, cols - 1),
                         (rows // 2, cols // 2)):
            cells.append({
                "row": row, "col": col,
                "input": float(pool_fields[pos, row, col]),
                "processed": float(api["stages"][1]["data"][row][col]),
                "contribution": float(api["stages"][2]["data"][row][col]),
            })
        samples.append({
            "timeIndex": t,
            "date": index_doc["dates"][t],
            "projectedCio": api["projectedCio"],
            "contributionSum": api["contributionSum"],
            "selectedContribution": api["selectedContribution"],
            "scaleMax": {key: api["stages"][k]["scaleMax"] for k, key in
                         enumerate(("input", "processed", "contribution"))},
            "averageAbsScaleMax": api["windowContribution"]["scaleMax"],
            "cells": cells,
        })
    payload = {
        "case": case,
        "grid": {"rows": rows, "cols": cols},
        "index": index_small,
        "bundle_b64": base64.b64encode(
            encode_frame_bundle(
                np.ascontiguousarray(processed_all[list(days)].astype("<f4")),
                np.ascontiguousarray(scalars_all[list(days)]), rows, cols, len(days),
            )
        ).decode("ascii"),
        "pool_b64": base64.b64encode(
            encode_input_pool(
                [int(index_doc["dates"][t].replace("-", "")) for t in days],
                np.ascontiguousarray(
                    pool_fields[[positions[int(index_doc["dates"][t].replace("-", ""))] for t in days]]),
                rows, cols,
            )
        ).decode("ascii"),
        "weights_b64": base64.b64encode(
            np.ascontiguousarray(weights, dtype="<f8").tobytes()).decode("ascii"),
        "samples": samples,
        "note": "由 scripts/bake_demo_data.py 生成；JS 侧解码与重建公式的对拍夹具",
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return repo.write_bytes("test-fixtures/projection.json", blob)


def bake_dataset_fixture(client, cases, repo: Writer) -> dict | None:
    """The dataset-side parity fixture consumed by test/staticData.test.js.

    The arrays these samples are rebuilt from live on the remote host, so a copy
    of one case's three arrays ships next to the fixture: the CI test must run
    with no network.  That copy is ~7 MB and is the only heavy payload kept in
    the repository layer.
    """
    import numpy as np

    rng = random.Random(20261014)
    case = sorted(cases)[0]
    year, lead = int(case.split("-")[0]), int(case.split("-pre")[1])
    entry = repo.cases[case]
    fold = int(entry["fold"])
    predict2 = np.ascontiguousarray(real_data_mod._load_npy(lead, year, fold, "predict2"))
    real2 = np.ascontiguousarray(real_data_mod._load_npy(lead, year, fold, "real2"))
    pearson_r = np.ascontiguousarray(real_data_mod._display_pearson(lead, year).astype(np.float32))
    for source, name in ((predict2, "predict2"), (real2, "real2"), (pearson_r, "pearsonR")):
        if source.dtype != np.float32:
            raise SystemExit(f"[fixture] {case}: {name} is {source.dtype}, expected float32")
    scale_max = rainfall_color_limit(predict2, real2)
    case_samples = {"case": case, "grid": [], "frames": []}
    for _ in range(3):
        i, j = rng.randrange(0, ARRAY_SHAPE[0]), rng.randrange(0, ARRAY_SHAPE[1])
        api_grid = json.loads(fetch(client, "/api/grid", {
            "i": i, "j": j, "region": "eastasia", "year": year, "lead": f"pre{lead}",
        }))
        check_grid_parity(case, api_grid, predict2, real2, pearson_r, [(i, j)])
        case_samples["grid"].append({"i": i, "j": j, "response": api_grid})
    for index in sorted(rng.sample(range(ARRAY_SHAPE[2]), 2)):
        for kind, values, endpoint in (
            ("prediction", predict2, "preview"),
            ("truth", real2, "truth/preview"),
        ):
            api_frame = json.loads(fetch(
                client, f"/api/dataset/{year}/{lead}/{fold}/{endpoint}", {"time_index": index},
            ))
            check_frame_parity(case, kind, api_frame, values, index, scale_max)
            case_samples["frames"].append({"which": kind, "timeIndex": index, "response": api_frame})
    blob = json.dumps(case_samples, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return {
        "parity": repo.write_bytes("test-fixtures/parity.json", blob),
        "case": case,
        "arrays": {
            "predict2": repo.write_bytes("test-fixtures/case-arrays/predict2.f32",
                                         predict2.tobytes(), force_gz=True),
            "real2": repo.write_bytes("test-fixtures/case-arrays/real2.f32",
                                      real2.tobytes(), force_gz=True),
            "pearsonR": repo.write_bytes("test-fixtures/case-arrays/pearson_r.f32",
                                         pearson_r.tobytes(), force_gz=True),
        },
        "shape": {"rows": ARRAY_SHAPE[0], "cols": ARRAY_SHAPE[1], "steps": ARRAY_SHAPE[2]},
    }


# ── landing-case inlining ───────────────────────────────────────────────────


def inline_landing_cases(repo: Writer, remote_dir: Path, cases, manifest: dict) -> None:
    """Copy a case's heavy payload into the repository layer.

    The manifest entry drops the ``remote:`` prefix, so the browser loads those
    files from the site itself (``resolveAssetUrl`` sends non-remote paths to
    ``demo-data/``) — no frontend code is involved.  Files already inlined by a
    previous bake are left alone, which keeps this pass idempotent.

    The projection weights are shared by every case and every daily frame, so
    they move to the repository layer too as soon as one case is inlined —
    otherwise the landing page would still stall on the dataset host.
    """
    inlined_total = 0

    def relocate(path: str, label: str) -> str:
        nonlocal inlined_total
        if not isinstance(path, str) or not path.startswith(REMOTE_PREFIX):
            return path  # already in the repository layer
        rel = path[len(REMOTE_PREFIX):]
        source = remote_dir / rel
        if not source.is_file():
            raise SystemExit(
                f"[inline] {label} 要内置的外置文件不存在：{source}\n"
                "        （先跑完整烘焙，或 --inline-cases \"\" 关闭内置）"
            )
        gzipped = rel.endswith(".gz")
        stored = repo.write_bytes(
            rel[:-len(".gz")] if gzipped else rel,
            read_maybe_gz(source),
            force_gz=gzipped,
        )
        if stored != rel:  # the writer must reproduce the very same name
            raise SystemExit(f"[inline] {label}: {stored} != {rel}")
        inlined_total += 1
        return stored

    for case in cases:
        entry = manifest["cases"].get(case)
        if entry is None:
            print(f"[inline] 跳过 {case}（不在本次烘焙范围内）")
            continue
        before = inlined_total
        entry["arrays"] = {key: relocate(value, case) for key, value in (entry.get("arrays") or {}).items()}
        entry["frames"] = {key: relocate(value, case) for key, value in (entry.get("frames") or {}).items()}
        if entry.get("input"):
            entry["input"] = relocate(entry["input"], case)
        if inlined_total > before:
            print(f"[inline] {case}：{inlined_total - before} 个重文件内置进仓库层（默认页不依赖外置宿主）")

    # Any landing case that now lives entirely in the repository layer pulls the
    # shared heavy files with it (asked of the manifest, not of this run, so a
    # resumed bake repairs a half-inlined state too).
    def is_local(entry: dict) -> bool:
        paths = list((entry.get("arrays") or {}).values()) + list((entry.get("frames") or {}).values())
        if entry.get("input"):
            paths.append(entry["input"])
        return bool(paths) and not any(
            isinstance(path, str) and path.startswith(REMOTE_PREFIX) for path in paths
        )

    landing_local = any(
        manifest["cases"].get(case) and is_local(manifest["cases"][case]) for case in cases
    )
    if landing_local:
        shared = manifest.get("shared") or {}
        before = inlined_total
        for key, value in list(shared.items()):
            shared[key] = relocate(value, f"shared.{key}")
        if inlined_total > before:
            print(f"[inline] shared 重文件 {inlined_total - before} 个（含投影权重）→ 仓库层")


# ── integrity + reporting ───────────────────────────────────────────────────


def verify_integrity(out_dir: Path, remote_dir: Path, manifest: dict) -> None:
    missing = []
    fixtures = manifest.get("testFixtures") or {}
    for key in ("parity", "projection"):
        relpath = fixtures.get(key)
        if relpath and not (out_dir / relpath).is_file():
            missing.append(f"testFixtures.{key}: {relpath}")
    for relpath in (fixtures.get("arrays") or {}).values():
        if not (out_dir / relpath).is_file():
            missing.append(f"testFixtures.arrays: {relpath}")
    for case, entry in manifest["cases"].items():
        for relpath in _iter_repo_paths(entry):
            if not (out_dir / relpath).is_file():
                missing.append(f"{case}: {relpath}")
        for relpath in _iter_remote_paths(entry):
            if not (remote_dir / relpath).is_file():
                missing.append(f"{case}: remote:{relpath}")
    if missing:
        raise SystemExit("[integrity] missing files:\n  " + "\n  ".join(missing[:20]))
    # The sampled case may have been inlined into the repository layer, so
    # resolve its frame files against whichever layer actually holds them.
    sample = next(iter(manifest["cases"].values()))
    frames_root = remote_dir
    bundle_path, index_path = sample["frames"]["bundle"], sample["frames"]["index"]
    if bundle_path.startswith(REMOTE_PREFIX):
        bundle_path = bundle_path[len(REMOTE_PREFIX):]
        index_path = index_path[len(REMOTE_PREFIX):]
    else:
        frames_root = out_dir
    blob = read_maybe_gz(frames_root / bundle_path)
    processed, scalars = decode_frame_bundle(blob)
    if processed.shape != (PROJ_STEPS, *PROJ_SHAPE[:2]) or scalars.shape != (PROJ_STEPS, 5):
        raise SystemExit("[integrity] frame bundle shape mismatch")
    index_doc = json.loads(read_maybe_gz(frames_root / index_path))
    if len(index_doc["dates"]) != PROJ_STEPS:
        raise SystemExit("[integrity] frame index date count mismatch")


def cleanup_legacy_repo_heavy(out_dir: Path, manifest: dict) -> None:
    """Drop the heavy files the first bake wrote into the repository layer."""
    import shutil

    removed = 0
    for case in manifest["cases"]:
        for pattern in LEGACY_REPO_DIRS:
            legacy = out_dir / pattern.format(case=case)
            if legacy.is_dir():
                shutil.rmtree(legacy)
                removed += 1
    if removed:
        print(f"[cleanup] 从仓库层移除 {removed} 个旧的重数据目录（arrays/ frames/ 已转外置）")


def _iter_repo_paths(entry: dict):
    for value in (entry.get("files") or {}).values():
        if isinstance(value, dict):
            for inner in value.values():
                yield from inner.values()
        else:
            yield value
    # Heavy payloads inlined into the repository layer (landing case): arrays,
    # frames and the input pool that do NOT carry the `remote:` prefix.
    heavy = list((entry.get("arrays") or {}).values()) + list((entry.get("frames") or {}).values())
    if entry.get("input"):
        heavy.append(entry["input"])
    for value in heavy:
        if isinstance(value, str) and not value.startswith(REMOTE_PREFIX):
            yield value


def _iter_remote_paths(entry: dict):
    for value in (entry.get("arrays") or {}).values():
        if isinstance(value, str) and value.startswith(REMOTE_PREFIX):
            yield value[len(REMOTE_PREFIX):]
    for value in (entry.get("frames") or {}).values():
        if isinstance(value, str) and value.startswith(REMOTE_PREFIX):
            yield value[len(REMOTE_PREFIX):]
    if str(entry.get("input", "")).startswith(REMOTE_PREFIX):
        yield entry["input"][len(REMOTE_PREFIX):]


def fixture_paths_present(fixtures: dict, out_dir: Path) -> bool:
    """True when every file a (reused) ``testFixtures`` block points at is on disk."""
    paths = [fixtures.get(key) for key in ("parity", "projection")]
    paths += list((fixtures.get("arrays") or {}).values())
    return all(isinstance(path, str) and (out_dir / path).is_file() for path in paths)


def size_report(writers) -> None:
    for label, writer in writers:
        raw = sum(item[1] for item in writer.entries)
        stored = sum(item[2] for item in writer.entries)
        print(f"{label}: {len(writer.entries)} 个新文件 {raw / 1e6:.1f} MB → {stored / 1e6:.1f} MB")


# ── entry point ─────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="仓库层输出目录")
    parser.add_argument("--remote-out", type=Path, default=DEFAULT_REMOTE_OUT, help="外置层输出目录")
    parser.add_argument("--remote-base", default=DEFAULT_REMOTE_BASE,
                        help="外置层公开 URL（写进 manifest.remoteBase，须以 / 结尾）")
    parser.add_argument("--reuse-light", action="store_true",
                        help="复用 --out 里已烘焙的轻量层（文件齐全时不再请求 API）")
    parser.add_argument("--light-only", action="store_true", help="只烘仓库层")
    parser.add_argument("--heavy-only", action="store_true", help="只烘外置层（配合 --reuse-light）")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个组合（调试用）")
    parser.add_argument("--frame-precision", choices=("f32", "f64"), default="f32",
                        help="投影 processed 帧的存储精度（默认 f32）")
    parser.add_argument("--parity-cases", default=",".join(DEFAULT_PARITY_CASES),
                        help="抽哪些用例与线上 API 逐字段对拍")
    parser.add_argument("--no-fixture", action="store_true", help="不写前端对拍夹具")
    parser.add_argument("--cleanup-legacy", action="store_true",
                        help="删除仓库层里第一期烘焙留下的重数据目录（arrays/ frames/）")
    parser.add_argument("--inline-cases", default=",".join(DEFAULT_INLINE_CASES),
                        help="把这些用例的重数据复制进仓库层（默认 2000-pre20；传空串关闭）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configure_env()
    global real_data_mod
    main_mod, real_data_mod = import_backend()
    import cioproj

    assert real_data_mod.DISPLAY_MODE == "fold1", "DISPLAY_MODE 必须锁在 fold1"
    assert real_data_mod.DATA_FAMILY == "ASTGRN", "DATA_FAMILY 必须锁在 ASTGRN"
    if not args.remote_base.endswith("/"):
        raise SystemExit("[args] --remote-base 必须以 / 结尾")

    case_order = [(year, lead) for year in ALL_YEARS for lead in ALL_LEADS]
    if args.limit:
        case_order = case_order[: args.limit]
    parity_cases = {item.strip() for item in args.parity_cases.split(",") if item.strip()}

    repo = Writer(args.out)
    remote = Writer(args.remote_out, prefix=REMOTE_PREFIX)
    started = time.time()

    manifest_path = args.out / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else None
    reused: dict[str, dict] = {}
    if args.reuse_light and previous:
        for case, entry in (previous.get("cases") or {}).items():
            if "files" in entry and all((args.out / path).is_file() for path in _iter_repo_paths(entry)):
                reused[case] = entry
        print(f"[reuse] 复用 {len(reused)} 个已烘焙用例的仓库层")
    repo.cases.update(reused)

    from fastapi.testclient import TestClient

    with TestClient(main_mod.app) as client:
        manifest = {
            "version": 2,
            "family": real_data_mod.DATA_FAMILY,
            "displayMode": real_data_mod.DISPLAY_MODE,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "defaultCase": "2000-pre20",
            "grid": {"rows": ARRAY_SHAPE[0], "cols": ARRAY_SHAPE[1], "steps": ARRAY_SHAPE[2]},
            "projection": {
                "rows": PROJ_SHAPE[0], "cols": PROJ_SHAPE[1], "steps": PROJ_STEPS,
                "lat": cioproj.LAT_TGT.tolist(), "lon": cioproj.LON_TGT.tolist(),
            },
            "remoteBase": args.remote_base,
            "shared": dict(previous.get("shared") or {}) if (previous and args.reuse_light) else {},
            "cases": {},
        }
        if not args.heavy_only:
            if not manifest["shared"]:
                manifest["shared"] = bake_shared(client, repo)
            for index, (year, lead) in enumerate(case_order, start=1):
                case = f"{year}-pre{lead}"
                if case in reused:
                    continue
                began = time.time()
                entry = bake_case_light(client, repo, year, lead)
                repo.cases[case] = entry
                print(f"[light {index}/{len(case_order)}] {case} ({time.time() - began:.1f}s)", flush=True)

        if not args.light_only:
            if args.heavy_only:
                heavy_cases = [(int(case.split("-")[0]), int(case.split("-pre")[1]))
                               for case in sorted(repo.cases)]
            else:
                heavy_cases = case_order
            if args.limit:
                heavy_cases = heavy_cases[: args.limit]
            heavy = bake_heavy(
                client, repo, remote, heavy_cases,
                precision=args.frame_precision,
                parity_cases=parity_cases,
                want_fixture=not args.no_fixture,
                lat=cioproj.LAT_TGT.tolist(), lon=cioproj.LON_TGT.tolist(),
            )
            refs = heavy["refs"]
            manifest["shared"]["weights"] = heavy["weights"]
            for case, ref in refs.items():
                entry = repo.cases[case]
                entry["arrays"] = ref["arrays"]
                entry["frames"] = ref["frames"]
                entry["input"] = ref["input"]
                entry["frameCount"] = ref["frameCount"]
                # `full` means "daily fields + grid-point series exist"; only
                # this merge (or a reused entry that has already been merged)
                # may set it.  `preview` is the v1 spelling of the same idea.
                entry["full"] = True
                entry.pop("preview", None)
            manifest["cases"] = repo.cases
            if not args.no_fixture:
                fixture = bake_dataset_fixture(client, sorted(parity_cases), repo)
                if fixture:
                    fixture["projection"] = heavy["fixture"]
                    manifest["testFixtures"] = fixture
        else:
            manifest["cases"] = repo.cases
            # A light-only run does not touch the fixtures the previous heavy
            # bake wrote; keep pointing at them while those files are on disk.
            fixtures = (previous or {}).get("testFixtures")
            if fixtures and fixture_paths_present(fixtures, args.out):
                manifest["testFixtures"] = fixtures
                print(f"[light] 保留上一轮 testFixtures（{len(fixtures.get('arrays') or {})} 个数组）")

    manifest["cases"] = dict(sorted(manifest["cases"].items()))
    inline_cases = [item.strip() for item in args.inline_cases.split(",") if item.strip()]
    if inline_cases:
        inline_landing_cases(repo, args.remote_out, inline_cases, manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    verify_integrity(args.out, args.remote_out, manifest)
    if args.cleanup_legacy:
        cleanup_legacy_repo_heavy(args.out, manifest)
    print()
    size_report([("仓库层", repo), ("外置层", remote)])
    print(f"用例 {len(manifest['cases'])}，总耗时 {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
