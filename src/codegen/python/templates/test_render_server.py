"""Tests the server templates for real: renders them, drops the result next
to a hand-written models module (standing in for datamodel-code-generator's
output, which client.test.ts and models.test.ts already exercise for real),
and round-trips a FastAPI TestClient through the generated router.
"""

from __future__ import annotations

import sys
import textwrap
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

MODELS_PY = textwrap.dedent(
    """
    from __future__ import annotations

    import typing

    import pydantic


    class Cat(pydantic.BaseModel):
        pet_type: typing.Literal["cat"] = pydantic.Field(alias="petType")
        meow_volume: int = pydantic.Field(alias="meowVolume")
        model_config = pydantic.ConfigDict(populate_by_name=True)


    class Dog(pydantic.BaseModel):
        pet_type: typing.Literal["dog"] = pydantic.Field(alias="petType")
        bark_volume: int = pydantic.Field(alias="barkVolume")
        model_config = pydantic.ConfigDict(populate_by_name=True)


    Pet = pydantic.RootModel[typing.Annotated[typing.Union[Cat, Dog], pydantic.Field(discriminator="pet_type")]]
    """
)


@pytest.fixture()
def generated_package(tmp_path: Path) -> typing.Any:
    """Builds <tmp_path>/testpkg/{models.py, server/} and imports testpkg.server."""
    package_dir = tmp_path / "testpkg"
    package_dir.mkdir()
    (package_dir / "__init__.py").write_text("", encoding="utf-8")
    (package_dir / "models.py").write_text(MODELS_PY, encoding="utf-8")

    operations = parse_operations([CREATE_PET, UPLOAD_BLOB])
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
