"""Prints a generated Python package's public surface as JSON (see ../surface.md, section 4).

Usage: extract_surface.py <search-path> <package>

The package is loaded statically by griffe, which parses the source into
its own object tree. Nothing here matches source text.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import cast

import griffe

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
Json = dict[str, JsonValue]

ATTRS_DECORATORS = {"attrs.define", "attrs.frozen", "attrs.mutable", "attr.s", "attr.attrs"}
ATTRS_FIELDS = {"attrs.field", "attr.ib", "attr.attrib"}
PYDANTIC_BASES = {"pydantic.BaseModel", "pydantic.main.BaseModel", "pydantic.RootModel"}
PYDANTIC_FIELDS = {"pydantic.Field", "pydantic.fields.Field"}
PROTOCOL_BASES = {"typing.Protocol", "typing_extensions.Protocol"}
UNION_NAMES = {"typing.Union", "typing.Optional", "typing_extensions.Union"}
VARIADIC = {griffe.ParameterKind.var_positional, griffe.ParameterKind.var_keyword}
NOT_A_LITERAL = object()


def literal(value: str | griffe.Expr | None) -> object:
    """A constant griffe keeps as its source form, evaluated by Python's literal parser."""
    if not isinstance(value, str):
        return NOT_A_LITERAL
    try:
        return cast(object, ast.literal_eval(value))
    except (ValueError, SyntaxError):
        return NOT_A_LITERAL


