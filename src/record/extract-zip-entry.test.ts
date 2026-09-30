import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { extractZipEntry } from './extract-zip-entry.js';

/**
 * Builds a minimal, uncompressed (store-method) single-entry zip archive.
 * Good enough to exercise the extractor without pulling in a zip-writing
 * dependency this project has no other use for.
 */
function makeZip(fileName: string, content: string): Buffer {
  const nameBuffer = Buffer.from(fileName, 'utf8');
  const contentBuffer = Buffer.from(content, 'utf8');
  const checksum = crc32(contentBuffer);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(contentBuffer.length, 18);
  localHeader.writeUInt32LE(contentBuffer.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localEntry = Buffer.concat([localHeader, nameBuffer, contentBuffer]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(contentBuffer.length, 20);
  centralHeader.writeUInt32LE(contentBuffer.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralEntry = Buffer.concat([centralHeader, nameBuffer]);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralEntry.length, 12);
  endRecord.writeUInt32LE(localEntry.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, endRecord]);
}

describe('extractZipEntry', () => {
  it('extracts the matching entry from a zip archive', async () => {
    const zip = makeZip('pkg/openapi.json', '{"openapi":"3.0.3"}');

    const result = await extractZipEntry(zip, (name) => name.endsWith('/openapi.json'));
    expect(result?.toString('utf8')).toBe('{"openapi":"3.0.3"}');
  });

  it('returns null when no entry matches', async () => {
    const zip = makeZip('pkg/other.json', '{}');

    const result = await extractZipEntry(zip, (name) => name.endsWith('/openapi.json'));
    expect(result).toBeNull();
  });
});
