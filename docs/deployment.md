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

## Static demo site

The public demo at <https://lvad0522.github.io/CIO-RainCast/> is a pure static site: the built frontend reads every `/api/*` response from pre-baked files and no backend, dataset, or model checkpoint is deployed. The mapping lives in `frontend/src/staticMode.js` and is only active in a build made with `VITE_STATIC_MODE=1`.

### Bake the demo data

Run this from a checkout that has the research assets installed ([Data setup](data-setup.md)) and the prepared projection cache:

```bash
python scripts/bake_demo_data.py
```

The script replays the requests the interface makes against the real backend through an in-process test client, then splits the result into two layers:

| Layer | Where | Contents | Size |
| --- | --- | --- | --- |
| Repository layer | `frontend/public/demo-data/` (committed) | `manifest.json`, every lightweight response (run summary, CIO panels, model comparison, focus-region cards and CSV) for **all 400** year × lead combinations, the shared CIO files, the test fixtures, and the opening case's heavy payload (2000, 20-day lead: arrays, daily frames, input pool) with the projection weights every frame needs | ~86 MB |
| External layer | `--remote-out` (default `tmp/demo-data-remote/`, **not** committed) | the remaining heavy binaries: per-case prediction/observation float32 arrays, the per-case daily projection bundle, and the shared per-year U850 input pools | ~2.0 GB |

Manifest paths that live in the external layer carry a `remote:` prefix; the frontend resolves them against `manifest.remoteBase`, everything else against `demo-data/`. Every case in the manifest ships the full heavy layer, so the whole year × lead grid has daily playback, grid-point series, and the evaluation panel. The opening case (`--inline-cases`, default `2000-pre20`) is deliberately served by the repository layer instead, so the page a visitor lands on is complete even when the dataset host is unreachable; `--inline-cases ""` disables the pass (nothing new is inlined — it does not un-inline what an earlier bake already copied).

Before writing the heavy layer the bake verifies its pooling assumptions across every case (the U850 input field of a given calendar day must be byte-identical between cases; the projection weights must be identical everywhere) and refuses to continue otherwise. It ends with a self-check: sampled API responses are compared field by field against the client-side rebuild formulas in `frontend/src/utils/staticRebuild.js` — the same formulas `frontend/test/staticData.test.js` replays from the baked fixtures. A failing self-check fails the bake.

Useful flags: `--out <dir>`, `--remote-out <dir>`, `--remote-base <url>` (default `https://huggingface.co/datasets/Anthony1919826/CIO-RainCast-demo-data/resolve/main/`), `--inline-cases <list>` (cases whose heavy payload is committed with the site; default `2000-pre20`), `--reuse-light` (keep the committed layer and only rebuild the heavy layer), `--limit 1` (smoke test), `--light-only`, `--heavy-only`, `--frame-precision f64`, `--cleanup-legacy`.

### Publish the external layer

The heavy layer is hosted on Hugging Face (default repository `Anthony1919826/CIO-RainCast-demo-data`, the account the published `manifest.json` points at):

```bash
pip install huggingface_hub
hf auth login --token hf_xxx                  # or export HF_TOKEN; huggingface_hub < 1: huggingface-cli login
python scripts/upload_demo_data.py --dry-run  # check the manifest against the folder
python scripts/upload_demo_data.py            # upload (resumable; re-run to continue)
python scripts/upload_demo_data.py --verify   # download a sample back over HTTPS
```

Uploading is a one-time step per data change. `--proxy http://127.0.0.1:10808` is available when huggingface.co needs a local proxy; such runs also set `HF_HUB_DISABLE_XET=1`, because through a local proxy the hf-xet transfer path was observed to stall (a 2 GB layer moved a few kilobytes in under an hour) while the classic requests-based path sustained roughly a megabyte per second — set `HF_HUB_DISABLE_XET=0` to override. If the dataset repository lives under another account or name, pass `--repo <owner>/<name> --write-manifest` so `manifest.json` points at it (or re-bake with `--remote-base`). Note that the dataset host is reached from the visitor's browser: a viewer who cannot reach huggingface.co still gets the opening case in full (it ships with the site), while the cases that need the host show its lightweight layer plus a readable "dataset host unreachable" error — never a blank page.

### Build and preview

```bash
cd frontend
VITE_STATIC_MODE=1 npm run build
```

`VITE_STATIC_MODE=1` and `VITE_API_BASE` are mutually exclusive; the build fails if both are set. To preview the way GitHub Pages serves the site (project subpath), serve the build from a parent directory named after the repository:

```bash
mkdir -p /tmp/CIO-RainCast && cp -r dist/. /tmp/CIO-RainCast/
cd /tmp && python -m http.server 8010
# open http://127.0.0.1:8010/CIO-RainCast/
```

### Check the built site

Open the URL above with the browser's network panel visible and walk through the interface:

1. the intro animation finishes (or is skipped) and the default case (2000, 20-day lead) renders sections 01–03;
2. the projection-date slider moves the day and the summary numbers follow it;
3. clicking a grid point in section 03 updates the time-series label and correlation;
4. the evaluation panel switches between Prediction / Observation / Error and downloads the focus-region CSV;
5. switching to another year and lead re-renders without an error banner.

Two things should hold on the wire: no request goes to `/api/*` (the shim answers every one of them inside the page), and the heavy payloads for the opening case come from the site itself while the other cases' come from the dataset host named in `manifest.remoteBase`; the small JSON, the shared CIO files and the CSV exports always come from the site. `npm test` additionally replays the baked fixtures through the rebuild formulas, so a drift between the bake and the browser-side math fails the test suite rather than silently changing the numbers on the site.

The opening case is deliberately independent of the dataset host: with huggingface.co unreachable it still renders sections 01–03 in full (daily frames, grid-point series, evaluation panel); only the cases that need the host fall back to their lightweight layer plus the error note. `frontend/test/staticData.test.js` pins that property (it also pins the volume policy: every other case must stay on the host and out of the commit), and `--inline-cases` decides which cases the repository layer carries.

### GitHub Pages deployment

`.github/workflows/pages.yml` builds with `VITE_STATIC_MODE=1` and publishes `frontend/dist` on every push to `main` (or a manual run). One-time repository setting: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is then served at `https://<owner>.github.io/CIO-RainCast/`; the frontend uses a relative Vite `base`, so no path configuration is required.

The baked lightweight files under `frontend/public/demo-data/` are committed to the repository as frontend demo assets — the single exception to the "large scientific assets stay out of Git" rule in [Repository organization](repository-design.md). That commit also carries the opening case's heavy payload and the shared projection weights (~9 MB), because the first page a visitor sees must not depend on an external host. The rest of the heavy layer stays out of Git exactly like the datasets and checkpoints; it is published as a separate Hugging Face dataset. After changing the bake, re-run the bake, commit the repository layer, and re-upload the heavy layer.

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
