# Building the generated Python package

`runUvBuild` runs `uv build`, not `uv run`, against the generated project.

The generator steps (models, client, server rendering) run inside the
pinned `python/` toolchain's own environment — that's what pins
`datamodel-code-generator` and `openapi-python-client` to known versions.
Building the _generated_ package is different: it declares its own
dependency set (`httpx`, `pydantic`, optionally `fastapi`) in its own
`pyproject.toml`, and `uv build` must resolve exactly those, not the
generator toolchain's. Running it inside the toolchain's environment would
either resolve the wrong dependencies or fight the toolchain's own pins.
