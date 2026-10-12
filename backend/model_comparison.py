"""Paired, fixed-run comparison of the CIO-input LSTM and ASTGRN products.

Only scalar summaries are cached. Neither process-wide DATA_ROOT / DISPLAY_MODE
nor the legacy pearson2 products participate in this calculation.
"""
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from real_data import dataset_file_path

router = APIRouter(tags=["model-comparison"])
_REPO = Path(__file__).resolve().parent.parent
DATA_ROOTS = {"LSTM": _REPO / "Dataset", "ASTGRN": _REPO / "Dataset-AGCRN"}
MODELS = ("LSTM", "ASTGRN")
YEARS = tuple(range(2000, 2020))
LEADS = tuple(range(1, 21))
SHAPE = (81, 101, 112)
# lru_cache alone permits duplicate concurrent cache misses. Serialize scalar
# case calculation so overlapping all-year requests never reread one case.
_CASE_LOCK = RLock()
REGIONS = {
    "focus": (slice(12, 29), slice(48, 85), "112–121°E, 23–27°N"),
    "eastasia": (slice(None), slice(None), "100–125°E, 20–40°N"),
}
DEFINITION = (
    "Fixed run 1; both models use CIO inputs. Gridpoint Pearson correlations "
    "are recomputed on shared finite time samples and averaged over the same "
    "gridpoints where both correlations are defined. RMSE and MAE pool all "
    "shared finite gridpoint-time pairs in the selected region. Both use the "
    "LSTM truth after confirming the two stored truths agree within numerical "
    "precision (rtol=1e-6, atol=1e-5). Across-year curves average each year's "
    "paired regional correlation equally. Training setups differ; this is a "
    "prediction-method comparison, not a strict network ablation or CIO-gain test."
)


def _source_files(year, lead):
    files = []
    for model in MODELS:
        for kind in ("predict2", "real2"):
            path = Path(dataset_file_path(str(DATA_ROOTS[model]), lead, year, 1, kind))
            try:
                stat = path.stat()
            except OSError as exc:
                raise HTTPException(404, f"{model} pre{lead}/{year}: missing {kind} run 1") from exc
            # Root, exact filename and revision are all part of the cache key.
            files.append((str(path.resolve()), stat.st_mtime_ns, stat.st_size))
    return tuple(files)


def _point_correlations(prediction, truth, mask):
    counts = mask.sum(axis=-1)
    safe_counts = np.maximum(counts, 1)
    p_mean = np.where(mask, prediction, 0).sum(axis=-1) / safe_counts
    t_mean = np.where(mask, truth, 0).sum(axis=-1) / safe_counts
    p_centered = np.where(mask, prediction - p_mean[..., None], 0)
    t_centered = np.where(mask, truth - t_mean[..., None], 0)
    p_ss = np.sum(p_centered * p_centered, axis=-1)
    t_ss = np.sum(t_centered * t_centered, axis=-1)
    denominator = np.sqrt(p_ss * t_ss)
    defined = (counts >= 2) & (denominator > 0) & np.isfinite(denominator)
    result = np.full(counts.shape, np.nan, dtype=float)
    np.divide(np.sum(p_centered * t_centered, axis=-1), denominator,
              out=result, where=defined)
    return np.clip(result, -1, 1)


def summarize_arrays(lstm_prediction, lstm_truth, astgrn_prediction, astgrn_truth, region):
    arrays = (lstm_prediction, lstm_truth, astgrn_prediction, astgrn_truth)
    if any(array.shape != SHAPE for array in arrays):
        raise HTTPException(422, "Prediction/truth arrays must all have shape (81, 101, 112)")
    if not np.allclose(lstm_truth, astgrn_truth, rtol=1e-6, atol=1e-5, equal_nan=True):
        raise HTTPException(409, "LSTM and ASTGRN truths differ; the case cannot be compared")
    row_slice, col_slice, _ = REGIONS[region]
    selected = [np.asarray(array[row_slice, col_slice, :], dtype=np.float64) for array in arrays]
    lp, truth, ap, at = selected
    mask = np.isfinite(lp) & np.isfinite(truth) & np.isfinite(ap) & np.isfinite(at)
    correlations = [_point_correlations(pred, truth, mask) for pred in (lp, ap)]
    paired_points = np.isfinite(correlations[0]) & np.isfinite(correlations[1])
    point_count = int(paired_points.sum())
    pair_count = int(mask.sum())
    rows = []
    for model, prediction, correlation in zip(MODELS, (lp, ap), correlations):
        errors = prediction[mask] - truth[mask]
        rows.append({
            "model": model,
            "meanGridR": float(correlation[paired_points].mean()) if point_count else None,
            "rmse": float(np.sqrt(np.mean(errors * errors))) if pair_count else None,
            "mae": float(np.mean(np.abs(errors))) if pair_count else None,
            "fold": 1,
        })
    return {
        "rows": rows, "sampleCount": SHAPE[-1], "validGridPoints": point_count,
        "regionGridPoints": int(mask.shape[0] * mask.shape[1]),
        "validSamplePairs": pair_count,
        "validTimeSteps": int(np.any(mask, axis=(0, 1)).sum()),
    }


