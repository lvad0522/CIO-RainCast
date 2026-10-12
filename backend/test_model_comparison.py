import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import model_comparison as C
import real_data as D


@pytest.fixture(autouse=True)
def tiny_case(monkeypatch):
    monkeypatch.setattr(C, "SHAPE", (2, 2, 4))
    monkeypatch.setattr(C, "REGIONS", {"focus": (slice(None), slice(None), "Test focus"),
                                       "eastasia": (slice(None), slice(None), "Test domain")})
    C._cached_case.cache_clear()
    yield
    C._cached_case.cache_clear()


def fields():
    truth = np.broadcast_to(np.arange(4, dtype=float), C.SHAPE).copy()
    return truth + 1, truth, truth + 2, truth.copy()


def save_case(root, year, lead, prediction, truth, malformed=False, pre7_new=False):
    folder = root / ("pre7-new" if pre7_new else f"pre{lead}") / str(year)
    folder.mkdir(parents=True, exist_ok=True)
    for kind, values in (("predict2", prediction), ("real2", truth)):
        middle = f"{year}1)" if malformed and kind == "predict2" else f"{year}(1)"
        path = folder / f"pre_{lead}_{middle}_20_40_100_125_0.25_{kind}.npy"
        np.save(path, values)


def test_explicit_sources_do_not_use_global_root_or_display_cache(monkeypatch, tmp_path):
    roots = {"LSTM": tmp_path / "lstm", "ASTGRN": tmp_path / "astgrn"}
    lp, truth, ap, at = fields()
    for model, prediction in (("LSTM", lp), ("ASTGRN", ap)):
        save_case(roots[model], 2001, 1, prediction, truth)
    monkeypatch.setattr(C, "DATA_ROOTS", roots)
    monkeypatch.setattr(D, "DATA_ROOT", str(tmp_path / "not-a-dataset"))
    monkeypatch.setattr(D, "DISPLAY_MODE", "foldmax")
    monkeypatch.setattr(D, "_load_npy", lambda *args: pytest.fail("legacy cache must not be used"))
    before = dict(D._cache._data)
    summary = C.case_summary(2001, 1, "focus")
    assert summary["rows"][0]["rmse"] == pytest.approx(1)
    assert summary["rows"][1]["rmse"] == pytest.approx(2)
    assert D.DATA_ROOT.endswith("not-a-dataset")
    assert D.DISPLAY_MODE == "foldmax"
    assert D._cache._data == before


def test_repaired_pre7_and_second_prediction_take_priority(tmp_path):
    lp, truth, _, _ = fields()
    save_case(tmp_path, 2001, 7, lp + 100, truth)
    save_case(tmp_path, 2001, 7, lp, truth, pre7_new=True)
    assert "pre7-new" in D.dataset_file_path(str(tmp_path), 7, 2001, 1, "predict2")
    save_case(tmp_path, 2001, 3, lp + 100, truth)
    save_case(tmp_path, 2001, 3, lp, truth, malformed=True)
    selected = D.dataset_file_path(str(tmp_path), 3, 2001, 1, "predict2")
    assert "20011)" in selected
    np.testing.assert_array_equal(np.load(selected), lp)
    clean_root = tmp_path / "clean"
    save_case(clean_root, 2001, 7, lp, truth)
    assert "pre7-new" not in D.dataset_file_path(str(clean_root), 7, 2001, 1, "predict2")


def test_shared_finite_samples_and_common_defined_gridpoints():
    lp, truth, ap, at = fields()
    # Exclude one constant-prediction point from both correlation averages.
    ap[0, 0] = 2
    # Remove the same sample from both models even though only LSTM is missing.
    lp[0, 1, 0] = np.nan
    ap[0, 1, 0] = 999
    summary = C.summarize_arrays(lp, truth, ap, at, "focus")
    assert summary["validGridPoints"] == 3
    assert summary["validSamplePairs"] == 15
    assert summary["sampleCount"] == 4
    assert summary["rows"][0]["meanGridR"] == pytest.approx(1)
    assert summary["rows"][1]["meanGridR"] == pytest.approx(1)
    shared = np.isfinite(lp) & np.isfinite(ap)
    for row, pred in zip(summary["rows"], (lp, ap)):
        error = pred[shared] - truth[shared]
        assert row["rmse"] == pytest.approx(np.sqrt(np.mean(error ** 2)))
        assert row["mae"] == pytest.approx(np.mean(np.abs(error)))


