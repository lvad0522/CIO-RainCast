# Data setup

The repository contains code and local geographic assets. Forecast arrays, meteorological source files, projection constants, prepared caches, and model checkpoints are excluded from Git. Obtain the authorized research assets from the project maintainers; no public download endpoint is provided in this snapshot.

## 1. Historical rainfall products

Place the ASTGRN products in `Dataset-AGCRN/`. Rebuilding the annual comparison statistics or using the per-case comparison API also requires LSTM products in `Dataset/` and STDN products in `Dataset-STDN/` at the repository root. The displayed annual chart already includes its statistics with the frontend.

```text
Dataset-AGCRN/pre1/2001/
  pre_1_2001(1)_20_40_100_125_0.25_predict2.npy
  pre_1_2001(1)_20_40_100_125_0.25_real2.npy
  pre_1_2001(1)_20_40_100_125_0.25_pearson2.npy

Dataset/pre1/2001/
  pre_1_2001(1)_20_40_100_125_0.25_predict2.npy
  pre_1_2001(1)_20_40_100_125_0.25_real2.npy
  pre_1_2001(1)_20_40_100_125_0.25_pearson2.npy

Dataset-STDN/pre1/2001/
  pre_1_2001(1)_20_40_100_125_0.25_predict2.npy
  pre_1_2001(1)_20_40_100_125_0.25_real2.npy
```

| Array | Shape | Meaning |
| --- | --- | --- |
| `predict2` | `(81, 101, 112)` | Predicted rainfall anomalies, mm/day |
| `real2` | `(81, 101, 112)` | Observed rainfall anomalies, mm/day |
| `pearson2` | `(81, 101, 3)` | Historical correlation product; display uses channel 2 |

Repeat the layout for `pre1`–`pre20` and 2000–2019. The default application selects stored run 1. The original filenames and the `Dataset-AGCRN` directory name are preserved for compatibility. The loader also recognizes the historical LSTM `pre7-new` directory and legacy prediction filenames.

`DATA_ROOT` can select another historical tree. When changing it, also set `DATA_FAMILY` to the corresponding display name. Use absolute paths when starting from different working directories. The per-case comparison API reads the three named root directories independently of `DATA_ROOT`.

## 2. Projection constants and U850 inputs

Place `CIOmode_1982_2017.mat` in `backend/assets/`, or set `CIOPROJ_MAT` to an absolute path. The historical matrix `e` contains 6028 columns; the current U850-only calculation uses its final 3321 columns, together with `Umean` and `Ustd`. The stored spatial reference and reference series require the associated mode fields in this same asset.

Provide daily U850 anomaly NetCDF files with latitude, longitude, and date coordinates for 2000–2020, covering the dates needed by all selected leads. The adapter reads coordinates and calendars from metadata, extracts the CIO domain, and interpolates it onto the trained 41 × 81 grid. See [the input contract](../backend/u850_adapter.py) for accepted variable and coordinate names.

From the repository root, prepare the default first case:

```bash
python backend/precompute_default.py --raw-dir /absolute/path/to/U850 --leads 1 --years 2001
```

On Windows, use a path such as `D:/research/U850`. Each lead's projection uses all 21 input years even when a single target year is requested. To prepare all 400 target windows, omit `--leads` and `--years`.

Alternatively, install a validated prepared cache under:

```text
backend/uploads/chain_jobs/default-2001-pre1/
  default_state.json
  series.npy
  normalized_window.npy
  projection_preview.npz
  dates.json
  completeness.json
```

The default endpoint restores completed caches; missing or inconsistent caches return HTTP 503 and do not start a calculation. The current cache contract is defined in [default_cio.py](../backend/default_cio.py). Cache generation also prepares optional East Asian U850 diagnostics retained by the backend.

## 3. Optional S2S comparison

The retained 2003 S2S implementation reads `corr-2003.nc` and `corr-avg-2003.nc` from the root directory `新绘图资料/`. Its panel is currently commented out. The `corr` variables have shapes `(11, 20)` and `(20,)`. They are separate research assets, excluded by the NetCDF ignore rules.

The legacy S2S endpoint can return a generated fallback with `source: "mock"` when these assets are missing. Only `source: "dataset"` represents the research comparison. The separate per-case LSTM–ASTGRN–STDN API reports unavailable cases instead of substituting values; the displayed annual chart uses its bundled statistics.

## 4. Optional online LSTM inference

The active ASTGRN page uses historical predictions and needs no checkpoint files. The retained upload/inference backend supports the existing LSTM checkpoints, rather than online ASTGRN execution.

For that optional path, set `MODEL_ROOTS` to authorized checkpoint directories, or `MODEL_ARCHIVE` to the frozen checkpoint archive. A group contains one checkpoint per output grid point. Neither checkpoints nor their training pipeline are included here. Set `MODEL_PREWARM=0` to disable background checkpoint scanning when using only historical exploration.

## Check availability

```bash
python scripts/check_assets.py --year 2001 --lead 1
```

This checks the selected forecast files, array shapes, projection asset, and prepared cache. It prints optional comparison availability separately and exits with a nonzero status when required assets are missing. It does not download data or generate substitutes.
