"""Dogfood pair 2 -- Python client, rounds R0/R1: calls the generated
`list_notes`/`get_note`/`create_note` SDK against the paired TypeScript
node:http server (../ts-server). R1 is a description-only spec edit, so
this same file is reused for it unchanged -- see ../../ROUNDS.md.
"""

from __future__ import annotations

import json
import sys

from dogfood_notes.client import Client
from dogfood_notes.client.api.default import create_note, get_note, list_notes
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

    after = list_notes.sync_detailed(client=client)
    assert after.status_code == 200
    assert after.parsed is not None

    print(
        json.dumps(
            {
                "created": {"id": note.id, "title": note.title, "body": note.body},
                "fetchedBody": fetched_note.body,
                "listCount": len(after.parsed),
            }
        )
    )


if __name__ == "__main__":
    main()
