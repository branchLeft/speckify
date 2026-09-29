"""Renders the `server/` submodule (Handlers Protocol + create_router) from
the Jinja2 templates in this directory.

Invoked by the TS driver as `uv run --frozen python render_server.py
<operations.json> <output-dir>`; also imported directly by
test_render_server.py so the templates get real pytest coverage in this repo.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import jinja2
from operations import Operation, parse_operations

TEMPLATES_DIR = Path(__file__).parent


def _environment() -> jinja2.Environment:
    return jinja2.Environment(
        loader=jinja2.FileSystemLoader(TEMPLATES_DIR),
        trim_blocks=True,
        lstrip_blocks=True,
        undefined=jinja2.StrictUndefined,
    )


def render(operations: list[Operation]) -> dict[str, str]:
    """Returns {relative_path: contents} for every file the server submodule needs."""
    env = _environment()
    return {
        "__init__.py": env.get_template("server_init.py.jinja").render(operations=operations),
        "handlers.py": env.get_template("handlers.py.jinja").render(operations=operations),
        "router.py": env.get_template("router.py.jinja").render(operations=operations),
    }


def write_server_module(operations: list[Operation], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for relative_path, contents in render(operations).items():
        (output_dir / relative_path).write_text(contents, encoding="utf-8")


def main() -> None:
    operations_path, output_dir = sys.argv[1], Path(sys.argv[2])
    raw_operations = json.loads(Path(operations_path).read_text(encoding="utf-8"))
    write_server_module(parse_operations(raw_operations), output_dir)


if __name__ == "__main__":
    main()
