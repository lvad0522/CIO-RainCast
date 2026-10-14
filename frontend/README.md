# CIO-RainCast frontend

React / Vite interface for the CIO projection and historical rainfall demonstration. See the [project README](../README.md) for setup and [deployment instructions](../docs/deployment.md) for API configuration.

```bash
npm ci
npm run dev
npm run lint
npm test
```

Production builds require `VITE_API_BASE`. The `public/geo` directory contains local coastlines and land data, so map rendering does not require an external basemap service.

The published GitHub Pages demo is built with `VITE_STATIC_MODE=1` instead: every `/api/*` response is answered in the page from the committed snapshot in `public/demo-data/` plus the heavy payloads on the dataset host named in its manifest — except the opening case (2000, 20-day lead) and the shared projection weights, whose payload is committed with the snapshot so the landing page works even when that host is unreachable (do not set `VITE_API_BASE` at the same time). See [Static demo site](../docs/deployment.md#static-demo-site).
