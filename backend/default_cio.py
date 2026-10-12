"""Persistent, locally prepared CIO diagnostics for the system dataset."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Query

import chain

router = APIRouter(prefix="/api/default-cio", tags=["default-cio"])
CACHE_VERSION = 1
REQUIRED_FILES = ("series.npy", "normalized_window.npy", "projection_preview.npz", "dates.json", "completeness.json")


def load_default_job(year: int, lead: str) -> dict:
    if not isinstance(lead, str) or not re.fullmatch(r"pre(?:[1-9]|1[0-9]|20)", lead):
        raise HTTPException(400, "Lead must be pre1 through pre20, without leading zeros.")
    lead_index = int(lead[3:])
    if not 2000 <= year <= 2019:
        raise HTTPException(400, "Year must be between 2000 and 2019.")
    job_id = f"default-{year}-{lead}"
    folder = chain.JOB_ROOT / job_id
    state_file = folder / "default_state.json"
    if not state_file.is_file() or any(not (folder / name).is_file() for name in REQUIRED_FILES):
        raise HTTPException(503, "Default CIO diagnostics have not been prepared locally. Run backend/precompute_default.py.")
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if state.get("cacheVersion") != CACHE_VERSION:
            raise ValueError("cache version")
        job = state["job"]
        if (job["jobId"] != job_id or job["status"] != "completed"
                or job["stageIndex"] != 2 or job["projection"]["year"] != year
                or job["projection"]["lead"] != lead_index):
            raise ValueError("cache identity")
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as exc:
        raise HTTPException(503, "Default CIO cache is invalid. Re-run backend/precompute_default.py.") from exc
    with chain._jobs_lock:
        chain._jobs[job_id] = job
    return chain._public_job(job)


@router.get("")
def default_cio(year: int = Query(2000), lead: str = Query("pre20")):
    # Only read completed artifacts: visiting the page never launches a projection job.
    return load_default_job(year, lead)
