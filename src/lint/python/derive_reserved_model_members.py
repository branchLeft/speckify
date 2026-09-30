"""Derives the reserved Python names a generated model can never safely take
as a schema property name, from the pinned toolchain's installed packages —
never from memory. See ../reserved-python-names.ts (loads this script's
committed output) and reserved-python-names.derive.test.ts (re-runs it and
fails on drift from the installed toolchain).

Usage: derive_reserved_model_members.py <custom-template-path> <output-json-path>
"""

# Two sources. (1) openapi-python-client's own attrs model template always
# defines `to_dict`/`from_dict`, and — unless a schema sets
# `additionalProperties: false` — `additional_properties`/`additional_keys`
# too. This runs the real CLI (`--custom-template-path` set to Speckify's own
# override, exactly as client.ts invokes it) against a minimal spec, then
# statically parses (`ast`, no import needed) the generated model's class
# body for every member name besides the one property this itself declared.
# (2) pydantic's `BaseModel`: its own public surface, read via `dir()`.

from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

DECLARED_PROPERTY = "keep_me"

MINIMAL_SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "reserved-member-probe", "version": "0.0.0"},
    "paths": {},
    "components": {
        "schemas": {
            "Thing": {
                "type": "object",
                "properties": {DECLARED_PROPERTY: {"type": "string"}},
            }
        }
    },
}


def generate_attrs_model(custom_template_path: str, scratch_dir: Path) -> Path:
    """Runs the real openapi-python-client CLI, exactly as `client.ts` does, and
    returns the path of the generated `Thing` model module."""
    spec_path = scratch_dir / "spec.json"
    spec_path.write_text(json.dumps(MINIMAL_SPEC), encoding="utf-8")
    config_path = scratch_dir / "config.yaml"
    config_path.write_text(
        "package_name_override: probe_client\nproject_name_override: probe_client\n",
        encoding="utf-8",
    )
    output_path = scratch_dir / "out"

    result = subprocess.run(
        [
            "openapi-python-client",
            "generate",
            "--path",
            str(spec_path),
            "--meta",
            "none",
            "--config",
            str(config_path),
            "--output-path",
            str(output_path),
            "--custom-template-path",
            custom_template_path,
            "--overwrite",
        ],
        capture_output=True,
        text=True,
    )
    model_path = output_path / "models" / "thing.py"
    if not model_path.is_file():
        raise SystemExit(
            "openapi-python-client did not produce the probe model "
            f"(exit {result.returncode}):\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return model_path


def class_body_member_names(module_source: str, class_name: str) -> set[str]:
    """Every name the class body itself declares: method/async-method defs and
    annotated assignments (how attrs fields appear in source), at the class's
    own top level only — not nested functions, not inherited members."""
    tree = ast.parse(module_source)
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for stmt in node.body:
                if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef):
                    names.add(stmt.name)
                elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    names.add(stmt.target.id)
    return names


def derive_attrs_model_members(custom_template_path: str) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="speckify-reserved-probe-") as raw_scratch:
        model_path = generate_attrs_model(custom_template_path, Path(raw_scratch))
        members = class_body_member_names(model_path.read_text(encoding="utf-8"), "Thing")
    members.discard(DECLARED_PROPERTY)
    return sorted(name for name in members if not name.startswith("_"))


def derive_pydantic_base_model_members() -> list[str]:
    from pydantic import BaseModel  # noqa: PLC0415 (only needed here)

    return sorted(name for name in dir(BaseModel) if not name.startswith("_"))


def derive_reserved_words() -> list[str]:
    """openapi-python-client's own `fix_reserved_words()` input set — read
    directly from its installed `strings.RESERVED_WORDS`, not recomputed,
    so a future `dir(builtins)` addition (or a change to the extra names it
    unions in) is picked up automatically rather than silently drifting."""
    import keyword  # noqa: PLC0415
    from openapi_python_client.strings import RESERVED_WORDS  # noqa: PLC0415

    return sorted(set(RESERVED_WORDS) | set(keyword.kwlist))


def main(argv: list[str]) -> int:
    custom_template_path, output_path = argv[1], argv[2]
    import openapi_python_client  # noqa: PLC0415
    import pydantic  # noqa: PLC0415

    data = {
        "openapiPythonClient": {
            "version": openapi_python_client.__version__,
            "modelMembers": derive_attrs_model_members(custom_template_path),
            "reservedWords": derive_reserved_words(),
        },
        "pydantic": {
            "version": pydantic.VERSION,
            "baseModelMembers": derive_pydantic_base_model_members(),
        },
    }
    Path(output_path).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
