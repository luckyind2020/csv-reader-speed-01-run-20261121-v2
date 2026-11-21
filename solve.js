// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// run({text, header}) returns {columns, rows, errors} exactly as the
// reference reader does, on every input. The reader's rules, as the
// competition states them:
//
//   - the text is read once, left to right, on commas and double quotes;
//     a U+FEFF at its very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record at all;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when the
//     field ends); a quote that never closes is a literal character, and
//     the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it, each padded with empty strings
//     (short_row, with fields: its field count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the
//     1-based line its record starts on, counting every LF, CRLF and lone
//     CR inside quotes, and row is its record's index in rows, null for
//     the header.
//
// Speed comes from never walking the text one character at a time where a
// native search will do: a record whose first line holds no quote at all
// is split in one native call, and unquoted fields are scanned with a
// tight charCodeAt loop that only stops at a delimiter, so the common
// case never allocates anything but the field strings themselves.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff;

// Design notes: the hot path is the whole-line fast path (a record whose first
// line has no quote and no CR splits natively). The slow path scans with tight
// charCodeAt loops and only allocates a new string for a field when the text
// cannot be returned as a slice (quoted rebuilds, junk, stray CRs). Nothing
// here is copied from the house baseline; the scanner is written from the
// competition's prose spec and probed against the reference oracle.
export function run(input) {
  const s = input.text;
  const headed = input.header === true;
  const n = s.length;
  let i = s.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;
  let first = true;
  let width = 0;
  let columns = null;
  const rows = [];
  const errors = [];

  // Close out one record's fields: the first record sets the width (and
  // becomes columns when there is a header); later ones are padded or cut
  // to it, with an error when they do not fit.
  function closeRecord(fields, recLine, recRow) {
    if (first) {
      width = fields.length;
      if (headed) columns = fields;
      else rows.push(fields);
      first = false;
      return;
    }
    const r = rows.length;
    if (fields.length < width) {
      const keep = fields.length;
      for (let k = keep; k < width; k++) fields.push('');
      errors.push({ code: 'short_row', line: recLine, row: r, fields: keep });
      rows.push(fields);
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: 'long_row', line: recLine, row: r, extra });
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  while (i < n) {
    const recLine = line;
    const recRow = headed && first ? null : rows.length;
    const recStart = i;
    let dropped = 0;

    // ---- whole-line fast path: no quote on this line, no stray CR ----
    const nl = s.indexOf('\n', i);
    const lineEnd = nl < 0 ? n : nl;
    let end = lineEnd;
    if (nl >= 0 && end > i && s.charCodeAt(end - 1) === CR) end -= 1;
    if (end === i) {
      // a line left with no characters is no record
      i = nl < 0 ? n : nl + 1;
      line += 1;
      continue;
    }
    const chunk = s.slice(i, end);
    if (chunk.indexOf('"') < 0 && chunk.indexOf('\r') < 0) {
      const fields = chunk.split(',');
      i = nl < 0 ? n : nl + 1;
      line += 1;
      closeRecord(fields, recLine, recRow);
      continue;
    }

    // ---- slow path: this record's first line holds a quote ----
    const fields = [];
    let recDone = false;
    while (!recDone) {
      let base = null;
      if (s.charCodeAt(i) === QUOTE) {
        // A quoted field: find the next quote that is not doubled, and
        // count the line breaks the span holds (each CRLF counts once).
        // The count is only kept when the quote does close: when it never
        // closes, the text is read again as unquoted and the breaks are
        // counted then instead.
        let k = i + 1;
        let close = -1;
        let breaks = 0;
        let doubled = false;
        let hasCr = false;
        while (k < n) {
          const c = s.charCodeAt(k);
          if (c === QUOTE) {
            if (s.charCodeAt(k + 1) === QUOTE) {
              doubled = true;
              k += 2;
              continue;
            }
            close = k;
            break;
          }
          if (c === LF) {
            breaks += 1;
            k += 1;
            continue;
          }
          if (c === CR) {
            breaks += 1;
            hasCr = true;
            k += s.charCodeAt(k + 1) === LF ? 2 : 1;
            continue;
          }
          k += 1;
        }
        if (close < 0) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          // fall through to the unquoted scan below, i unchanged
        } else {
          line += breaks;
          let value;
          if (!doubled && !hasCr) {
            value = s.slice(i + 1, close);
          } else {
            // Rebuild the span with "" as one quote and every CRLF or
            // lone CR as LF.
            const parts = [];
            let p = i + 1;
            let seg = p;
            while (p < close) {
              const c = s.charCodeAt(p);
              if (c === QUOTE) {
                parts.push(s.slice(seg, p), '"');
                p += 2;
                seg = p;
              } else if (c === CR) {
                parts.push(s.slice(seg, p), '\n');
                p += s.charCodeAt(p + 1) === LF ? 2 : 1;
                seg = p;
              } else {
                p += 1;
              }
            }
            parts.push(s.slice(seg, close));
            value = parts.join('');
          }
          base = value;
          const m = close + 1;
          if (m >= n) {
            fields.push(value);
            i = n;
            recDone = true;
            continue;
          }
          const c = s.charCodeAt(m);
          if (c === COMMA) {
            fields.push(value);
            i = m + 1;
            continue;
          }
          if (c === LF) {
            fields.push(value);
            i = m + 1;
            line += 1;
            recDone = true;
            continue;
          }
          if (c === CR && s.charCodeAt(m + 1) === LF) {
            fields.push(value);
            i = m + 2;
            line += 1;
            recDone = true;
            continue;
          }
          // Anything else after the closing quote is junk, appended as it
          // stands: keep scanning it as unquoted, from m.
          i = m;
        }
      }

      // ---- unquoted scan from i (a plain field, junk after a closing
      // quote, or the re-read after a quote that never closes) ----
      let acc = null;
      let accParts = null;
      let j = i;
      let ending = 2;
      for (;;) {
        let k = j;
        let c;
        while (k < n) {
          c = s.charCodeAt(k);
          if (c === COMMA || c === LF || c === CR) break;
          k += 1;
        }
        const seg = s.slice(j, k);
        if (acc === null) acc = seg;
        else {
          if (accParts === null) accParts = [acc];
          accParts.push(seg);
        }
        if (k >= n) {
          i = n;
          ending = 2;
          break;
        }
        c = s.charCodeAt(k);
        if (c === COMMA) {
          i = k + 1;
          ending = 0;
          break;
        }
        if (c === LF) {
          i = k + 1;
          line += 1;
          ending = 1;
          break;
        }
        if (s.charCodeAt(k + 1) === LF) {
          i = k + 2;
          line += 1;
          ending = 1;
          break;
        }
        // A CR not followed by LF is dropped, and the field goes on.
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        dropped += 1;
        j = k + 1;
      }
      const text = accParts === null ? acc ?? '' : accParts.join('');
      const field = base === null ? text : base + text;
      if (base !== null && text.length > 0) {
        errors.push({ code: 'quote_junk', line: recLine, row: recRow });
      }
      fields.push(field);
      if (ending === 0) continue;
      recDone = true;
    }

    // A record left with no characters at all (only dropped CRs) is no
    // record, though its errors still stand.
    if (i - recStart - dropped === 0) continue;
    closeRecord(fields, recLine, recRow);
  }

  if (headed && columns === null) columns = [];
  return { columns, rows, errors };
}
