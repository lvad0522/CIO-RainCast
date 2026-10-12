# Third-party assets

The frontend uses React, Vite, Recharts, and d3-geo. The backend uses FastAPI, Uvicorn, NumPy, SciPy, xarray, h5netcdf, and PyTorch. Each dependency remains subject to its own license; npm's lockfile records frontend package versions.

`frontend/public/geo/intro-land.geojson` comes from Natural Earth's public-domain 1:110m land dataset, distributed through the [Natural Earth vector repository](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson). Its source note is retained alongside the file. The introductory regional highlight is decorative, not a forecast result.

The local `cio_domain_coastline.json` and `east_asia_coastline.json` files are geographic display assets carried over from the existing demonstration. Their upstream provenance should be recorded before the repository is distributed publicly under an open-source license.

Research datasets, projection constants, and checkpoints are not covered by a code license and are not included in this snapshot.
