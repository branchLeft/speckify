import { fromBufferPromise } from 'yauzl';

/**
 * Extracts the first entry matching `isMatch` from a zip archive (a Python
 * wheel), or `null` if no entry matches.
 */
export async function extractZipEntry(
  buffer: Buffer,
  isMatch: (entryName: string) => boolean,
): Promise<Buffer | null> {
  const zipFile = await fromBufferPromise(buffer, { lazyEntries: true });
  try {
    for await (const entry of zipFile.eachEntry()) {
      if (isMatch(entry.fileName)) {
        const stream = await zipFile.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
    }
    return null;
  } finally {
    zipFile.close();
  }
}
