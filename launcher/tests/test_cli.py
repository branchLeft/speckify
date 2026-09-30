from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from speckify_launcher import __version__
from speckify_launcher.cli import LauncherError, _require_node, main


def _fake_completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_require_node_raises_when_node_is_missing() -> None:
    with patch("speckify_launcher.cli.shutil.which", return_value=None):
        with pytest.raises(LauncherError, match="Node.js"):
            _require_node()


def test_require_node_raises_when_version_is_too_old() -> None:
    with (
        patch("speckify_launcher.cli.shutil.which", return_value="/usr/bin/node"),
        patch("speckify_launcher.cli.subprocess.run", return_value=_fake_completed(0, stdout="v18.19.0\n")),
    ):
        with pytest.raises(LauncherError, match="requires Node.js >=22"):
            _require_node()


def test_require_node_raises_when_version_command_fails() -> None:
    with (
        patch("speckify_launcher.cli.shutil.which", return_value="/usr/bin/node"),
        patch("speckify_launcher.cli.subprocess.run", return_value=_fake_completed(1, stderr="boom")),
    ):
        with pytest.raises(LauncherError, match="boom"):
            _require_node()


def test_require_node_raises_when_version_output_is_unparseable() -> None:
    with (
        patch("speckify_launcher.cli.shutil.which", return_value="/usr/bin/node"),
        patch("speckify_launcher.cli.subprocess.run", return_value=_fake_completed(0, stdout="nonsense")),
    ):
        with pytest.raises(LauncherError, match="could not parse"):
            _require_node()


def test_require_node_returns_the_path_when_new_enough() -> None:
    with (
        patch("speckify_launcher.cli.shutil.which", return_value="/usr/bin/node"),
        patch("speckify_launcher.cli.subprocess.run", return_value=_fake_completed(0, stdout="v22.1.0\n")),
    ):
        assert _require_node() == "/usr/bin/node"


def test_main_returns_1_and_prints_when_node_is_missing(capsys: pytest.CaptureFixture[str]) -> None:
    with patch("speckify_launcher.cli.shutil.which", return_value=None):
        assert main([]) == 1
    assert "Node.js" in capsys.readouterr().err


def test_main_returns_1_when_npx_is_missing(capsys: pytest.CaptureFixture[str]) -> None:
    def which(name: str) -> str | None:
        return "/usr/bin/node" if name == "node" else None

    with (
        patch("speckify_launcher.cli.shutil.which", side_effect=which),
        patch(
            "speckify_launcher.cli.subprocess.run",
            return_value=_fake_completed(0, stdout="v22.1.0\n"),
        ),
    ):
        assert main([]) == 1
    assert "npx" in capsys.readouterr().err


def test_main_execs_npx_with_the_pinned_version_and_forwards_args() -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}"

    version_check = _fake_completed(0, stdout="v22.1.0\n")
    exec_result = _fake_completed(0)

    with (
        patch("speckify_launcher.cli.shutil.which", side_effect=which),
        patch(
            "speckify_launcher.cli.subprocess.run",
            side_effect=[version_check, exec_result],
        ) as run,
    ):
        assert main(["check", "--config", "speckify.yaml"]) == 0

    final_call = run.call_args_list[-1]
    command = final_call.args[0]
    assert command == [
        "/usr/bin/npx",
        "--yes",
        f"speckify@{__version__}",
        "check",
        "--config",
        "speckify.yaml",
    ]


def test_main_propagates_the_exit_code_from_npx() -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}"

    version_check = _fake_completed(0, stdout="v22.1.0\n")
    exec_result = _fake_completed(3)

    with (
        patch("speckify_launcher.cli.shutil.which", side_effect=which),
        patch("speckify_launcher.cli.subprocess.run", side_effect=[version_check, exec_result]),
    ):
        assert main([]) == 3
