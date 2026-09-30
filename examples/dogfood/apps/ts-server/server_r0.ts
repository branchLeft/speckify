/**
 * Dogfood pair 2 -- TypeScript node:http server, rounds R0/R1: implements
 * the generated `Handlers` interface for list/get/create, called by the
 * paired Python client (../py-client). R1 is a description-only spec edit,
 * so this same file is reused for it unchanged -- see ../../ROUNDS.md.
 */
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { Note } from '@example/dogfood-notes';
import { createServer, type Handlers } from '@example/dogfood-notes/server';

const notes = new Map<string, Note>();

const handlers: Handlers = {
  listNotes: async () => ({ status: 200, body: [...notes.values()] }),

  createNote: async (request) => {
    const note: Note = { id: randomUUID(), title: request.body.title, body: request.body.body };
    notes.set(note.id, note);
    return { status: 201, body: note };
  },

  getNote: async (request) => {
    const note = notes.get(request.path.noteId);
    if (note === undefined) {
      return { status: 404, body: { title: 'Not Found', status: 404 } };
    }
    return { status: 200, body: note };
  },
};

function main(): void {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  if (!Number.isInteger(port)) {
    throw new Error('missing --port');
  }
  const listener = createServer(handlers);
  createHttpServer(listener).listen(port, '127.0.0.1', () => {
    console.log(`listening on ${String(port)}`);
  });
}

main();
