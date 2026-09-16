/**
 * [pvb-repair] Split a stored frame payload into its JSON records.
 *
 * The payload is newline-delimited JSON, but the closing newline is not
 * guaranteed: the header frame and the final frame end without one, and a frame
 * boundary can therefore butt two documents together. So split on newlines and,
 * for a line that fails to parse alone, find the first document boundary with a
 * reviver — `key === ''` fires exactly when a top-level document closes, and its
 * holder stringifies back to that document's exact text.
 *
 * @param {string} text - the decoded frame payload.
 * @returns {object[]} the records, in order.
 */
export function parseFramePayload(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (looksLikeOneDocument(line)) {
      records.push(JSON.parse(line));
      continue;
    }
    records.push(...splitConcatenated(line));
  }
  return records;
}

/**
 * Whether a line parses as exactly one JSON document.
 * @param {string} line - one payload line.
 * @returns {boolean} whether it is a single document.
 */
function looksLikeOneDocument(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a line that carries more than one concatenated JSON document.
 * @param {string} line - the concatenated text.
 * @returns {object[]} the documents found.
 */
function splitConcatenated(line) {
  const found = [];
  let cursor = 0;
  while (cursor < line.length) {
    let consumed = -1;
    const parsed = JSON.parse(line.slice(cursor), function reviver(key, value) {
      if (key === '' && this !== undefined) consumed = JSON.stringify(this).length;
      return value;
    });
    if (consumed <= 0) throw new Error(`no document boundary at offset ${cursor}`);
    found.push(parsed);
    cursor += consumed;
  }
  return found;
}
