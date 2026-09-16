/**
 * [pvb-repro] Read-only contamination scan across every stored session log.
 *
 * Uses the storage layer's frame algorithm and exact record parsing, so the
 * verdict matches what the persistence read path will actually decide.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { parseFramePayload } from './json-stream.mjs';

const MAGIC = 0xfd2fb528;
const KNOWN_TYPES = process.argv[2];
const root = process.argv[3];
const knownSource = readFileSync(KNOWN_TYPES, 'utf8');
const KNOWN = new Set([...knownSource.matchAll(/^\s*'([^']+)',\s*$/gmu)].map((match) => match[1]));

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (/^session.*\.jsonl/u.test(entry)) found.push(full);
  }
  return found;
}

function framesOf(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved bit at ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const header = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = (header & 1) !== 0;
      const type = (header >>> 1) & 3;
      const size = header >>> 3;
      if (type === 3) throw new Error(`reserved block type at ${offset - 3}`);
      offset += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

let loadable = 0;
let broken = 0;

for (const file of walk(root)) {
  let records;
  try {
    records = [];
    const buffer = readFileSync(file);
    for (const frame of framesOf(buffer)) {
      records.push(...parseFramePayload(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')));
    }
  } catch (error) {
    console.log(`UNREADABLE ${file} -> ${String(error)}`);
    continue;
  }
  const header = records.find((record) => record.type === 'session' && record.version !== undefined);
  const events = records.filter((record) => record !== header);
  const blocking = events.filter((event) => !KNOWN.has(event.type) && event.ignorable !== true);
  const ignorable = events.filter((event) => !KNOWN.has(event.type) && event.ignorable === true);

  if (blocking.length === 0) {
    loadable += 1;
    console.log(`LOADABLE   ${header?.id ?? file}  (${records.length} records${ignorable.length > 0 ? `, ${ignorable.length} ignorable foreign event(s)` : ''})`);
    continue;
  }
  broken += 1;
  console.log(`\nUNLOADABLE ${header?.id ?? file}  (${records.length} records)`);
  console.log(`  ${file}`);
  const byType = new Map();
  for (const event of blocking) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  for (const [type, count] of byType) console.log(`  blocking type=${type} count=${count}`);
}

console.log(`\n[pvb-repro] loadable=${loadable} unloadable=${broken}`);
