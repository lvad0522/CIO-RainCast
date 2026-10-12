# Reproducibility and numerical scope

## Predictor and projection diagnostics

The implemented predictor uses U850 anomalies over 20°S–20°N, 40°E–120°E. It applies the historical preprocessing and the U850 portion of the stored projection vector. The reference paper defines the coupled CIO mode using SST and U850; this demonstration exposes its U850-only projection path and does not implement an SST projection branch.

`cioproj.py` preserves the preprocessing associated with the stored forecast products, including the historical latitude-axis high-pass operation and Fortran-order flattening. Replacing the spatial filter with a temporal filter, changing coordinate order, or estimating a new EOF changes the predictor. Such a change requires separate scientific validation and compatible forecast products.

Daily grid contribution is the preprocessed field multiplied by the actual calculation weights. Summing these contributions reconstructs the projected CIO value. The closure card verifies this numerical decomposition using a tolerance; it is not an independent physical validation or an estimate of prediction uncertainty.

The stored `mode_U` EOF1 map is a spatial reference. Its arrangement differs from the historical calculation weights used by the contribution map. It should not be read as a direct visualization of those calculation weights.

The 112-day contribution summary averages the absolute daily grid contributions, showing contribution magnitude rather than signed accumulation.

## Stored forecasts and metrics

The demonstration reads existing ASTGRN rainfall products. The corresponding training implementation and checkpoints are outside this repository. The retained optional online inference routes are for the legacy LSTM models.

The skill map uses the selected stored correlation product. The paired LSTM–ASTGRN module recomputes correlations from forecast and observation arrays instead of selecting values from legacy correlation channels:

- Both methods use stored run 1 and must have compatible observations.
- A grid-point Pearson correlation uses shared finite time samples. The regional summary averages the grid points where both methods have defined correlations.
- RMSE and MAE pool common finite grid-point/time pairs in the selected region.
- Across-year correlation curves give each available paired year equal weight.
- The displayed difference is ASTGRN minus LSTM.

The two training setups differ. This is a comparison of prediction methods sharing the CIO signal, not a controlled architecture ablation or an experiment isolating the contribution of CIO. The S2S panel is also not a CIO-input ablation.

Focus-region area-mean time-series metrics and mean grid-point correlations are different statistics. The UI reports both with separate labels.

## Rainfall color scales

The default prediction map uses the largest finite absolute anomaly across its entire 112-step prediction array for the selected year, lead, and run. Observation uses the equivalent full-window observation limit. The symmetric limits stay fixed while changing dates and are recomputed for a different case. The hidden optional shared-scale control uses the maximum across both prediction and observation arrays. Error maps retain a fixed ±50 mm/day scale.

The field range above a map is its actual daily minimum and maximum, not its color-scale endpoints.

## Availability and test scope

The unit tests use constructed arrays and temporary input files to exercise metric definitions, missing values, dates, projection diagnostics, and cache restoration. They verify the code's numerical behavior without redistributing the research assets. Passing them does not reproduce the full research experiments.

A complete demonstration requires the forecast arrays and validated projection caches described in [Data setup](data-setup.md). Real S2S comparisons require the separate 2003 correlation files; legacy fallback rows marked `source: "mock"` are not research results.
