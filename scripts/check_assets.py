"""Read-only check of assets required by one historical demonstration case."""
import argparse
import json
import os
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from real_data import dataset_file_path  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=2001, choices=range(2000, 2020))
    parser.add_argument("--lead", type=int, default=1, choices=range(1, 21))
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("DATA_ROOT", ROOT / "Dataset-AGCRN")))
    parser.add_argument("--cache-root", type=Path, default=Path(os.environ.get("CHAIN_JOB_ROOT", ROOT / "backend/uploads/chain_jobs")))
    parser.add_argument("--mat", type=Path, default=Path(os.environ.get("CIOPROJ_MAT", ROOT / "backend/assets/CIOmode_1982_2017.mat")))
    args = parser.parse_args()
    checks = []
    for kind in ("predict2", "real2", "pearson2"):
        path = Path(dataset_file_path(args.data_root, args.lead, args.year, 1, kind))
        expected = (81, 101, 3 if kind == "pearson2" else 112)
        valid = False
        reason = "missing"
        if path.is_file():
            try:
                values = np.load(path, mmap_mode="r", allow_pickle=False)
                valid = values.shape == expected
                reason = "ok" if valid else f"unexpected shape {values.shape}"
            except (OSError, ValueError) as error:
                reason = type(error).__name__
        checks.append({"asset": kind, "ok": valid, "status": reason})
    checks.append({"asset": "CIOmode_1982_2017.mat", "ok": args.mat.is_file()})
    folder = args.cache_root / f"default-{args.year}-pre{args.lead}"
    for filename in ("default_state.json", "series.npy", "normalized_window.npy",
                     "projection_preview.npz", "dates.json", "completeness.json"):
        checks.append({"asset": "cache/" + filename, "ok": (folder / filename).is_file()})
    if (folder / "default_state.json").is_file():
        try:
            state = json.loads((folder / "default_state.json").read_text(encoding="utf-8"))
            job = state["job"]
            valid = (state["cacheVersion"] == 1 and job["status"] == "completed"
                     and job["jobId"] == folder.name and job["projection"]["year"] == args.year
                     and job["projection"]["lead"] == args.lead)
        except (OSError, ValueError, KeyError, TypeError):
            valid = False
        checks.append({"asset": "cache identity", "ok": valid})
    optional_lstm = all(Path(dataset_file_path(ROOT / "Dataset", args.lead, args.year, 1, kind)).is_file()
                        for kind in ("predict2", "real2"))
    print(json.dumps({"year": args.year, "lead": args.lead, "checks": checks,
                      "optional_lstm_comparison": optional_lstm}, indent=2))
    return 0 if all(check["ok"] for check in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
