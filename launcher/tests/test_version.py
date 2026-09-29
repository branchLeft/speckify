"""The launcher execs `speckify@<its own version>`, so its version must
track the npm package's `package.json` exactly — a drift here would silently
launch the wrong release."""

import json
import re
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LAUNCHER_ROOT = Path(__file__).resolve().parents[1]


def _npm_version() -> str:
    package_json = json.loads((REPO_ROOT / "package.json").read_text())
    return package_json["version"]


def _pyproject_version() -> str:
    pyproject = tomllib.loads((LAUNCHER_ROOT / "pyproject.toml").read_text())
    return pyproject["project"]["version"]


def _init_version() -> str:
    init_source = (LAUNCHER_ROOT / "src" / "speckify_launcher" / "__init__.py").read_text()
    match = re.search(r'__version__ = "([^"]+)"', init_source)
    assert match is not None, "speckify_launcher/__init__.py has no __version__ assignment"
    return match.group(1)


def test_pyproject_version_matches_npm_package_version() -> None:
    assert _pyproject_version() == _npm_version()


def test_module_version_matches_pyproject_version() -> None:
    assert _init_version() == _pyproject_version()
