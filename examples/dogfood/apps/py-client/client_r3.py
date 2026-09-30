"""Dogfood pair 2 -- Python client, round R3: R3 removed `body` from
Note's response representation, so the generated client `Note` model no
longer has a `body` attribute at all -- referencing `note.body` here would
raise `AttributeError` at import/run time (there is no static type checker
in this harness to catch it earlier -- see ../../ROUNDS.md). This file
drops both reads. `NoteCreate` is unaffected: a note's body is still
required to create one, it just isn't echoed back. Everything else is
unchanged from client_r2.py.
"""

from __future__ import annotations

import json
import sys

from dogfood_notes.client import Client
from dogfood_notes.client.api.default import create_note, delete_note, get_note, list_notes
from dogfood_notes.client.models import NoteCreate


def main() -> None:
    base_url = sys.argv[sys.argv.index("--base-url") + 1]
    client = Client(base_url=base_url)

    before = list_notes.sync_detailed(client=client)
    assert before.status_code == 200
    assert before.parsed == []

    created = create_note.sync_detailed(
        client=client, body=NoteCreate(title="Hello", body="From the Python client")
    )
    assert created.status_code == 201
    note = created.parsed
    assert note is not None

    fetched = get_note.sync_detailed(note_id=note.id, client=client)
    assert fetched.status_code == 200
    fetched_note = fetched.parsed
    assert fetched_note is not None

    after_create = list_notes.sync_detailed(client=client)
    assert after_create.status_code == 200
    assert after_create.parsed is not None

    deleted = delete_note.sync_detailed(note_id=note.id, client=client)
    assert deleted.status_code == 204

    after_delete = list_notes.sync_detailed(client=client)
    assert after_delete.status_code == 200
    assert after_delete.parsed is not None

    missing = get_note.sync_detailed(note_id=note.id, client=client)

    print(
        json.dumps(
            {
                "created": {
                    "id": note.id,
                    "title": note.title,
                    "tags": note.tags if note.tags else None,
                },
                "fetchedId": fetched_note.id,
                "listCountAfterCreate": len(after_create.parsed),
                "listCountAfterDelete": len(after_delete.parsed),
                "missingAfterDeleteWasNotFound": missing.status_code == 404,
            }
        )
    )


if __name__ == "__main__":
    main()
