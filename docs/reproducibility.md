# Reproducibility and numerical scope

## Predictor and projection diagnostics

The implemented predictor uses U850 anomalies over 20°S–20°N, 40°E–120°E. It applies the historical preprocessing and the U850 portion of the stored projection vector. The reference paper defines the coupled CIO mode using SST and U850; this demonstration exposes its U850-only projection path and does not implement an SST projection branch.

`cioproj.py` preserves the preprocessing associated with the stored forecast products, including the historical latitude-axis high-pass operation and Fortran-order flattening. Replacing the spatial filter with a temporal filter, changing coordinate order, or estimating a new EOF changes the predictor. Such a change requires separate scientific validation and compatible forecast products.

Daily grid contribution is the preprocessed field multiplied by the actual calculation weights. Summing these contributions reconstructs the projected CIO value. The closure card verifies this numerical decomposition using a tolerance; it is not an independent physical validation or an estimate of prediction uncertainty.

The stored `mode_U` EOF1 map is a spatial reference. Its arrangement differs from the historical calculation weights used by the contribution map. It should not be read as a direct visualization of those calculation weights.

The 112-day contribution summary averages the absolute daily grid contributions, showing contribution magnitude rather than signed accumulation.

## Stored forecasts and metrics

The demonstration reads existing ASTGRN rainfall products. The corresponding training implementation and checkpoints are outside this repository. The retained optional online inference routes are for the legacy LSTM models.

The skill map uses the selected stored correlation product. The annual comparison uses the frozen per-case scores in `frontend/src/data/annualModelComparison.json`, computed from the forecast and observation arrays:

- The data cover 2000–2019 and pre1–pre20: 400 cases for each region, using stored run 1.
- The other-year reference averages the processed observations from the other 19 years at each grid point and retained target position, excluding the evaluation year. It is an observation reference for retrospective comparison.
- Each case uses the same grid points for all four methods. Observations, all three model predictions, and the reference must be finite and have nonzero variance across the complete 112-sample sequence at those points.
- A single-configuration view shows that configuration's mean grid-point temporal Pearson correlation for each year. An averaging range gives equal weight to its configuration-specific scores within each year; it does not average prediction fields before calculating correlation.
- The default pre1–pre7 average reproduces the approved annual comparison figure. Selecting pre1–pre20 or a different range uses the corresponding stored scores.
- East Asia and the focus region have separate labeled axis ranges, each fixed across configuration changes. Legend visibility changes the plotted series; CSV exports retain all four methods for the selected configuration range.

These small statistics are bundled with the frontend, so the annual comparison works in both API-connected and static builds without downloading the large forecast arrays. The existing `/api/model-comparison` endpoint remains available for per-case three-model metrics; it uses its original shared-finite-sample definition and is separate from these annual panels.

To rebuild the bundled statistics from the three dataset trees described in [Data setup](data-setup.md), run from the repository root:

```bash
python scripts/build_annual_comparison.py --data-root /path/to/research-data
```

The builder checks observation consistency across models and configurations and records source hashes. Use `--source-products` for an explicit product registry and `--original-regression-file` to verify the pre1–pre7 results against the frozen figure data.

The training setups differ. This is a comparison of prediction methods sharing the CIO signal, not a controlled architecture ablation or an experiment isolating the contribution of CIO. The S2S panel is also not a CIO-input ablation.

Focus-region area-mean time-series metrics and mean grid-point correlations are different statistics. The UI reports both with separate labels.

## Rainfall color scales

The default prediction map uses the largest finite absolute anomaly across its entire 112-step prediction array for the selected year, lead, and run. Observation uses the equivalent full-window observation limit. The symmetric limits stay fixed while changing dates and are recomputed for a different case. The hidden optional shared-scale control uses the maximum across both prediction and observation arrays. Error maps retain a fixed ±50 mm/day scale.

The field range above a map is its actual daily minimum and maximum, not its color-scale endpoints.

## Availability and test scope

The unit tests use constructed arrays and temporary input files to exercise metric definitions, missing values, dates, projection diagnostics, and cache restoration. They verify the code's numerical behavior without redistributing the research assets. Passing them does not reproduce the full research experiments.

A complete demonstration requires the forecast arrays and validated projection caches described in [Data setup](data-setup.md). Real S2S comparisons require the separate 2003 correlation files; legacy fallback rows marked `source: "mock"` are not research results.
