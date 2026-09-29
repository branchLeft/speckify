"""Tests the server templates for real: renders them, drops the result next
to a hand-written models module (standing in for datamodel-code-generator's
output, which client.test.ts and models.test.ts already exercise for real),
and round-trips a FastAPI TestClient through the generated router.
"""

from __future__ import annotations

import sys
import typing
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

from operations import parse_operations
from render_server import write_server_module

CREATE_PET = {
    "operationId": "createPet",
    "method": "POST",
    "path": "/pets",
    "pathParams": [],
    "queryParams": [],
    "headerParams": [],
    "requestBody": {"kind": "json", "required": True, "model": "Pet"},
    "responses": [{"statusCode": "201", "model": "Pet"}],
}

GET_ITEM = {
    "operationId": "getItem",
    "method": "GET",
    "path": "/items/{item_id}",
    "pathParams": [{"name": "item_id", "pyName": "item_id", "required": True, "pyType": "int"}],
    "queryParams": [],
    "headerParams": [],
    "requestBody": {"kind": "none"},
    "responses": [{"statusCode": "200", "model": None}],
}

LIST_WIDGETS = {
    "operationId": "listWidgets",
    "method": "GET",
    "path": "/widgets",
    "pathParams": [],
    "queryParams": [
        {
            "name": "status",
            "pyName": "status",
            "required": False,
            "pyType": "str",
            "isArray": False,
            "constraints": {"enum": ["active", "archived"]},
        },
        {
            "name": "limit",
            "pyName": "limit",
            "required": False,
            "pyType": "int",
            "isArray": False,
            "constraints": {"minimum": 1, "maximum": 100},
        },
        {
            "name": "tag",
            "pyName": "tag",
            "required": False,
            "pyType": "str",
            "isArray": True,
            "constraints": {},
        },
        {
            "name": "score",
            "pyName": "score",
            "required": False,
            "pyType": "float",
            "isArray": False,
            "constraints": {},
        },
    ],
    "headerParams": [],
    "requestBody": {"kind": "none"},
    "responses": [{"statusCode": "200", "model": None}],
}

CREATE_WIDGET = {
    "operationId": "createWidget",
    "method": "POST",
    "path": "/widgets",
    "pathParams": [],
    "queryParams": [],
    "headerParams": [],
    # An inline JSON body schema, hoisted into a named model at generation time.
    "requestBody": {"kind": "json", "required": True, "model": "CreateWidgetRequestBody"},
    "responses": [{"statusCode": "201", "model": None}],
}

PATCH_WIDGET = {
    "operationId": "patchWidget",
    "method": "PATCH",
    "path": "/widgets",
    "pathParams": [],
    "queryParams": [],
    "headerParams": [],
    "requestBody": {"kind": "json", "required": False, "model": "CreateWidgetRequestBody"},
    "responses": [{"statusCode": "200", "model": None}],
}

ECHO_JSON = {
    "operationId": "echoJson",
    "method": "POST",
    "path": "/echo",
    "pathParams": [],
    "queryParams": [],
    "headerParams": [],
    # A JSON media type that declares no schema at all: nothing to validate against.
    "requestBody": {"kind": "json", "required": True, "model": None},
    "responses": [{"statusCode": "200", "model": None}],
}

UPLOAD_BLOB = {
    "operationId": "uploadBlob",
    "method": "POST",
    "path": "/uploads",
    "pathParams": [],
    "queryParams": [],
    "headerParams": [
        {"name": "X-Signature", "pyName": "signature", "required": True, "pyType": "str"},
        {"name": "X-Timestamp", "pyName": "timestamp", "required": True, "pyType": "str"},
    ],
    "requestBody": {"kind": "octet-stream", "required": True},
    "responses": [{"statusCode": "201", "model": None}],
}

# A hand-written stand-in for datamodel-code-generator's output — real
# generator output is exercised elsewhere (client.test.ts, models.test.ts).
MODELS_PY = (Path(__file__).parent / "fixtures" / "hand_written_models.py").read_text(
    encoding="utf-8"
)