def test_undefined_correlations_and_empty_values_are_null():
    lp, truth, ap, at = fields()
    lp[:] = 2
    summary = C.summarize_arrays(lp, truth, ap, at, "focus")
    assert summary["validGridPoints"] == 0
    assert all(row["meanGridR"] is None for row in summary["rows"])
    lp[:] = np.nan
    summary = C.summarize_arrays(lp, truth, ap, at, "focus")
    assert summary["validSamplePairs"] == 0
    assert all(row["rmse"] is None and row["mae"] is None for row in summary["rows"])


def test_truth_tolerance_and_mismatch():
    lp, truth, ap, at = fields()
    at += 1e-6
    assert C.summarize_arrays(lp, truth, ap, at, "focus")["rows"][1]["rmse"] == pytest.approx(2)
    at[0, 0, 0] += .1
    with pytest.raises(HTTPException) as error:
        C.summarize_arrays(lp, truth, ap, at, "focus")
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        C.summarize_arrays(lp[:, :, :2], truth, ap, truth, "focus")
    assert error.value.status_code == 422


def stub_summary(a, b):
    return {"rows": [{"model": "LSTM", "meanGridR": a, "rmse": 2, "mae": 1, "fold": 1},
                     {"model": "ASTGRN", "meanGridR": b, "rmse": 1, "mae": .5, "fold": 1}],
            "sampleCount": 4, "validGridPoints": 4, "regionGridPoints": 4,
            "validSamplePairs": 16, "validTimeSteps": 4}


def test_equal_year_weight_curve_and_selected_case_rows(monkeypatch):
    monkeypatch.setattr(C, "YEARS", (2000, 2001))
    def case(year, lead, region):
        result = stub_summary(.2 if year == 2000 else .6, .4 if year == 2000 else .8)
        result["validGridPoints"] = 1 if year == 2000 else 4
        return result
    monkeypatch.setattr(C, "case_summary", case)
    result = C.comparison(2001, 7, "focus", "all")
    assert result["curve"][0]["LSTM"] == pytest.approx(.4)
    assert result["curve"][0]["ASTGRN"] == pytest.approx(.6)
    assert result["rows"][0]["meanGridR"] == .6
    assert result["delta"]["meanGridR"] == pytest.approx(.2)
    assert result["delta"]["rmse"] == -1
    assert result["coverage"]["availableCases"] == 40


def test_missing_current_case_errors_and_partial_curve_is_null(monkeypatch):
    def case(year, lead, region):
        if lead == 2:
            raise HTTPException(404, "missing run 1")
        return stub_summary(.2, .4)
    monkeypatch.setattr(C, "case_summary", case)
    with pytest.raises(HTTPException) as error:
        C.comparison(2001, 2)
    assert error.value.status_code == 404
    result = C.comparison(2001, 1)
    assert result["curve"][1] == {"lead": 2, "LSTM": None, "ASTGRN": None}
    assert result["coverage"]["availableCases"] == 19
    assert result["coverage"]["missing"][0]["lead"] == 2


def test_undefined_case_is_not_counted_as_available_curve_evidence(monkeypatch):
    def case(year, lead, region):
        return stub_summary(None, None) if lead == 2 else stub_summary(.2, .4)
    monkeypatch.setattr(C, "case_summary", case)
    result = C.comparison(2001, 1)
    assert result["coverage"]["availableCases"] == 19
    assert result["coverage"]["byLead"][1]["availableYears"] == 0
    assert result["coverage"]["missing"][0]["status"] == "undefined"
    assert result["curve"][1] == {"lead": 2, "LSTM": None, "ASTGRN": None}


def test_missing_file_and_cache_revision(monkeypatch, tmp_path):
    roots = {"LSTM": tmp_path / "lstm", "ASTGRN": tmp_path / "astgrn"}
    monkeypatch.setattr(C, "DATA_ROOTS", roots)
    with pytest.raises(HTTPException) as error:
        C.case_summary(2001, 1, "focus")
    assert error.value.status_code == 404
    lp, truth, ap, _ = fields()
    for model, pred in (("LSTM", lp), ("ASTGRN", ap)):
        save_case(roots[model], 2001, 1, pred, truth)
    assert C.case_summary(2001, 1, "focus")["rows"][0]["rmse"] == 1
    save_case(roots["LSTM"], 2001, 1, lp + 4, truth)
    assert C.case_summary(2001, 1, "focus")["rows"][0]["rmse"] == 5


@pytest.mark.parametrize("query", ["year=1999", "year=2020", "lead=0", "lead=21",
                                    "lead=pre1", "region=unknown", "scope=unknown"])
def test_http_parameter_validation(query):
    app = FastAPI()
    app.include_router(C.router)
    response = TestClient(app).get(f"/api/model-comparison?{query}")
    assert response.status_code == 422
