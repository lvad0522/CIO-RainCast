"""Prepare all default CIO projection/normalization artifacts before serving the UI.

Run from the repository root: python backend/precompute_default.py
Uses the existing trained preprocessing, independent of model checkpoint availability.
Rainfall predictions are already computed (default tree: Dataset-AGCRN/, the ASTGRN
products; DATA_ROOT switches trees) and served by dataset_evaluation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np

import chain
import cioproj
import cio_diagnostics as diagnostics
import live_prediction as prediction
import u850_adapter
from default_cio import CACHE_VERSION, REQUIRED_FILES

ROOT = Path(__file__).resolve().parents[1]


def fingerprint(raw_dir: Path, mat: Path, lead: int) -> str:
    digest = hashlib.sha256()
    digest.update(f"{CACHE_VERSION}:{lead}".encode())
    for path in [*sorted(raw_dir.glob("*.nc*")), mat,
                 Path(cioproj.__file__), Path(u850_adapter.__file__), Path(prediction.__file__), Path(chain.__file__)]:
        stat = path.stat()
        digest.update(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()


def prepare(raw_dir: Path, leads=range(1, 21), years=range(2000, 2020), force=False):
    mat = prediction._mat_path()
    identity = chain._mat_identity(required=True)
    all_years = list(range(2000, 2021))
    years = list(years)
    for lead in leads:
        started = time.monotonic()
        signature = fingerprint(raw_dir, mat, lead)
        folders = {year: chain.JOB_ROOT / f"default-{year}-pre{lead}" for year in years}
        def fresh(folder):
            state_path = folder / "default_state.json"
            if not state_path.is_file() or any(not (folder / name).is_file() for name in REQUIRED_FILES):
                return False
            try:
                return json.loads(state_path.read_text(encoding="utf-8")).get("fingerprint") == signature
            except (ValueError, AttributeError, OSError):
                return False
        if not force and all(fresh(folder) for folder in folders.values()):
            print(f"pre{lead}: all {len(years)} windows already prepared", flush=True)
            continue
        print(f"pre{lead}: reading and projecting real U850", flush=True)
        raw, dom, rows, missing, adaptation = u850_adapter.load_fields(str(raw_dir), all_years, lead)
        consts = cioproj.load_consts(str(mat))
        series, preview = cioproj.project_u850(raw, dom, consts, np.arange(len(rows)))
        dates = [f"{y:04d}-{m:02d}-{d:02d}" for y, m, d in rows]
        per_year = {year: sum(row[0] == year for row in rows) for year in all_years}
        meta = {"years": all_years, "days_per_year": per_year, "missing_months": missing, "dates": dates}
        for year, folder in folders.items():
            folder.mkdir(parents=True, exist_ok=True)
            # Invalidate the completion marker before changing any files.
            state_path = folder / "default_state.json"
            if state_path.exists():
                state_path.unlink()
            indices = np.array([i for i, row in enumerate(rows) if row[0] == year])
            selected_dates = np.array([dates[i] for i in indices])
            checked = chain._validate_projection_preview(preview["raw"][:, :, indices], preview["processed"][:, :, indices], preview["weights"], selected_dates, series[indices])
            np.save(folder / "series.npy", series, allow_pickle=False)
            np.savez_compressed(folder / "projection_preview.npz", **{key: checked[key] for key in ("raw", "processed", "weights", "dates", "projected")})
            diagnostics._write_json(folder / "dates.json", dates)
            diagnostics._write_json(folder / "completeness.json", diagnostics._zip_completeness(meta))
            projection = {**identity, "kind": "u850", "kindSource": "system-default", "year": year, "lead": lead,
                          "years": all_years, "daysPerYear": per_year, "missingMonths": missing,
                          "window": [list(bound) for bound in cioproj.window(lead)], "seriesLength": len(series), "adaptation": adaptation}
            job_id = folder.name
            job = {"jobId": job_id, "status": "running", "stageIndex": 1, "progress": 30,
                   "inputKind": "raw-zip", "filename": "System U850 anomalies (2000–2020)",
                   "projectionMode": "u850_only", "calendarKnown": True, "projection": projection}
            with chain._jobs_lock:
                chain._jobs[job_id] = job
            chain._run_stage2(job_id, folder, projection)
            chain._update_job(job_id, status="completed", stage="Prepared locally", progress=100,
                              durationSeconds=round(time.monotonic()-started, 2))
            job = chain._get_job(job_id)
            # Atomic completion marker; artifacts survive backend restarts.
            temp = folder / "default_state.tmp"
            diagnostics._write_json(temp, {"cacheVersion": CACHE_VERSION, "fingerprint": signature, "job": job})
            temp.replace(state_path)
        print(f"pre{lead}: {len(series)} samples, {len(years)} validated windows, {time.monotonic()-started:.1f}s", flush=True)
        del raw, preview, checked


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=ROOT / "摸库交付_2026-09-15" / "数据" / "U850")
    parser.add_argument("--leads", type=int, nargs="+", default=list(range(1, 21)))
    parser.add_argument("--years", type=int, nargs="+", default=list(range(2000, 2020)))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if any(lead not in range(1, 21) for lead in args.leads) or any(year not in range(2000, 2020) for year in args.years):
        parser.error("Supported leads: 1–20; supported target years: 2000–2019")
    prepare(args.raw_dir, args.leads, args.years, args.force)
    from eastasia_u850 import prepare as prepare_eastasia
    prepare_eastasia(args.raw_dir, args.leads, args.years, args.force)