@pytest.fixture()
def generated_package(tmp_path: Path) -> typing.Any:
    """Builds <tmp_path>/testpkg/{models.py, server/} and imports testpkg.server."""
    package_dir = tmp_path / "testpkg"
    package_dir.mkdir()
    (package_dir / "__init__.py").write_text("", encoding="utf-8")
    (package_dir / "models.py").write_text(MODELS_PY, encoding="utf-8")

    operations = parse_operations(
        [CREATE_PET, UPLOAD_BLOB, GET_ITEM, LIST_WIDGETS, CREATE_WIDGET, PATCH_WIDGET, ECHO_JSON]
    )
    write_server_module(operations, package_dir / "server")

    sys.path.insert(0, str(tmp_path))
    try:
        import importlib

        server_module = importlib.import_module("testpkg.server")
        yield server_module
    finally:
        sys.path.remove(str(tmp_path))
        for name in [m for m in sys.modules if m == "testpkg" or m.startswith("testpkg.")]:
            del sys.modules[name]


def test_render_writes_the_three_expected_files(tmp_path: Path) -> None:
    operations = parse_operations([CREATE_PET, UPLOAD_BLOB])
    output_dir = tmp_path / "server"

    write_server_module(operations, output_dir)

    assert {p.name for p in output_dir.iterdir()} == {"__init__.py", "handlers.py", "router.py"}


def test_generated_handlers_module_has_one_protocol_method_per_operation(
    generated_package: typing.Any,
) -> None:
    handlers_source = (Path(generated_package.__file__).parent / "handlers.py").read_text()
    assert "async def create_pet(" in handlers_source
    assert "async def upload_blob(" in handlers_source
    assert "class Handlers(typing.Protocol):" in handlers_source


def test_json_round_trip_through_the_generated_router(generated_package: typing.Any) -> None:
    from testpkg import models

    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            cat = body.root
            return generated_package.handlers.CreatePetResponse201(body=models.Pet(root=cat))

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers()))
    client = TestClient(app)

    response = client.post("/pets", json={"petType": "cat", "meowVolume": 11})

    assert response.status_code == 201
    assert response.json() == {"petType": "cat", "meowVolume": 11}


def test_422_on_invalid_body_through_the_generated_router(generated_package: typing.Any) -> None:
    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            raise AssertionError("handler must not run for an invalid body")

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers()))
    client = TestClient(app)

    # Missing the discriminator field entirely - the discriminated union must reject it.
    response = client.post("/pets", json={"meowVolume": 11})

    assert response.status_code == 422


def test_discriminated_union_dispatches_to_the_matching_branch(
    generated_package: typing.Any,
) -> None:

    seen: dict[str, typing.Any] = {}

    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            seen["branch"] = type(body.root).__name__
            return generated_package.handlers.CreatePetResponse201(body=body)

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers()))
    client = TestClient(app)

    response = client.post("/pets", json={"petType": "dog", "barkVolume": 9})

    assert response.status_code == 201
    assert seen["branch"] == "Dog"


def test_octet_stream_body_is_streamed_not_buffered(generated_package: typing.Any) -> None:
    received_chunks: list[bytes] = []

    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            raise NotImplementedError

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            async for chunk in body:
                received_chunks.append(chunk)
            return generated_package.handlers.UploadBlobResponse201(
                body={"id": "blob-1", "signature": signature, "timestamp": timestamp}
            )

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers()))
    client = TestClient(app)

    response = client.post(
        "/uploads",
        content=b"binary-blob-bytes",
        headers={"X-Signature": "sig-abc", "X-Timestamp": "2026-09-29T00:00:00Z"},
    )

    assert response.status_code == 201
    assert response.json() == {
        "id": "blob-1",
        "signature": "sig-abc",
        "timestamp": "2026-09-29T00:00:00Z",
    }
    assert b"".join(received_chunks) == b"binary-blob-bytes"


def test_before_handle_hook_runs_before_body_parsing(generated_package: typing.Any) -> None:
    calls: list[str] = []

    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            calls.append("handler")
            return generated_package.handlers.CreatePetResponse201(body=body)

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

    async def before_handle(request: typing.Any) -> None:
        calls.append("before_handle")

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers(), before_handle=before_handle))
    client = TestClient(app)

    client.post("/pets", json={"petType": "cat", "meowVolume": 3})

    assert calls == ["before_handle", "handler"]


