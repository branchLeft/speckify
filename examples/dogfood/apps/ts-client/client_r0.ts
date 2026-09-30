/**
 * Dogfood pair 1 -- TypeScript client, rounds R0/R1: exercises the
 * generated `listNotes`/`getNote`/`createNote` SDK against the paired
 * Python FastAPI server (../py-server). R1 is a description-only spec
 * edit, so this same file is reused for it unchanged -- see ../../ROUNDS.md.
 * Guards below check `result.data === undefined`, not `result.error !==
 * undefined`: the latter narrows `error` but not `data` (see ROUNDS.md).
 */
import { client, createNote, getNote, listNotes } from '@example/dogfood-notes';

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

  const after = await listNotes();
  if (after.data === undefined) {
    throw new Error('listNotes (after) failed');
  }

  console.log(
    JSON.stringify({
      created: { id: note.id, title: note.title, body: note.body },
      fetchedBody: fetched.data.body,
      listCount: after.data.length,
    }),
  );
}

void main();
