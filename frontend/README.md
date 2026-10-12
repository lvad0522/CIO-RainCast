# CIO-RainCast frontend

React / Vite interface for the CIO projection and historical rainfall demonstration. See the [project README](../README.md) for setup and [deployment instructions](../docs/deployment.md) for API configuration.

```bash
npm ci
npm run dev
npm run lint
npm test
```

Production builds require `VITE_API_BASE`. The `public/geo` directory contains local coastlines and land data, so map rendering does not require an external basemap service.
