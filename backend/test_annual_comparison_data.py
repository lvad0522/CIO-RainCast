"""Scientific contracts for the small static annual-comparison product."""
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

_path = Path(__file__).resolve().parents[1] / "scripts/build_annual_comparison.py"
_spec = importlib.util.spec_from_file_location("annual_comparison_builder", _path)
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)


def test_reference_excludes_evaluated_year_at_each_retained_position():
    truths = np.asarray([[[1., 4., 2.], [2., 5., 1.]],
                         [[7., 9., 3.], [8., 1., 6.]],
                         [[3., 2., 8.], [7., 3., 4.]]])
    reference = A.held_out_reference(truths)
    np.testing.assert_allclose(reference[0], (truths[1] + truths[2]) / 2)
    np.testing.assert_allclose(reference[2], (truths[0] + truths[1]) / 2)
    changed = truths.copy()
    changed[0] += 1234
    np.testing.assert_allclose(A.held_out_reference(changed)[0], reference[0])
    assert not np.array_equal(reference[0], truths.mean(axis=0))


def test_every_method_uses_identical_complete_nonconstant_gridpoints():
    truth = np.tile(np.arange(4, dtype=float), (5, 1))
    predictions = {method: truth.copy() for method in A.METHODS}
    # Different methods invalidate different points. Even one missing sample
    # excludes its entire point, rather than shortening that point's series.
    predictions["LSTM"][0, 0] = np.nan
    predictions["ASTGRN"][1] = 1
    predictions["reference"][2] = 0
    truth[3] = 3
    predictions["STDN"][4] *= -1
    correlations, paired = A.strict_correlations(truth, predictions)
    np.testing.assert_array_equal(paired, [False, False, False, False, True])
    summary = A.summarize_regions(truth, predictions, {"test": np.ones(5, dtype=bool)})["test"]
    assert summary["validGridPoints"] == 1
    assert summary["LSTM"] == pytest.approx(1)
    assert summary["ASTGRN"] == pytest.approx(1)
    assert summary["reference"] == pytest.approx(1)
    assert summary["STDN"] == pytest.approx(-1)


@pytest.mark.parametrize("bad", [np.zeros((2, 4)), np.full((2, 4), np.nan)])
def test_undefined_region_fails_instead_of_fabricating_a_score(bad):
    truth = np.tile(np.arange(4, dtype=float), (2, 1))
    predictions = {method: truth.copy() for method in A.METHODS}
    predictions["reference"] = bad
    with pytest.raises(ValueError, match="no common"):
        A.summarize_regions(truth, predictions, {"test": np.ones(2, dtype=bool)})


def test_stored_truth_mismatch_fails_but_float32_rounding_is_accepted():
    truth = np.asarray([[1.234567891, 0., 2.345678912, np.nan]])
    A.assert_same_truth(truth.astype(np.float32), truth, "rounded")
    mismatch = truth.copy()
    mismatch[0, 1] = .01
    with pytest.raises(ValueError, match="differs"):
        A.assert_same_truth(mismatch, truth, "different")
    with pytest.raises(ValueError, match="different shape"):
        A.assert_same_truth(truth[:, :2], truth, "truncated")


def test_shapes_and_missing_methods_cannot_silently_change_pairing():
    truth = np.tile(np.arange(4, dtype=float), (2, 1))
    predictions = {method: truth.copy() for method in A.METHODS}
    predictions.pop("STDN")
    with pytest.raises(ValueError, match="All three"):
        A.strict_correlations(truth, predictions)
    predictions["STDN"] = truth[:, :2]
    with pytest.raises(ValueError, match="shapes differ"):
        A.strict_correlations(truth, predictions)


def test_source_registry_requires_all400_cases_and_exact_files(tmp_path):
    empty = tmp_path / "registry.json"
    empty.write_text(json.dumps([]), encoding="utf-8")
    with pytest.raises(ValueError, match="missing 2400 products"):
        A.source_lookup(tmp_path, empty)


def test_heldout_reference_requires_multiple_years():
    with pytest.raises(ValueError, match="At least two"):
        A.held_out_reference(np.ones((1, 2, 4)))


def test_approved_figure_regression_gate_detects_changed_annual_values(tmp_path):
    methods = {method: {"annual_mean_grid_r": [.2] * 20} for method in (
        "LSTM", "ASTGRN", "STDN", "Other-year same-position mean")}
    frozen = tmp_path / "approved.json"
    frozen.write_text(json.dumps({"regions": {"East Asia": methods,
                                              "Focus region": methods}}), encoding="utf-8")
    regions = [{"id": region, "points": [
        {"year": year, "pre": pre, **{method: .2 for method in A.METHODS}}
        for year in A.YEARS for pre in range(1, 8)]}
        for region in ("eastasia", "focus")]
    assert A.regression_error(regions, frozen) < 1e-12
    regions[1]["points"][0]["STDN"] += .01
    with pytest.raises(ValueError, match="Approved pre1–pre7 figure changed"):
        A.regression_error(regions, frozen)


def test_published_product_covers_all_configurations_without_raw_data_or_paths():
    path = Path(__file__).resolve().parents[1] / "frontend/src/data/annualModelComparison.json"
    product = json.loads(path.read_text(encoding="utf-8"))
    assert product["sampleCount"] == 112
    assert product["casesPerRegion"] == 400
    assert product["run"] == 1
    assert product["source"]["productCount"] == 2400
    expected = {(year, pre) for year in A.YEARS for pre in A.CONFIGURATIONS}
    assert {region["id"] for region in product["regions"]} == {"eastasia", "focus"}
    for region in product["regions"]:
        assert len(region["points"]) == 400
        assert {(point["year"], point["pre"]) for point in region["points"]} == expected
        for point in region["points"]:
            assert 0 < point["validGridPoints"] <= (629 if region["id"] == "focus" else 8181)
            assert all(np.isfinite(point[method]) and -1 <= point[method] <= 1
                       for method in A.METHODS)
    serialized = path.read_text(encoding="utf-8")
    assert "D:\\" not in serialized and ".npy" not in serialized
