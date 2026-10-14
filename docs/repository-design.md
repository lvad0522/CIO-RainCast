# Repository organization

The release layout was informed by two WSDM 2025 demonstration artifacts:

- [Lightning IR](https://github.com/webis-de/lightning-ir): a short project overview and installation entry point, with examples, configuration, tests, and documentation in dedicated directories. The [WSDM paper](https://doi.org/10.1145/3701551.3704118) identifies the associated framework.
- [CRS Arena dialogue release](https://github.com/iai-group/crsarena-dial): a separate research-data repository associated with the [WSDM demonstration](https://krisztianbalog.com/files/wsdm2025-arena.pdf). It illustrates that an application's code and research artifacts can have separate release paths.

CIO-RainCast adopts a concise README, a standard frontend/backend layout, explicit data requirements, and automated checks. Large scientific assets stay separate from Git. These are packaging choices, not claimed WSDM submission requirements.

One deliberate exception: the static demo bundle under `frontend/public/demo-data/` (pre-baked API responses, tens of megabytes, including the opening case's heavy payload so the landing page needs no external host) is committed, because the published GitHub Pages site must be self-contained without a backend or research data. The bake script and the layer policy are documented in [Deployment](deployment.md#static-demo-site); datasets and checkpoints remain out of Git.
