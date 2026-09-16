/**
 * [pvb-repair] Make one damaged session log loadable again, then prove it.
 *
 * The damage: two `peak-valley-brake/change` session events were written without
 * the envelope's `ignorable: true` marker. The harness resolves a stored log
 * against a vocabulary generated from its own repository, so those two records
 * make the persistence read path refuse all 9244 records of the session.
 *
 * The repair is a surgical splice: only the frames carrying those records are
 * re-encoded, with `ignorable: true` added. Every other byte is copied through
 * untouched, and frame boundaries come from the storage layer's own algorithm so
 * the container stays valid.
 *
 * Verification uses the harness's real `validateStoredEvents` — the exact
 * function that refuses the log — not a reimplementation, plus a record-by-record
 * diff against the backup to prove nothing else moved.
 *
 * Usage: node repair.mjs <artifact> <backup-dir>
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { parseFramePayload } from './json-stream.mjs';

const PERSISTENCE = 'file:///D:/SoftWare/DSH/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js';
const KNOWN_TYPES = 'D:\\SoftWare\\DSH\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-session\\lib\\types\\known-event-types.js';

const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const OFFENDING_TYPE = 'peak-valley-brake/change';

/**
 * Locate every complete Zstandard frame without decompressing it.
 * Mirrors `scanZstdFrames` in the jsonl persistence backend.
 * @param {Buffer} buffer - complete artifact bytes.
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}} the layout.
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Decode every record of an artifact, in order.
 * @param {Buffer} buffer - complete artifact bytes.
 * @returns {object[]} the records.
 */
function readRecords(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  if (tornStart !== undefined) throw new Error(`torn artifact at byte ${tornStart}`);
  const records = [];
  for (const frame of frames) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    records.push(...parseFramePayload(text));
  }
  return records;
}

/** Stable one-line identity of a record, for diffing. */
const identity = (record) => JSON.stringify(record);

const artifact = process.argv[2];
const backupDir = process.argv[3];

const original = readFileSync(artifact);
const { frames, tornStart } = scanZstdFrames(original);
if (tornStart !== undefined) throw new Error(`refusing to repair a torn artifact at byte ${tornStart}`);
console.log(`[pvb-repair] artifact  : ${original.length} bytes, ${frames.length} frames`);

const backup = join(backupDir, `${basename(artifact)}.pre-repair`);
mkdirSync(backupDir, { recursive: true });
copyFileSync(artifact, backup);
console.log(`[pvb-repair] backup    : ${backup}`);

// Rebuild, re-encoding only the frames that carry an offending record.
const parts = [];
const repairedSeqs = [];
for (const frame of frames) {
  const bytes = original.subarray(frame.start, frame.end);
  const records = parseFramePayload(zstdDecompressSync(bytes).toString('utf8'));
  let changed = false;
  for (const record of records) {
    if (record.type !== OFFENDING_TYPE || record.ignorable === true) continue;
    record.ignorable = true;
    repairedSeqs.push(record.seq);
    changed = true;
  }
  parts.push(
    changed
      ? zstdCompressSync(Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS)
      : bytes,
  );
}
if (repairedSeqs.length === 0) throw new Error('nothing to repair');
console.log(`[pvb-repair] marked    : ${repairedSeqs.length} record(s) at seq ${JSON.stringify(repairedSeqs)}`);

const repairedBytes = Buffer.concat(parts);
const temporary = `${artifact}.repair-tmp`;
writeFileSync(temporary, repairedBytes);
renameSync(temporary, artifact);
console.log(`[pvb-repair] written   : ${repairedBytes.length} bytes (delta ${repairedBytes.length - original.length})`);

// ---- verification -----------------------------------------------------------------

const { validateStoredEvents } = await import(PERSISTENCE);
const knownSource = readFileSync(KNOWN_TYPES, 'utf8');
const KNOWN = new Set([...knownSource.matchAll(/^\s*'([^']+)',\s*$/gmu)].map((match) => match[1]));

const before = readRecords(readFileSync(backup));
const after = readRecords(readFileSync(artifact));
console.log(`\n[pvb-verify] records before/after: ${before.length} / ${after.length}`);

if (before.length !== after.length) throw new Error('record count changed');
const diffs = [];
for (let index = 0; index < before.length; index += 1) {
  if (identity(before[index]) === identity(after[index])) continue;
  diffs.push({ index, seq: after[index].seq, type: after[index].type, ignorable: after[index].ignorable });
}
console.log(`[pvb-verify] records that changed: ${diffs.length} ${JSON.stringify(diffs)}`);

const header = after.find((record) => record.version !== undefined && record.id !== undefined);
const meta = { id: header.id, version: header.version, createdAt: header.createdAt };

// Every record must decode through the harness's own read path.
const unknown = [];
for (const record of after) {
  if (record.type === undefined) continue;
  if (!KNOWN.has(record.type) && record.ignorable !== true) unknown.push({ seq: record.seq, type: record.type });
}
console.log(`[pvb-verify] unloadable records remaining: ${unknown.length} ${JSON.stringify(unknown)}`);

try {
  validateStoredEvents(meta, structuredClone(after), undefined);
  console.log('[pvb-verify] validateStoredEvents: LOADED');
} catch (error) {
  console.log(`[pvb-verify] validateStoredEvents: REFUSED -> ${error.constructor.name}: ${error.message}`);
  throw error;
}

// The repaired records must keep their payload: the badge state is now history.
const repairedRecords = after.filter((record) => record.type === OFFENDING_TYPE);
console.log(`[pvb-verify] offending records now: ${JSON.stringify(repairedRecords.map((r) => ({ seq: r.seq, ignorable: r.ignorable, phase: r.data?.phase, heldCount: r.data?.heldCount })))}`);
