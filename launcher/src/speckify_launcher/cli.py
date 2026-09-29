"""Execs the real Speckify CLI (an npm package) via `npx`.

This package exists so a Python-first toolchain can `pip install speckify`
rather than adding a separate global npm install step. It does no work of
its own beyond checking that Node is present and hand off to `npx`.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

from speckify_launcher import __version__

_MIN_NODE_MAJOR = 22
_NODE_VERSION_PATTERN = re.compile(r"^v(\d+)\.")


class LauncherError(RuntimeError):
    """Raised when the launcher cannot hand off to the real CLI."""


def _require_node() -> str:
    node_path = shutil.which("node")
    if node_path is None:
        raise LauncherError(
            "speckify requires Node.js "
            f">={_MIN_NODE_MAJOR} on PATH, and none was found. "
            "Install Node (https://nodejs.org) and try again."
        )

    result = subprocess.run(  # noqa: S603 - node_path comes from shutil.which, not user input
        [node_path, "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise LauncherError(f"could not run \"{node_path} --version\": {result.stderr.strip()}")

    match = _NODE_VERSION_PATTERN.match(result.stdout.strip())
    if match is None:
        raise LauncherError(f"could not parse Node's version from \"{result.stdout.strip()}\"")

    major = int(match.group(1))
    if major < _MIN_NODE_MAJOR:
        raise LauncherError(
            f"speckify requires Node.js >={_MIN_NODE_MAJOR}, found {result.stdout.strip()}"
        )

    return node_path


def main(argv: list[str] | None = None) -> int:
    """Entry point for the `speckify` console script."""
    args = sys.argv[1:] if argv is None else argv

    try:
        _require_node()
    except LauncherError as error:
        print(str(error), file=sys.stderr)
        return 1

    npx_path = shutil.which("npx")
    if npx_path is None:
        print(
            "speckify requires npx (bundled with Node.js) on PATH, and it was not found.",
            file=sys.stderr,
        )
        return 1

    command = [npx_path, "--yes", f"speckify@{__version__}", *args]
    completed = subprocess.run(command, env=os.environ.copy(), check=False)  # noqa: S603
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
