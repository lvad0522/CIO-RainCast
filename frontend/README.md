# CIO-RainCast frontend

React / Vite interface for the CIO projection and historical rainfall demonstration. See the [project README](../README.md) for setup and [deployment instructions](../docs/deployment.md) for API configuration.

## Backend development

```bash
npm ci
npm run dev
npm run lint
npm test
```

Backend-connected production builds require `VITE_API_BASE`. The `public/geo` directory contains local coastlines and land data, so map rendering does not require an external basemap service.

## Static demo

The GitHub Pages demo uses `VITE_STATIC_MODE=1`. It reads prepared data from `public/demo-data/` and the Hugging Face host in the manifest. The opening case (2000, 20-day lead) and shared projection weights are bundled with the site.

From this directory, on Linux/macOS:

```bash
VITE_STATIC_MODE=1 npm run build
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

Keep `VITE_API_BASE` and `VITE_DATA_API_BASE` unset in the shell and `.env` files for static mode. See the [static quick start](../README.md#static-demo) for PowerShell commands and [Static demo site](../docs/deployment.md#static-demo-site) for data publication and Pages deployment.
