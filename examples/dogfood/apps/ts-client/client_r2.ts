/**
 * Dogfood pair 1 -- TypeScript client, round R2: R2 added an optional
 * `tags` field to Note and a delete-note endpoint, both additive. The only
 * code change from client_r0.ts is exercising `deleteNote` and reading the
 * new (optional) `tags` field. Guards check `result.data === undefined`
 * where `.data` is read afterwards, not `result.error !== undefined` --
 * see client_r0.ts and ROUNDS.md.
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
      created: { id: note.id, title: note.title, body: note.body, tags: note.tags ?? null },
      fetchedBody: fetched.data.body,
      listCountAfterCreate: afterCreate.data.length,
      listCountAfterDelete: afterDelete.data.length,
      missingAfterDeleteWasError: missing.error !== undefined,
    }),
  );
}

void main();
