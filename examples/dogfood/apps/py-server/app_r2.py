"""Dogfood pair 1 -- Python FastAPI server, round R2: adds a `delete_note`
handler for the new endpoint. Everything else is unchanged from
app_r0.py -- see ../../ROUNDS.md.
"""

from __future__ import annotations

import sys
import uuid

import uvicorn
from fastapi import FastAPI

from dogfood_notes import models
from dogfood_notes.server import create_router
from dogfood_notes.server.handlers import (
    CreateNoteResponse201,
    DeleteNoteResponse204,
    GetNoteResponse200,
    GetNoteResponse404,
    ListNotesResponse200,
)

_notes: dict[str, models.Note] = {}


class NotesHandlers:
    async def list_notes(self) -> ListNotesResponse200:
        return ListNotesResponse200(body=list(_notes.values()))

    async def get_note(
        self, *, note_id: str
    ) -> GetNoteResponse200 | GetNoteResponse404:
        note = _notes.get(note_id)
        if note is None:
            return GetNoteResponse404(body={"title": "Not Found", "status": 404})
        return GetNoteResponse200(body=note)

    async def create_note(self, *, body: models.NoteCreate) -> CreateNoteResponse201:
        note = models.Note(id=str(uuid.uuid4()), title=body.title, body=body.body)
        _notes[note.id] = note
        return CreateNoteResponse201(body=note)

    async def delete_note(self, *, note_id: str) -> DeleteNoteResponse204:
        _notes.pop(note_id, None)
        return DeleteNoteResponse204(body={})


def build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(create_router(NotesHandlers()))
    return app


def main() -> None:
    port = int(sys.argv[sys.argv.index("--port") + 1])
    uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
