/**
 * Dogfood pair 1 -- TypeScript client, round R3: R3 removed `body` from
 * Note's response representation. Unlike R2, this one isn't optional --
 * `note.body` and `fetched.data.body` no longer typecheck at all (`Note`
 * has no `body` property), so this file drops both reads. That's the one
 * required edit; everything else is unchanged from client_r2.ts -- see
 * ../../ROUNDS.md.
 */
import { client, createNote, deleteNote, getNote, listNotes } from '@example/dogfood-notes';

async function main(): Promise<void> {
  const baseUrl = process.argv[process.argv.indexOf('--base-url') + 1];
  if (baseUrl === undefined) {
    throw new Error('missing --base-url');
  }
  client.setConfig({ baseUrl });

  const before = await listNotes();
  if (before.data === undefined) {
    throw new Error('listNotes (before) failed');
  }
  if (before.data.length !== 0) {
    throw new Error('expected an empty note list at start');
  }

  const created = await createNote({ body: { title: 'Hello', body: 'From the TS client' } });
  if (created.data === undefined) {
    throw new Error('createNote failed');
  }
  const note = created.data;

  const fetched = await getNote({ path: { noteId: note.id } });
  if (fetched.data === undefined) {
    throw new Error('getNote failed');
  }

  const afterCreate = await listNotes();
  if (afterCreate.data === undefined) {
    throw new Error('listNotes (after create) failed');
  }

  const deleted = await deleteNote({ path: { noteId: note.id } });
  if (deleted.error !== undefined) {
    throw new Error('deleteNote failed');
  }

  const afterDelete = await listNotes();
  if (afterDelete.data === undefined) {
    throw new Error('listNotes (after delete) failed');
  }

  const missing = await getNote({ path: { noteId: note.id } });

  console.log(
    JSON.stringify({
      created: { id: note.id, title: note.title, tags: note.tags ?? null },
      fetchedId: fetched.data.id,
      listCountAfterCreate: afterCreate.data.length,
      listCountAfterDelete: afterDelete.data.length,
      missingAfterDeleteWasError: missing.error !== undefined,
    }),
  );
}

void main();