class Surface:
    """Walks one loaded package, resolving names through its module collection."""

    def __init__(self, package: griffe.Module) -> None:
        self.package = package

    def canonical(self, path: str) -> str:
        """The path of the object `path` finally names, following re-export aliases."""
        try:
            found = self.package.modules_collection.get_member(path)
        except (KeyError, ValueError, griffe.AliasResolutionError, griffe.CyclicAliasError):
            return path
        if isinstance(found, griffe.Alias):
            try:
                return found.final_target.path
            except (griffe.AliasResolutionError, griffe.CyclicAliasError):
                return found.target_path
        return path if found is None else str(found.path)

    def expr(self, value: str | griffe.Expr | None) -> JsonValue:
        """An annotation or value as a structural tree (see ../surface.md, section 4)."""
        if value is None:
            return None
        if isinstance(value, str):
            return {"n": "None"} if value == "None" else {"t": value}
        if isinstance(value, griffe.ExprName | griffe.ExprAttribute):
            name = value.canonical_path
            return {"n": "None" if name == "None" else self.canonical(name)}
        if isinstance(value, griffe.ExprConstant):
            return {"n": "None"} if value.value == "None" else {"c": value.value}
        if isinstance(value, griffe.ExprBinOp) and value.operator == "|":
            return self.union([value.left, value.right])
        if isinstance(value, griffe.ExprSubscript):
            left = self.expr(value.left)
            items = (
                value.slice.elements if isinstance(value.slice, griffe.ExprTuple) else [value.slice]
            )
            if isinstance(left, dict) and left.get("n") in UNION_NAMES:
                extra = [] if left.get("n") != "typing.Optional" else ["None"]
                return self.union([*items, *extra])
            return {"sub": left, "args": [self.expr(item) for item in items]}
        if isinstance(value, griffe.ExprList | griffe.ExprTuple):
            return {"l": [self.expr(item) for item in value.elements]}
        return {"t": str(value)}

    def union(self, members: list[str | griffe.Expr]) -> JsonValue:
        flat: list[JsonValue] = []
        for member in members:
            node = self.expr(member)
            if isinstance(node, dict) and "u" in node:
                flat.extend(cast(list[JsonValue], node["u"]))
            else:
                flat.append(node)
        unique = {json.dumps(node, sort_keys=True): node for node in flat}
        return {"u": [unique[key] for key in sorted(unique)]}

    def call_target(self, value: str | griffe.Expr | None) -> str | None:
        if isinstance(value, griffe.ExprCall) and isinstance(
            value.function, griffe.ExprName | griffe.ExprAttribute
        ):
            return self.canonical(value.function.canonical_path)
        return None

    def parameters(self, function: griffe.Function, skip_self: bool) -> list[JsonValue]:
        params = list(function.parameters)
        if skip_self and params and params[0].name in {"self", "cls"}:
            params = params[1:]
        return [
            {
                "name": param.name,
                "kind": param.kind.value if param.kind is not None else "positional or keyword",
                "default": param.default is not None and param.kind not in VARIADIC,
                "annotation": self.expr(param.annotation),
            }
            for param in params
        ]

    def function(self, function: griffe.Function, skip_self: bool) -> Json:
        return {
            "kind": "function",
            "params": self.parameters(function, skip_self),
            "returns": self.expr(function.returns),
        }

    def class_bases(self, cls: griffe.Class) -> list[str]:
        return [
            self.canonical(base.canonical_path)
            if isinstance(base, griffe.ExprName | griffe.ExprAttribute)
            else str(base)
            for base in cls.bases
        ]

    def local_class(self, path: str) -> griffe.Class | None:
        try:
            found = self.package.modules_collection.get_member(path)
        except (KeyError, ValueError, griffe.AliasResolutionError, griffe.CyclicAliasError):
            return None
        if isinstance(found, griffe.Alias):
            try:
                found = found.final_target
            except (griffe.AliasResolutionError, griffe.CyclicAliasError):
                return None
        return found if isinstance(found, griffe.Class) else None

    def is_pydantic(self, cls: griffe.Class, depth: int = 0) -> bool:
        for base in self.class_bases(cls):
            if base in PYDANTIC_BASES:
                return True
            parent = self.local_class(base)
            if parent is not None and depth < 20 and self.is_pydantic(parent, depth + 1):
                return True
        return False

    def fields(self, cls: griffe.Class) -> list[griffe.Attribute]:
        return [
            member
            for name, member in cls.members.items()
            if isinstance(member, griffe.Attribute)
            and not member.is_alias
            and member.annotation is not None
            and "instance-attribute" in member.labels
            and "property" not in member.labels
            and not name.startswith("_")
            and name != "model_config"
        ]

    def attrs_init(self, cls: griffe.Class) -> list[JsonValue]:
        params: list[JsonValue] = []
        for field in self.fields(cls):
            value = field.value
            if self.call_target(value) in ATTRS_FIELDS and isinstance(value, griffe.ExprCall):
                keywords = {
                    arg.name: arg.value
                    for arg in value.arguments
                    if isinstance(arg, griffe.ExprKeyword)
                }
                if literal(keywords.get("init")) is False:
                    continue
                has_default = "default" in keywords or "factory" in keywords
            else:
                has_default = value is not None
            params.append(
                {
                    "name": field.name,
                    "kind": "positional or keyword",
                    "default": has_default,
                    "annotation": self.expr(field.annotation),
                }
            )
        return params

    def pydantic_init(self, cls: griffe.Class, depth: int = 0) -> list[JsonValue]:
        inherited: list[JsonValue] = []
        for base in self.class_bases(cls):
            parent = self.local_class(base)
            if parent is not None and depth < 20:
                inherited.extend(self.pydantic_init(parent, depth + 1))
        params: list[JsonValue] = []
        for field in self.fields(cls):
            name, has_default = field.name, field.value is not None
            value = field.value
            if self.call_target(value) in PYDANTIC_FIELDS and isinstance(value, griffe.ExprCall):
                positional = [
                    arg for arg in value.arguments if not isinstance(arg, griffe.ExprKeyword)
                ]
                keywords = {
                    arg.name: arg.value
                    for arg in value.arguments
                    if isinstance(arg, griffe.ExprKeyword)
                }
                alias = literal(keywords.get("alias"))
                if isinstance(alias, str):
                    name = alias
                first = literal(positional[0]) if positional else Ellipsis
                has_default = first is not Ellipsis or bool(
                    {"default", "default_factory"} & keywords.keys()
                )
            params.append(
                {
                    "name": name,
                    "kind": "keyword-only",
                    "default": has_default,
                    "annotation": self.expr(field.annotation),
                }
            )
        names = {cast(Json, param)["name"] for param in params}
        return [param for param in inherited if cast(Json, param)["name"] not in names] + params

    def klass(self, cls: griffe.Class) -> Json:
        bases = self.class_bases(cls)
        init: list[JsonValue] | None = None
        explicit = cls.members.get("__init__")
        decorators = {self.call_target(d.value) or self.expr_path(d.value) for d in cls.decorators}
        if isinstance(explicit, griffe.Function):
            init = self.parameters(explicit, skip_self=True)
        elif decorators & ATTRS_DECORATORS:
            init = self.attrs_init(cls)
        elif self.is_pydantic(cls):
            init = self.pydantic_init(cls)
        members: Json = {}
        for name, member in cls.members.items():
            if name.startswith("_") or member.is_alias:
                continue
            members[name] = self.member(member, in_class=True)
        return {
            "kind": "class",
            "bases": cast(list[JsonValue], bases),
            "protocol": any(base in PROTOCOL_BASES for base in bases),
            "init": init,
            "members": members,
        }

    def expr_path(self, value: str | griffe.Expr) -> str | None:
        if isinstance(value, griffe.ExprName | griffe.ExprAttribute):
            return self.canonical(value.canonical_path)
        return None

    def member(self, member: griffe.Object | griffe.Alias, in_class: bool = False) -> Json:
        if isinstance(member, griffe.Alias):
            return {"kind": "alias", "target": self.canonical(member.target_path)}
        if isinstance(member, griffe.Function):
            is_static = "staticmethod" in member.labels
            return self.function(member, skip_self=in_class and not is_static)
        if isinstance(member, griffe.Class):
            return self.klass(member)
        if isinstance(member, griffe.Attribute):
            # A class field's value is its default or field() call, already
            # read into the constructor; only unannotated values (enum
            # members, module constants) are kept.
            keep = member.value is not None and not (in_class and member.annotation is not None)
            return {
                "kind": "attribute",
                "annotation": self.expr(member.annotation),
                "value": str(member.value) if keep else None,
            }
        return {"kind": str(member.kind.value)}

    def module(self, module: griffe.Module) -> Json:
        exports = module.exports
        members: Json = {}
        if exports is not None:
            names = [name if isinstance(name, str) else name.name for name in exports]
            for name in names:
                if name in module.members:
                    members[name] = self.member(module.members[name])
        else:
            for name, member in module.members.items():
                if name.startswith("_") or member.is_alias or isinstance(member, griffe.Module):
                    continue
                members[name] = self.member(member)
        return members

    def modules(self) -> Json:
        result: Json = {}
        pending: list[griffe.Module] = [self.package]
        while pending:
            module = pending.pop()
            result[module.path] = self.module(module)
            for name, child in module.members.items():
                if isinstance(child, griffe.Module) and not name.startswith("_"):
                    pending.append(child)
        return result


def assert_parses(search_path: str, package_name: str) -> None:
    """Fails on a module griffe would otherwise skip with only a debug log."""
    for path in sorted((Path(search_path) / package_name).rglob("*.py")):
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as error:
            raise SystemExit(f"generated module {path} does not parse: {error}") from error


def main(argv: list[str]) -> int:
    search_path, package_name = argv[1], argv[2]
    assert_parses(search_path, package_name)
    loaded = griffe.load(
        package_name,
        search_paths=[search_path],
        resolve_aliases=True,
        resolve_external=False,
        allow_inspection=False,
    )
    if not isinstance(loaded, griffe.Module):
        raise SystemExit(f"{package_name} did not load as a package")
    json.dump({"modules": Surface(loaded).modules()}, sys.stdout, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