def test_malformed_json_body_returns_400_not_500(generated_package: typing.Any) -> None:
    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            raise AssertionError("handler must not run for a malformed body")

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

        async def get_item(self, *, item_id: int) -> typing.Any:
            raise NotImplementedError

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers()))
    client = TestClient(app)

    response = client.post(
        "/pets",
        content=b"{not valid json",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.status_code != 500


def test_before_handle_runs_before_path_parameter_parsing(generated_package: typing.Any) -> None:
    """Proves the fix, not just the happy path: `before_handle` must run even
    when the path parameter that follows it would fail to parse. If
    `before_handle` ran *after* FastAPI's own parameter parsing (the bug this
    restructure fixes), the request would never reach the handler-side code
    at all for an invalid `item_id`, and `calls` would stay empty."""

    calls: list[str] = []

    class TestHandlers:
        async def create_pet(self, *, body: typing.Any) -> typing.Any:
            raise NotImplementedError

        async def upload_blob(
            self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
        ) -> typing.Any:
            raise NotImplementedError

        async def get_item(self, *, item_id: int) -> typing.Any:
            calls.append("handler")
            raise AssertionError("handler must not run for an unparseable item_id")

    async def before_handle(request: typing.Any) -> None:
        calls.append("before_handle")

    app = FastAPI()
    app.include_router(generated_package.create_router(TestHandlers(), before_handle=before_handle))
    client = TestClient(app)

    # "not-an-int" fails item_id's int coercion, which must happen strictly
    # after before_handle, and must reject with 422 rather than reach the
    # handler.
    response = client.get("/items/not-an-int")

    assert calls == ["before_handle"]
    assert response.status_code == 422


class _WidgetHandlers:
    """A stand-in Handlers implementation for the N4 tests below: every
    endpoint just echoes what it received, so each test asserts on the
    router's own parsing/validation rather than on any handler logic."""

    async def create_pet(self, *, body: typing.Any) -> typing.Any:
        raise NotImplementedError

    async def upload_blob(
        self, *, signature: str, timestamp: str, body: typing.AsyncIterator[bytes]
    ) -> typing.Any:
        raise NotImplementedError

    async def get_item(self, *, item_id: int) -> typing.Any:
        raise NotImplementedError

    async def list_widgets(
        self,
        *,
        status: str | None,
        limit: int | None,
        tag: list[str],
        score: float | None,
    ) -> typing.Any:
        return {
            "status_code": 200,
            "body": {"status": status, "limit": limit, "tag": tag, "score": score},
        }

    async def create_widget(self, *, body: typing.Any) -> typing.Any:
        return {"status_code": 201, "body": {"received": body.model_dump()}}

    async def patch_widget(self, *, body: typing.Any) -> typing.Any:
        return {"status_code": 200, "body": {"received": None if body is None else body.model_dump()}}

    async def echo_json(self, *, body: typing.Any) -> typing.Any:
        return {"status_code": 200, "body": {"received": body}}


def _widget_client(generated_package: typing.Any) -> TestClient:
    class Result:
        def __init__(self, status_code: int, body: typing.Any) -> None:
            self.status_code = status_code
            self.body = body

    class WidgetHandlers(_WidgetHandlers):
        async def list_widgets(self, **kwargs: typing.Any) -> typing.Any:
            raw = await _WidgetHandlers.list_widgets(self, **kwargs)
            return Result(**raw)

        async def create_widget(self, **kwargs: typing.Any) -> typing.Any:
            raw = await _WidgetHandlers.create_widget(self, **kwargs)
            return Result(**raw)

        async def patch_widget(self, **kwargs: typing.Any) -> typing.Any:
            raw = await _WidgetHandlers.patch_widget(self, **kwargs)
            return Result(**raw)

        async def echo_json(self, **kwargs: typing.Any) -> typing.Any:
            raw = await _WidgetHandlers.echo_json(self, **kwargs)
            return Result(**raw)

    app = FastAPI()
    app.include_router(generated_package.create_router(WidgetHandlers()))
    return TestClient(app)


def test_array_query_param_keeps_every_repeated_value(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    response = client.get("/widgets?tag=red&tag=blue&tag=green")

    assert response.status_code == 200
    assert response.json()["tag"] == ["red", "blue", "green"]


def test_array_query_param_defaults_to_an_empty_list_when_absent(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    response = client.get("/widgets")

    assert response.status_code == 200
    assert response.json()["tag"] == []


def test_query_param_enum_constraint_rejects_a_value_outside_it(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    ok = client.get("/widgets?status=active")
    bad = client.get("/widgets?status=deleted")

    assert ok.status_code == 200
    assert bad.status_code == 422


def test_query_param_range_constraint_rejects_a_value_outside_it(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    ok = client.get("/widgets?limit=50")
    too_low = client.get("/widgets?limit=0")
    too_high = client.get("/widgets?limit=101")

    assert ok.status_code == 200
    assert too_low.status_code == 422
    assert too_high.status_code == 422


def test_float_query_param_rejects_nan_and_infinity(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    finite = client.get("/widgets?score=1.5")
    nan = client.get("/widgets?score=nan")
    infinity = client.get("/widgets?score=inf")
    negative_infinity = client.get("/widgets?score=-infinity")

    assert finite.status_code == 200
    assert finite.json()["score"] == 1.5
    assert nan.status_code == 422
    assert infinity.status_code == 422
    assert negative_infinity.status_code == 422


def test_inline_json_body_is_parsed_and_passed_through_not_silently_dropped(
    generated_package: typing.Any,
) -> None:
    client = _widget_client(generated_package)

    response = client.post("/widgets", json={"name": "Widget A", "quantity": 3})

    assert response.status_code == 201
    assert response.json() == {"received": {"name": "Widget A", "quantity": 3}}


def test_inline_json_body_is_validated_against_its_hoisted_model(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    wrong_type = client.post("/widgets", json={"name": "Widget A", "quantity": "three"})
    too_long = client.post("/widgets", json={"name": "x" * 41, "quantity": 3})
    missing_field = client.post("/widgets", json={"quantity": 3})

    assert wrong_type.status_code == 422
    assert too_long.status_code == 422
    assert missing_field.status_code == 422


def test_required_json_body_that_is_absent_or_null_is_rejected_not_passed_as_none(
    generated_package: typing.Any,
) -> None:
    client = _widget_client(generated_package)

    absent = client.post("/widgets", content=b"", headers={"content-type": "application/json"})
    null = client.post("/widgets", content=b"null", headers={"content-type": "application/json"})
    schemaless_absent = client.post("/echo", content=b"", headers={"content-type": "application/json"})

    assert absent.status_code == 422
    assert null.status_code == 422
    assert schemaless_absent.status_code == 422


def test_optional_json_body_that_is_absent_reaches_the_handler_as_none(
    generated_package: typing.Any,
) -> None:
    client = _widget_client(generated_package)

    absent = client.patch("/widgets")
    present = client.patch("/widgets", json={"name": "B", "quantity": 1})
    invalid = client.patch("/widgets", json={"name": "B"})

    assert absent.status_code == 200
    assert absent.json() == {"received": None}
    assert present.json() == {"received": {"name": "B", "quantity": 1}}
    assert invalid.status_code == 422


def test_json_body_with_no_schema_is_passed_through_as_parsed(generated_package: typing.Any) -> None:
    client = _widget_client(generated_package)

    response = client.post("/echo", json={"anything": [1, 2]})

    assert response.status_code == 200
    assert response.json() == {"received": {"anything": [1, 2]}}


def test_json_body_over_max_bytes_rejected_with_413_before_before_handle_sees_it(
    generated_package: typing.Any,
) -> None:
    app = FastAPI()
    app.include_router(
        generated_package.create_router(_WidgetHandlersRaisingIfCalled(), max_json_body_bytes=8)
    )
    client = TestClient(app)

    # 9 raw bytes, one over the 8-byte cap.
    response = client.post("/widgets", content=b'{"n":123}', headers={"content-type": "application/json"})

    assert response.status_code == 413


class _WidgetHandlersRaisingIfCalled(_WidgetHandlers):
    async def create_widget(self, *, body: typing.Any) -> typing.Any:
        raise AssertionError("handler must not run for an over-limit body")
