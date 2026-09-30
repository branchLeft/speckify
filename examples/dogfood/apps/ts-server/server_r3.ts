/**
 * Dogfood pair 2 -- TypeScript node:http server, round R3: R3 removed
 * `body` from Note's response representation, so the generated `Note` type
 * has no `body` property at all -- `createNote` simply stops assigning
 * one. `request.body.body` (the create request's own body field) is still
 * required and is read here, just never stored or echoed back. Everything
 * else is unchanged from server_r2.ts -- see ../../ROUNDS.md.
 */
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { Note } from '@example/dogfood-notes';
import { createServer, type Handlers } from '@example/dogfood-notes/server';

const notes = new Map<string, Note>();

const handlers: Handlers = {
  listNotes: async () => ({ status: 200, body: [...notes.values()] }),

  createNote: async (request) => {
    void request.body.body;
    const note: Note = { id: randomUUID(), title: request.body.title };
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

  deleteNote: async (request) => {
    notes.delete(request.path.noteId);
    return { status: 204, body: undefined };
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