@lru_cache(maxsize=1024)
def _cached_case(files, region):
    try:
        arrays = [np.load(path, mmap_mode="r", allow_pickle=False) for path, _, _ in files]
    except (OSError, ValueError) as exc:
        raise HTTPException(422, "Prediction/truth product could not be read") from exc
    return summarize_arrays(*arrays, region)


def case_summary(year, lead, region):
    files = _source_files(year, lead)
    with _CASE_LOCK:
        return _cached_case(files, region)


def comparison(year, lead, region="focus", scope="year"):
    if year not in YEARS or lead not in LEADS or region not in REGIONS or scope not in ("year", "all"):
        raise HTTPException(422, "Invalid year, lead, region or scope")
    # Fail explicitly for a missing/mismatched selected case, even if other
    # years could supply an aggregate curve.
    current = case_summary(year, lead, region)
    years = (year,) if scope == "year" else YEARS
    curve, missing, valid_by_lead = [], [], []
    available = 0
    for curve_lead in LEADS:
        pairs = []
        for curve_year in years:
            try:
                summary = current if (curve_year, curve_lead) == (year, lead) else case_summary(curve_year, curve_lead, region)
            except HTTPException as exc:
                missing.append({"year": curve_year, "lead": curve_lead, "status": exc.status_code,
                                "reason": str(exc.detail)})
                continue
            values = [row["meanGridR"] for row in summary["rows"]]
            if all(value is not None for value in values):
                pairs.append(values)
                available += 1
            else:
                missing.append({"year": curve_year, "lead": curve_lead, "status": "undefined",
                                "reason": "No gridpoints have defined correlation for both models"})
        means = np.mean(pairs, axis=0) if pairs else (None, None)
        curve.append({"lead": curve_lead, "LSTM": None if means[0] is None else float(means[0]),
                      "ASTGRN": None if means[1] is None else float(means[1])})
        valid_by_lead.append({"lead": curve_lead, "availableYears": len(pairs), "totalYears": len(years)})
    rows = [dict(row) for row in current["rows"]]
    delta = {key: rows[1][key] - rows[0][key]
             if rows[0][key] is not None and rows[1][key] is not None else None
             for key in ("meanGridR", "rmse", "mae")}
    return {
        "year": year, "lead": lead, "region": region, "scope": scope,
        "models": list(MODELS), "metric": "mean_gridpoint_r",
        "regionLabel": REGIONS[region][2], "definition": DEFINITION,
        "sampleCount": current["sampleCount"], "validGridPoints": current["validGridPoints"],
        "regionGridPoints": current["regionGridPoints"],
        "validSamplePairs": current["validSamplePairs"], "validTimeSteps": current["validTimeSteps"],
        "rows": rows, "delta": delta, "curve": curve,
        "coverage": {"years": list(years), "availableCases": available,
                     "totalCases": len(years) * len(LEADS), "byLead": valid_by_lead,
                     "missing": missing},
        "source": "dataset",
    }


@router.get("/api/model-comparison")
def get_model_comparison(
    year: int = Query(2001, ge=2000, le=2019),
    lead: int = Query(1, ge=1, le=20),
    region: Literal["focus", "eastasia"] = "focus",
    scope: Literal["year", "all"] = "year",
):
    return comparison(year, lead, region, scope)
