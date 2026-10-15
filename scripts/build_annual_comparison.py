"""Build the small, offline annual-comparison product from fixed-run arrays.

The scientific definition intentionally matches the reviewer-B figure: for each
held-out year, compare each prediction with that year's processed observation;
the diagnostic reference is the pointwise mean of the other 19 observation
years at the same 112 retained target positions. It is not a forecast baseline.
No raw array, file path, training artefact or backend cache is published.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

MODELS = ("LSTM", "ASTGRN", "STDN")
METHODS = (*MODELS, "reference")
YEARS = tuple(range(2000, 2020))
CONFIGURATIONS = tuple(range(1, 21))
SHAPE = (81, 101, 112)
DATA_FOLDERS = {"LSTM": "Dataset", "ASTGRN": "Dataset-AGCRN", "STDN": "Dataset-STDN"}
REFERENCE_DEFINITION = (
    "Pointwise mean of the other 19 processed observation years at the same "
    "112 retained target positions, excluding the evaluated year; diagnostic "
    "reference, not a forecast baseline."
)
AGGREGATION = (
    "Per-configuration temporal Pearson r at each grid point, averaged over "
    "the same grid points for LSTM, ASTGRN, STDN and the reference. Every input "
    "must be finite at all 112 positions with positive temporal variance. "
    "An annual range uses the equal-weight mean of its configurations."
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def held_out_reference(truths: np.ndarray) -> np.ndarray:
    """Keep exactly the same summation and subtraction as the approved figure."""
    truths = np.asarray(truths, dtype=np.float64)
    if truths.ndim != 3 or truths.shape[0] < 2:
        raise ValueError("At least two observation years with grid/time axes are required")
    return (truths.sum(axis=0)[None] - truths) / (truths.shape[0] - 1)


def assert_same_truth(observation: np.ndarray, reference_truth: np.ndarray, label: str) -> None:
    if observation.shape != reference_truth.shape:
        raise ValueError(f"{label}: stored observation has a different shape")
    if not np.allclose(reference_truth, observation, rtol=1e-6, atol=1e-5, equal_nan=True):
        raise ValueError(f"{label}: stored observation differs from the reference truth")


def strict_correlations(truth: np.ndarray, predictions: dict[str, np.ndarray]):
    """Return four pointwise correlations and their strict common-grid mask."""
    truth = np.asarray(truth, dtype=np.float64)
    if truth.ndim != 2 or truth.shape[-1] < 2:
        raise ValueError("Truth must have grid/time axes with at least two samples")
    if set(predictions) != set(METHODS):
        raise ValueError("All three models and the reference are required")
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        centered_truth = truth - truth.mean(axis=-1, keepdims=True)
        variance_truth = np.sum(centered_truth * centered_truth, axis=-1)
        paired = np.all(np.isfinite(truth), axis=-1) & (variance_truth > 0)
        correlations = {}
        for method in METHODS:
            prediction = np.asarray(predictions[method], dtype=np.float64)
            if prediction.shape != truth.shape:
                raise ValueError(f"{method}: prediction and truth shapes differ")
            centered = prediction - prediction.mean(axis=-1, keepdims=True)
            variance = np.sum(centered * centered, axis=-1)
            denominator = np.sqrt(variance * variance_truth)
            valid = (np.all(np.isfinite(prediction), axis=-1) & (variance > 0)
                     & (variance_truth > 0) & np.isfinite(denominator))
            paired &= valid
            correlations[method] = np.divide(
                np.sum(centered * centered_truth, axis=-1), denominator,
                out=np.full(variance.shape, np.nan), where=valid,
            )
    for correlation in correlations.values():
        paired &= np.isfinite(correlation)
    return correlations, paired


def summarize_regions(truth, predictions, masks):
    correlations, paired = strict_correlations(truth, predictions)
    result = {}
    for region, mask in masks.items():
        selected = paired & mask
        count = int(selected.sum())
        if count == 0:
            raise ValueError(f"{region}: no common complete, nonconstant grid points")
        result[region] = {
            **{method: float(correlations[method][selected].mean()) for method in METHODS},
            "validGridPoints": count,
        }
    return result


def source_lookup(data_root: Path, source_products: Path | None = None):
    """Use an exact frozen manifest, or the established backend file resolver."""
    lookup = {}
    if source_products is not None:
        records = json.loads(source_products.read_text(encoding="utf-8"))
        for record in records:
            if record.get("run", 1) != 1:
                continue
            path = Path(record["path"])
            text = str(path).replace("\\", "/")
            model = "ASTGRN" if "Dataset-AGCRN/" in text else (
                "STDN" if "Dataset-STDN/" in text else "LSTM")
            if not path.is_absolute():
                path = data_root / path
            kind = "prediction" if path.name.endswith("_predict2.npy") else (
                "truth" if path.name.endswith("_real2.npy") else None)
            if kind is None:
                continue
            key = model, int(record["pre"]), int(record["year"]), kind
            if key in lookup:
                raise ValueError(f"Duplicate source product: {key}")
            lookup[key] = path
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        from real_data import dataset_file_path
        for model in MODELS:
            for pre in CONFIGURATIONS:
                for year in YEARS:
                    for kind, suffix in (("prediction", "predict2"), ("truth", "real2")):
                        lookup[model, pre, year, kind] = Path(dataset_file_path(
                            str(data_root / DATA_FOLDERS[model]), pre, year, 1, suffix))
    expected = {(model, pre, year, kind) for model in MODELS for pre in CONFIGURATIONS
                for year in YEARS for kind in ("prediction", "truth")}
    missing = expected - lookup.keys()
    if missing:
        raise ValueError(f"Source registry missing {len(missing)} products, e.g. {sorted(missing)[0]}")
    for key in sorted(expected):
        if not lookup[key].is_file():
            raise FileNotFoundError(f"Missing source product {key}: {lookup[key]}")
    return {key: lookup[key] for key in sorted(expected)}


def load_product(path):
    array = np.load(path, mmap_mode="r", allow_pickle=False)
    if array.shape != SHAPE:
        raise ValueError(f"Expected array shape {SHAPE}, received {array.shape}: {path}")
    return np.asarray(array, dtype=np.float64).reshape(-1, SHAPE[-1])


def regression_error(regions, regression_file: Path) -> float:
    frozen = json.loads(regression_file.read_text(encoding="utf-8"))
    region_names = {"eastasia": "East Asia", "focus": "Focus region"}
    method_names = {**{model: model for model in MODELS},
                    "reference": "Other-year same-position mean"}
    maximum = 0.0
    for region in regions:
        point_lookup = {(point["year"], point["pre"]): point for point in region["points"]}
        for method in METHODS:
            expected = frozen["regions"][region_names[region["id"]]][method_names[method]]["annual_mean_grid_r"]
            actual = [np.mean([point_lookup[year, pre][method] for pre in range(1, 8)])
                      for year in YEARS]
            maximum = max(maximum, float(np.max(np.abs(np.asarray(actual) - expected))))
    if maximum > 1e-12:
        raise ValueError(f"Approved pre1–pre7 figure changed: max absolute error {maximum:.17g}")
    return maximum


def build_dataset(data_root, source_products=None, regression_file=None):
    lookup = source_lookup(Path(data_root), source_products)
    truths = np.stack([load_product(lookup["LSTM", 7, year, "truth"]) for year in YEARS])
    references = held_out_reference(truths)
    focus = np.zeros(SHAPE[:2], dtype=bool)
    focus[12:29, 48:85] = True
    masks = {"eastasia": np.ones(SHAPE[0] * SHAPE[1], dtype=bool), "focus": focus.reshape(-1)}
    regions = [{"id": region, "label": label, "points": []} for region, label in (
        ("eastasia", "East Asia"), ("focus", "Focus region"))]
    hashes = {}
    for i, year in enumerate(YEARS):
        for pre in CONFIGURATIONS:
            predictions = {"reference": references[i]}
            for model in MODELS:
                for kind in ("prediction", "truth"):
                    key = model, pre, year, kind
                    path = lookup[key]
                    hashes[key] = sha256_file(path)
                    array = load_product(path)
                    if kind == "truth":
                        assert_same_truth(array, truths[i], f"{model}/pre{pre}/{year}")
                    else:
                        predictions[model] = array
            summaries = summarize_regions(truths[i], predictions, masks)
            for region in regions:
                region["points"].append({"year": year, "pre": pre, **summaries[region["id"]]})
        print(f"Scored {year}: 20/20 configurations; all stored truths agree", flush=True)
    ledger = "".join(f"{model}/pre{pre}/{year}/{kind} {hashes[model, pre, year, kind]}\n"
                     for model, pre, year, kind in sorted(hashes))
    source = {
        "productCount": len(hashes),
        "productsSha256": hashlib.sha256(ledger.encode("utf-8")).hexdigest(),
        "productsHashDefinition": "SHA256 of sorted model/pre/year/kind and raw-file SHA256 ledger; no machine paths",
        "referenceTruthSha256": hashlib.sha256(memoryview(truths).cast("B")).hexdigest(),
        "truthTolerance": {"rtol": 1e-6, "atol": 1e-5, "equalNaN": True},
        "referenceTruthConfiguration": 7,
    }
    if regression_file is not None:
        source["approvedFigureSha256"] = sha256_file(regression_file)
        source["approvedFigureMaxAbsoluteError"] = regression_error(regions, regression_file)
    return {
        "schemaVersion": 1, "years": list(YEARS), "configurations": list(CONFIGURATIONS),
        "methods": list(METHODS), "sampleCount": SHAPE[-1], "casesPerRegion": 400, "run": 1,
        "referenceDefinition": REFERENCE_DEFINITION, "aggregation": AGGREGATION,
        "source": source, "regions": regions,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Parent of Dataset/, Dataset-AGCRN/ and Dataset-STDN/")
    parser.add_argument("--source-products", type=Path,
                        help="Optional exact product registry; relative paths resolve under --data-root")
    parser.add_argument("--original-regression-file", type=Path,
                        help="Optional frozen diagnostic_140case.json; abort if approved values drift")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1]
                        / "frontend/src/data/annualModelComparison.json")
    args = parser.parse_args()
    dataset = build_dataset(args.data_root, args.source_products, args.original_regression_file)
    content = (json.dumps(dataset, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(content)
    print(json.dumps({"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                      "source": dataset["source"]}, indent=2))


if __name__ == "__main__":
    main()
