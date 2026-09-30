"""Dogfood pair 2 -- Python client, round R2: R2 added an optional `tags`
field to Note and a delete-note endpoint, both additive. The only code
change from client_r0.py is exercising `delete_note` and reading the new
(optional) `tags` field -- see ../../ROUNDS.md.
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
                    "body": note.body,
                    "tags": note.tags if note.tags else None,
                },
                "fetchedBody": fetched_note.body,
                "listCountAfterCreate": len(after_create.parsed),
                "listCountAfterDelete": len(after_delete.parsed),
                "missingAfterDeleteWasNotFound": missing.status_code == 404,
            }
        )
    )


if __name__ == "__main__":
    main()
