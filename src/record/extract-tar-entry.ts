import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

import { extract } from 'tar-stream';

/**
 * Extracts the first entry matching `isMatch` from a gzip-compressed tarball
 * (an npm package tarball), or `null` if no entry matches.
 */
export async function extractTarGzEntry(
  tarballGz: Buffer,
  isMatch: (entryName: string) => boolean,
): Promise<Buffer | null> {
  const tarBuffer = gunzipSync(tarballGz);

  return new Promise((resolvePromise, reject) => {
    const extractor = extract();
    let found: Buffer | null = null;

    extractor.on('entry', (header, stream, next) => {
      if (found === null && isMatch(header.name)) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: unknown) => {
          chunks.push(chunk as Buffer);
        });
        stream.on('end', () => {
          found = Buffer.concat(chunks);
          next();
        });
        stream.on('error', reject);
      } else {
        stream.on('end', () => {
          next();
        });
        stream.resume();
      }
    });

    extractor.on('finish', () => {
      resolvePromise(found);
    });
    extractor.on('error', reject);

    Readable.from(tarBuffer).pipe(extractor);
  });
}
