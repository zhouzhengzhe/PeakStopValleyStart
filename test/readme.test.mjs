/**
 * Self-check that the Chinese README keeps the same structure as the English one.
 *
 * Run with `node test/readme.test.mjs`.
 *
 * A translated README rots silently: a section is added to one file and not the
 * other, and the reader of the stale language never learns what they are missing.
 * Structure is what can be checked mechanically, so it is: heading levels and
 * count, fenced code blocks, table rows, and the language links each file points
 * back at. Prose is deliberately not compared — a translation is not a diff.
 *
 * @module peak-valley-brake/test/readme
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => Promise<void> | void} body - case body.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(caseName, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Extract the structural skeleton of a Markdown document.
 *
 * Fenced blocks are skipped entirely: they contain shell transcripts whose
 * `#` comment lines would otherwise be counted as headings, and a log line in
 * Chinese inside a fence would then look like a missing section.
 *
 * @param {string} markdown - document text.
 * @returns {{headings: {level: number, text: string}[], fences: number, tableRows: number}} the skeleton.
 */
function skeleton(markdown) {
  const headings = [];
  let fences = 0;
  let tableRows = 0;
  let inFence = false;
  // Split on any line ending: a file written by a Windows editor has CRLF, and a
  // trailing `\r` otherwise defeats every `$`-anchored pattern below, because
  // JavaScript's `$` without the `m` flag does not match before a line terminator.
  for (const line of markdown.split(/\r?\n/u)) {
    if (line.trimStart().startsWith('```')) {
      fences += 1;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A heading is hashes followed by text. The greedy tail tolerates trailing
    // whitespace; the `\S` keeps a bare-hash separator line out.
    const heading = /^(#{1,6})\s+(.*\S)\s*$/u.exec(line);
    if (heading !== null) headings.push({ level: heading[1].length, text: heading[2].trim() });
    if (/^\s*\|.*\|\s*$/u.test(line)) tableRows += 1;
  }
  return { headings, fences, tableRows };
}

const en = await readFile(join(root, 'README.md'), 'utf8');
const zh = await readFile(join(root, 'README.zh.md'), 'utf8');
const enSkeleton = skeleton(en);
const zhSkeleton = skeleton(zh);

process.stdout.write('peak-valley-brake README parity\n\n');

await test('both READMEs exist and are substantial', () => {
  assert.ok(en.length > 5_000, 'the English README looks truncated');
  assert.ok(zh.length > 3_000, 'the Chinese README looks like a stub');
});

await test('both READMEs carry the same number of sections', () => {
  assert.equal(
    zhSkeleton.headings.length,
    enSkeleton.headings.length,
    `English has ${enSkeleton.headings.length} headings, Chinese has ${zhSkeleton.headings.length}`,
  );
});

await test('the section nesting is identical', () => {
  const enLevels = enSkeleton.headings.map((heading) => heading.level);
  const zhLevels = zhSkeleton.headings.map((heading) => heading.level);
  assert.deepEqual(zhLevels, enLevels, 'a section was added, removed, or re-levelled in one language only');
});

await test('the sections appear in the same order', () => {
  // The headings themselves are translated, so order is checked positionally:
  // section N of one language must sit at the same nesting level as section N of
  // the other, which the level comparison above covers. This adds the check that
  // a *reordering* is not hiding behind matching levels.
  const pairUp = (headings) => headings.map((heading, index) => `${index}:${heading.level}`);
  assert.deepEqual(pairUp(zhSkeleton.headings), pairUp(enSkeleton.headings));
});

await test('both READMEs carry the same number of code blocks', () => {
  assert.equal(zhSkeleton.fences, enSkeleton.fences, 'a fenced block exists in one language only');
  assert.equal(enSkeleton.fences % 2, 0, 'the English README has an unclosed fence');
  assert.equal(zhSkeleton.fences % 2, 0, 'the Chinese README has an unclosed fence');
});

await test('both READMEs carry the same number of table rows', () => {
  assert.equal(zhSkeleton.tableRows, enSkeleton.tableRows, 'a table gained or lost rows in one language only');
});

await test('each README offers a link to the other', () => {
  assert.match(en, /\[中文\]\(README\.zh\.md\)/u, 'the English README must link to the Chinese one');
  assert.match(zh, /\[English\]\(README\.md\)/u, 'the Chinese README must link back to the English one');
});

await test('the language link is the first thing after the title', () => {
  for (const [label, markdown] of [['README.md', en], ['README.zh.md', zh]]) {
    const lines = markdown.split('\n').filter((line) => line.trim() !== '');
    assert.match(lines[0], /^# /u, `${label} must open with a level-1 title`);
    assert.match(lines[1], /README(\.zh)?\.md/u, `${label} must place the language link directly under the title`);
  }
});

await test('commands shown in both READMEs are identical where they must be', () => {
  // Flags, config keys and paths are not translated; a drifted command line in
  // one language would send its reader down a different path than the other.
  const commands = (markdown) =>
    markdown
      .split('\n')
      .filter((line) => line.includes('test/') && line.includes('.mjs'))
      .map((line) => line.split('#')[0].trim())
      .filter((line) => line.startsWith('node '))
      .sort();
  assert.deepEqual(commands(zh), commands(en), 'the documented test commands diverged');
});

await test('the config table documents the same keys in both languages', () => {
  const keys = (markdown) => {
    const found = new Set();
    for (const line of markdown.split('\n')) {
      const match = /^\|\s*`([a-zA-Z][A-Za-z0-9]*)`\s*\|/u.exec(line);
      if (match !== null) found.add(match[1]);
    }
    return [...found].sort();
  };
  assert.deepEqual(keys(zh), keys(en), 'a configuration key is documented in one language only');
});

await test('the install instructions work for someone who is not the author', () => {
  // Reported: the install section read `add link:D:\SoftDocument\DSHProject\...` — the
  // author's own working copy. Nobody else has that path, and an install section is read
  // almost exclusively by people who are not the author. A repository can be published
  // and still be uninstallable, and nothing else here would have noticed.
  for (const [name, markdown] of [['README.md', en], ['README.zh.md', zh]]) {
    // A drive letter at the start of a path: `C:\...`, `D:/...`. The lookbehind keeps
    // `https://` out of it, where the colon is preceded by a letter.
    const absolute = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/u.exec(markdown);
    assert.equal(absolute, null, `${name} names an absolute local path (${absolute?.[0]}), which only works on the author's machine`);
    assert.match(
      markdown,
      /dsh plugin --profile \w+ add github:[\w.-]+\/[\w.-]+/u,
      `${name} must install from the repository, not from a directory`,
    );
    assert.ok(
      markdown.indexOf('github:zhouzhengzhe/PeakStopValleyStart') >= 0,
      `${name} must name the repository it is the README of`,
    );
  }
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
