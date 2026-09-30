"""The operation shape the server templates render from.

This mirrors src/codegen/python/types.ts's OperationInfo deliberately: the TS
driver extracts operations once and hands them to render_server.py as JSON,
so both sides must agree on field names without either importing the other.
"""

from __future__ import annotations

import dataclasses
import re
import typing


def snake_case(identifier: str) -> str:
    """camelCase/PascalCase to snake_case — the same rule naming.ts applies."""
    stage1 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", identifier)
    return re.sub(r"[-\s]+", "_", stage1).lower()


class RawParamConstraints(typing.TypedDict, total=False):
    enum: list[str | int | float | bool]
    minimum: float
    maximum: float
    exclusiveMinimum: float
    exclusiveMaximum: float
    minLength: int
    maxLength: int
    pattern: str


class RawParam(typing.TypedDict):
    name: str
    pyName: str
    required: bool
    pyType: str
    isArray: typing.NotRequired[bool]
    constraints: typing.NotRequired[RawParamConstraints]


class RawRequestBody(typing.TypedDict):
    kind: typing.Literal["json", "octet-stream", "none"]
    required: typing.NotRequired[bool]
    model: typing.NotRequired[str | None]


class RawResponse(typing.TypedDict):
    statusCode: str
    model: str | None


class RawOperation(typing.TypedDict):
    operationId: str
    method: str
    path: str
    pathParams: list[RawParam]
    queryParams: list[RawParam]
    headerParams: list[RawParam]
    requestBody: RawRequestBody
    responses: list[RawResponse]


@dataclasses.dataclass(frozen=True)
class Param:
    name: str
    py_name: str
    required: bool
    py_type: str
    is_array: bool = False
    constraints: RawParamConstraints = dataclasses.field(default_factory=lambda: RawParamConstraints())

    @property
    def constraints_literal(self) -> str:
        """`constraints` rendered as Python source: every value it can hold
        (str/int/float/bool, or a list of those for `enum`) reprs to valid
        Python, unlike `json.dumps` output (`true`/`false`/`null` are not
        Python literals)."""
        return repr(dict(self.constraints))


@dataclasses.dataclass(frozen=True)
class RequestBody:
    kind: typing.Literal["json", "octet-stream", "none"]
    required: bool
    model: str | None


@dataclasses.dataclass(frozen=True)
class Response:
    status_code: str
    model: str | None

    @property
    def response_class_name_suffix(self) -> str:
        return f"{self.status_code}"

    @property
    def py_body_type(self) -> str:
        if self.model is not None:
            return f"models.{self.model}"
        # An inline (non-$ref) response schema has no generated pydantic
        # model to bind to; the handler gets and returns a plain JSON value.
        return "dict[str, typing.Any]"


@dataclasses.dataclass(frozen=True)
class Operation:
    operation_id: str
    method: str
    path: str
    path_params: list[Param]
    query_params: list[Param]
    header_params: list[Param]
    request_body: RequestBody
    responses: list[Response]

    @property
    def handler_name(self) -> str:
        return snake_case(self.operation_id)

    @property
    def response_type_name(self) -> str:
        parts = "".join(word.capitalize() for word in self.handler_name.split("_"))
        return f"{parts}Response"

    @property
    def all_params(self) -> list[Param]:
        return [*self.path_params, *self.query_params, *self.header_params]


def parse_operations(raw: list[RawOperation]) -> list[Operation]:
    operations = []
    for item in raw:
        request_body = item["requestBody"]
        operations.append(
            Operation(
                operation_id=item["operationId"],
                method=item["method"],
                path=item["path"],
                path_params=[_parse_param(p) for p in item["pathParams"]],
                query_params=[_parse_param(p) for p in item["queryParams"]],
                header_params=[_parse_param(p) for p in item["headerParams"]],
                request_body=RequestBody(
                    kind=request_body["kind"],
                    required=request_body.get("required", False),
                    model=request_body.get("model"),
                ),
                responses=[
                    Response(status_code=r["statusCode"], model=r["model"])
                    for r in item["responses"]
                ],
            )
        )
    return operations


def _parse_param(raw: RawParam) -> Param:
    return Param(
        name=raw["name"],
        py_name=raw["pyName"],
        required=raw["required"],
        py_type=raw["pyType"],
        is_array=raw.get("isArray", False),
        constraints=raw.get("constraints", {}),
    )
