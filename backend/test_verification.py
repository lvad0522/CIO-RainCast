"""Portable numerical checks that do not require the research datasets."""
import numpy as np
import pytest

import verification as V


@pytest.mark.parametrize("sign", [1, -1])
def test_perfect_correlation_keeps_its_sign(sign):
    truth = np.random.default_rng(2026).normal(size=(4, 5, 112))
    np.testing.assert_allclose(V.pearson_map(sign * truth, truth), sign)


def test_constant_or_missing_grid_points_have_undefined_correlation():
    truth = np.random.default_rng(2026).normal(size=(4, 5, 112))
    prediction = truth.copy()
    prediction[0, 0] = 2
    truth[1, 1, 6] = np.nan
    result = V.pearson_map(prediction, truth)
    assert np.isnan(result[0, 0])
    assert np.isnan(result[1, 1])
    assert result[2, 3] == pytest.approx(1)


def test_shape_mismatch_does_not_silently_pair_samples():
    with pytest.raises(ValueError):
        V.pearson_map(np.zeros((4, 5, 10)), np.zeros((4, 5, 112)))


def test_significance_thresholds_for_the_112_step_window():
    thresholds = [V.critical_r(112, level) for level in (.90, .95, .99)]
    assert thresholds == pytest.approx([.1562, .1857, .2425], abs=5e-5)
    assert thresholds[0] < thresholds[1] < thresholds[2]


def test_truth_lookup_requires_consistent_observations(tmp_path, monkeypatch):
    monkeypatch.setenv("TRUTH_DIR", str(tmp_path))
    assert V.find_truth("pre1", 2001) is None
    folder = tmp_path / "pre1/2001"
    folder.mkdir(parents=True)
    np.save(folder / "a_real2.npy", np.arange(8))
    np.save(folder / "b_real2.npy", np.arange(8))
    assert V.find_truth("pre1", 2001) is not None
    np.save(folder / "b_real2.npy", np.arange(8) + 1)
    with pytest.raises(ValueError):
        V.find_truth("pre1", 2001)
