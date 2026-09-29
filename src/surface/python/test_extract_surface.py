"""Tests for extract_surface.py against small packages written to a temporary directory."""

from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from typing import cast

import extract_surface
import pytest

Json = dict[str, object]

PACKAGE = {
    "__init__.py": '"""Root."""\nfrom .models import Body\n\n__all__ = ["Body"]\n',
    "_private.py": "def hidden() -> None: ...\n",
    "models.py": """
from __future__ import annotations

from typing import ClassVar, Optional, Protocol, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from pydantic import BaseModel, Field


@_attrs_define
class Body:
    a: str
    b: Optional[int] = None
    extra: dict = _attrs_field(init=False, factory=dict)
    count: ClassVar[int] = 0

    def to_dict(self) -> dict: ...


@_attrs_define(kw_only=True)
class KwOnlyBody:
    a: str
    b: Optional[int] = None


class Base(BaseModel):
    inherited: str


class Model(Base):
    page_size: int = Field(..., alias="page-size")
    note: Union[str, None] = Field(None, description="ignored")
    other: str = Field(default="x")


class Handlers(Protocol):
    async def handle(self, *, body: Body) -> Model: ...


class Plain:
    def __init__(self, x: int, /, y: str = "", *args: int, z: bool, **kw: str) -> None: ...

    @staticmethod
    def make(value: int) -> Plain: ...


def send(*, body: Body | None = None) -> Model | None: ...


def _helper() -> None: ...
""",
}


def write_package(root: Path, files: dict[str, str]) -> Path:
    package = root / "pkg"
    package.mkdir()
    for name, text in files.items():
        (package / name).write_text(text, encoding="utf-8")
    return root


def extract(root: Path) -> Json:
    out = io.StringIO()
    with redirect_stdout(out):
        assert extract_surface.main(["extract_surface.py", str(root), "pkg"]) == 0
    return cast(Json, json.loads(out.getvalue())["modules"])


def member(modules: Json, module: str, name: str) -> Json:
    return cast(Json, cast(Json, modules[module])[name])


def names(params: object) -> list[tuple[str, str, bool]]:
    return [
        (cast(str, p["name"]), cast(str, p["kind"]), cast(bool, p["default"]))
        for p in cast(list[Json], params)
    ]


def test_modules_and_public_names(tmp_path: Path) -> None:
    modules = extract(write_package(tmp_path, PACKAGE))
    assert sorted(modules) == ["pkg", "pkg.models"]
    assert member(modules, "pkg", "Body") == {"kind": "alias", "target": "pkg.models.Body"}
    assert "_helper" not in cast(Json, modules["pkg.models"])
    assert "send" in cast(Json, modules["pkg.models"])


def test_attrs_constructor_is_positional_in_declaration_order(tmp_path: Path) -> None:
    body = member(extract(write_package(tmp_path, PACKAGE)), "pkg.models", "Body")
    assert names(body["init"]) == [
        ("a", "positional or keyword", False),
        ("b", "positional or keyword", True),
    ]
    b = cast(list[Json], body["init"])[1]
    assert b["annotation"] == {"u": [{"n": "None"}, {"n": "int"}]}
    assert body["protocol"] is False
    assert cast(Json, cast(Json, body["members"])["b"])["value"] is None


def test_attrs_constructor_with_kw_only_true_is_keyword_only(tmp_path: Path) -> None:
    """The custom openapi-python-client model template passes `kw_only=True`
    (see codegen/python/templates/openapi-python-client/model.py.jinja) so a
    generated model's field order carries no surface meaning; this proves the
    static extractor actually sees that, since attrs synthesises `__init__` at
    class-creation time rather than writing it in source."""
    body = member(extract(write_package(tmp_path, PACKAGE)), "pkg.models", "KwOnlyBody")
    assert names(body["init"]) == [
        ("a", "keyword-only", False),
        ("b", "keyword-only", True),
    ]


def test_pydantic_constructor_is_keyword_only_by_alias_with_inherited_fields(
    tmp_path: Path,
) -> None:
    model = member(extract(write_package(tmp_path, PACKAGE)), "pkg.models", "Model")
    assert names(model["init"]) == [
        ("inherited", "keyword-only", False),
        ("page-size", "keyword-only", False),
        ("note", "keyword-only", True),
        ("other", "keyword-only", True),
    ]


def test_explicit_init_protocol_and_functions(tmp_path: Path) -> None:
    modules = extract(write_package(tmp_path, PACKAGE))
    plain = member(modules, "pkg.models", "Plain")
    assert names(plain["init"]) == [
        ("x", "positional-only", False),
        ("y", "positional or keyword", True),
        ("args", "variadic positional", False),
        ("z", "keyword-only", False),
        ("kw", "variadic keyword", False),
    ]
    make = cast(Json, cast(Json, plain["members"])["make"])
    assert names(make["params"]) == [("value", "positional or keyword", False)]
    handlers = member(modules, "pkg.models", "Handlers")
    assert handlers["protocol"] is True
    send = member(modules, "pkg.models", "send")
    assert names(send["params"]) == [("body", "keyword-only", True)]
    assert send["returns"] == {"u": [{"n": "None"}, {"n": "pkg.models.Model"}]}


def test_refuses_a_module_that_does_not_parse(tmp_path: Path) -> None:
    root = write_package(tmp_path, {"__init__.py": "def f(*,) -> None: ...\n"})
    with pytest.raises(SystemExit, match="does not parse"):
        extract(root)
