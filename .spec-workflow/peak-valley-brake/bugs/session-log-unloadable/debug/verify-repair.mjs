/**
 * [pvb-repair] Independently verify a repaired artifact against its backup.
 *
 * Two claims are checked, and neither is taken on trust:
 *  1. Nothing moved. Every record is compared, in order, against the backup.
 *  2. The harness itself now accepts the log — through its real
 *     `validateStoredEvents`, the function that refused it, over the events only.
 *     The leading header row is metadata consumed before event validation, so it
 *     must not be fed to the event validator (doing so is what made a previous
 *     run of this check report a false refusal).
 *
 * Usage: node verify-repair.mjs <artifact> <backup>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

import { parseFramePayload } from './json-stream.mjs';

const PERSISTENCE = 'file:///D:/SoftWare/DSH/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js';
const KNOWN_TYPES = 'D:\\SoftWare\\DSH\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-session\\lib\\types\\known-event-types.js';
const ZSTD_MAGIC = 0xfd2fb528;

/** Locate complete Zstandard frames without decompressing them. */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decode every record of an artifact, in order. */
function readRecords(buffer) {
  const frames = scanZstdFrames(buffer);
  const records = [];
  for (const frame of frames) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    records.push(...parseFramePayload(text));
  }
  return records;
}

const artifact = process.argv[2];
const backup = process.argv[3];

const before = readRecords(readFileSync(backup));
const after = readRecords(readFileSync(artifact));
console.log(`[verify] records: backup=${before.length} repaired=${after.length}`);

const diffs = [];
for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
  if (JSON.stringify(before[index]) === JSON.stringify(after[index])) continue;
  diffs.push({ index, before: before[index], after: after[index] });
}
console.log(`[verify] changed records: ${diffs.length}`);
for (const diff of diffs) {
  console.log(`  index ${diff.index}: seq ${diff.before?.seq} type ${diff.before?.type}`);
  console.log(`    before: ${JSON.stringify(diff.before)}`);
  console.log(`    after : ${JSON.stringify(diff.after)}`);
}

// The header row: metadata, not an event. Its presence is asserted, not validated.
const headerIndex = after.findIndex((record) => record.type === 'session' && record.version !== undefined);
const header = after[headerIndex];
console.log(`[verify] header at index ${headerIndex}: ${JSON.stringify(header)}`);
const events = after.filter((_, index) => index !== headerIndex);
console.log(`[verify] events (header excluded): ${events.length}`);

const knownSource = readFileSync(KNOWN_TYPES, 'utf8');
const KNOWN = new Set([...knownSource.matchAll(/^\s*'([^']+)',\s*$/gmu)].map((match) => match[1]));
const unloadable = events.filter((event) => !KNOWN.has(event.type) && event.ignorable !== true);
console.log(`[verify] events outside the vocabulary and not ignorable: ${unloadable.length} ${JSON.stringify(unloadable)}`);

const { validateStoredEvents } = await import(PERSISTENCE);
const meta = { id: header.id, version: header.version, createdAt: header.createdAt };
try {
  const validated = validateStoredEvents(meta, structuredClone(events), undefined);
  console.log(`[verify] validateStoredEvents: LOADED (${validated.length} events adopted)`);
} catch (error) {
  console.log(`[verify] validateStoredEvents: REFUSED -> ${error.constructor.name}: ${error.message}`);
  process.exitCode = 1;
}

const repairedEvents = events.filter((event) => event.type === 'peak-valley-brake/change');
console.log(`[verify] the two records keep their payload:`);
for (const event of repairedEvents) {
  console.log(`  seq ${event.seq}: ignorable=${String(event.ignorable)} phase=${event.data?.phase} heldCount=${event.data?.heldCount} engaged=${String(event.data?.engaged)}`);
}
