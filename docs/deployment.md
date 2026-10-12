# Running and building the application

## Local development

`python start.py` starts a loopback-only FastAPI server on port 8000 and a Vite server on port 5173. Both processes stop when the launcher is interrupted. Select other ports with:

```bash
python start.py --backend-port 8002 --frontend-port 5177
```

For manual frontend startup against another backend, specify its API URL:

```bash
# Linux/macOS
VITE_API_BASE=http://127.0.0.1:8002 npm run dev -- --port 5177 --strictPort
```

```powershell
# PowerShell, from frontend/
$env:VITE_API_BASE = 'http://127.0.0.1:8002'
npm run dev -- --port 5177 --strictPort
```

## Production frontend build

The Vite configuration requires `VITE_API_BASE` during a production build. From `frontend/`:

```bash
VITE_API_BASE=http://127.0.0.1:8000 npm run build
```

```powershell
$env:VITE_API_BASE = 'http://127.0.0.1:8000'
npm run build
```

Alternatively, copy `.env.example` to `.env.local` and set the API address there. These local configuration files are ignored by Git. Vite embeds the URL in the built frontend; a deployed site must use the API address reachable from the visitor's browser. Serve `frontend/dist/` with a static web server. Vite's preview server is intended for checking builds locally.

## Backend configuration

| Variable | Purpose |
| --- | --- |
| `DATA_ROOT` | Historical forecast tree; default is root `Dataset-AGCRN/` |
| `DATA_FAMILY` | Model label; default `ASTGRN` |
| `DISPLAY_MODE` | `fold1` by default; `foldmax` is retained for diagnostic comparisons |
| `CIOPROJ_MAT` | Absolute path to projection constants, if outside `backend/assets/` |
| `CHAIN_JOB_ROOT` | Prepared projection-cache location |
| `MODEL_ROOTS` | Optional online LSTM checkpoint roots, separated by the platform path separator |
| `MODEL_ARCHIVE` | Optional frozen online LSTM checkpoint archive |
| `MODEL_PREWARM` | Set to `0` for historical exploration without background checkpoint scanning |

The default public-facing evaluation should use `fold1`. A grid-wise maximum across folds does not describe any single trained run. The paired model-comparison API always uses run 1 regardless of this display setting.

The backend includes upload and optional inference routes and currently allows broad CORS for development. Configure access control, request limits, and allowed origins before exposing it beyond a controlled demonstration environment. Keep datasets and checkpoints outside the static frontend directory.
