/**
 * Plain text out of Word, Excel and PowerPoint files, with no shell and no library.
 *
 * The agent that cannot run a command cannot unzip a .docx, and a .docx is a zip
 * of XML. Reading the file here, inside the Slack tool server, gives her the
 * words without giving her Bash. Node already ships the one piece that needs
 * code, `zlib`, so there is no dependency to audit.
 *
 * The file is untrusted. Nothing here runs it: a zip is parsed by offset, names
 * inside the archive are only ever looked up and never used as a path, and macros
 * live in a part this never opens. Three ceilings bound the work a hostile file
 * can ask for: bytes inflated per part and in total, rows and columns per sheet,
 * and sheets and slides read. The XML is walked tag by tag with `indexOf`, so the
 * time spent is linear in its size: a lazy regular expression over a part with
 * unclosed tags would rescan to the end of the part for every tag, and a 64 MB
 * part would hang the tool server. There is no DOM, so no entity expansion either.
 */
import { inflateRawSync } from 'node:zlib';

/** Most bytes one archive entry may inflate to. A big sheet is tens of MB of XML. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Most bytes all the parts read from one archive may inflate to, together. */
export const MAX_TOTAL_INFLATED_BYTES = 128 * 1024 * 1024;

/** Most characters of text handed back. Past this the reader gets a note, not a wall. */
export const MAX_TEXT_CHARS = 400_000;

/** Rows and columns kept per sheet, and the sheets and slides read. */
export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEET_COLS = 300;
export const MAX_SHEETS = 50;
export const MAX_SLIDES = 500;

const MAX_ENTRIES = 20_000;

/** A tag longer than this is read only as far as this: no real attribute list is longer. */
const MAX_TAG_CHARS = 4096;

/** The file kinds this reads, from the name Slack gives. Old binary formats are not among them. */
export function officeKind(name) {
  const m = /\.(docx|xlsx|pptx)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Names of the legacy formats, so the agent is told why they fail and what to ask for. */
export function isLegacyOffice(name) {
  return /\.(doc|xls|ppt)$/i.test(String(name || ''));
}

/** A refusal whose message is fit to show the agent as it stands. */
class OfficeError extends Error {}

/** Raised when the parts read together would inflate past the total ceiling. */
class BudgetError extends OfficeError {
  constructor() {
    super(`Refused: the file inflates to more than ${MAX_TOTAL_INFLATED_BYTES} bytes in total.`);
  }
}

/**
 * The entries of a zip, by name, as lazy readers.
 *
 * Each read draws on one shared budget of inflated bytes, so a file of many small
 * claims cannot add up to more than the ceiling.
 *
 * @returns {{ entries: Map<string, () => Buffer> } | { error: string }}
 */
export function openZip(buf, { totalBudget = MAX_TOTAL_INFLATED_BYTES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { error: 'Not a zip file (too short).' };

  // The end-of-central-directory record sits in the last 64 KB plus 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { error: 'Not a zip file (no directory found). It may be damaged or not an Office file.' };

  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) return { error: 'Zip64 archives are not supported.' };
  if (count > MAX_ENTRIES) return { error: `Refused: the archive lists ${count} entries.` };

  let spent = 0;
  const entries = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { error: 'The zip directory is damaged.' };
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    entries.set(name, () => {
      if (flags & 1) throw new OfficeError('The file is password-protected.');
      if (usize > MAX_ENTRY_BYTES) throw new OfficeError(`"${name}" is too large to read.`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new OfficeError('The zip is damaged.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + csize > buf.length) throw new OfficeError('The zip is damaged.');
      const raw = buf.subarray(start, start + csize);
      let out;
      if (method === 0) out = Buffer.from(raw);
      else if (method === 8) {
        // Stops at whichever ceiling is nearer, and only ever one byte past it.
        const room = Math.min(MAX_ENTRY_BYTES, totalBudget - spent);
        if (room <= 0) throw new BudgetError();
        try {
          out = inflateRawSync(raw, { maxOutputLength: room });
        } catch (err) {
          if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
            if (room < MAX_ENTRY_BYTES) throw new BudgetError();
            throw new OfficeError(`Refused: "${name}" inflates to more than ${MAX_ENTRY_BYTES} bytes.`);
          }
          throw err;
        }
      } else throw new OfficeError(`Unsupported compression method ${method}.`);
      spent += out.length;
      if (spent > totalBudget) throw new BudgetError();
      return out;
    });
  }
  return { entries };
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character references and the five named entities. Anything else stays as written. */
export function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref) => {
    if (ref[0] !== '#') return ENTITY[ref.toLowerCase()];
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/** Attributes of one tag's text, e.g. ` r="B3" t="s"` becomes { r: 'B3', t: 's' }. */
function attrs(tagBody) {
  const out = {};
  for (const m of String(tagBody).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

/**
 * Every tag of an XML part, in order, in time linear in its length.
 *
 * Yields { name, closing, selfClose, attrText, text }, where `text` is what sits
 * between this tag and the next one. Comments and CDATA are skipped, as is a part
 * that stops mid-tag.
 */
function* xmlTags(xml) {
  let i = 0;
  while (true) {
    i = xml.indexOf('<', i);
    if (i < 0) return;
    if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e < 0) return;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const e = xml.indexOf(']]>', i + 9);
      if (e < 0) return;
      i = e + 3;
      continue;
    }
    const end = xml.indexOf('>', i + 1);
    if (end < 0) return;
    const body = xml.slice(i + 1, Math.min(end, i + 1 + MAX_TAG_CHARS));
    const m = /^(\/?)([^\s/>]+)/.exec(body);
    const next = xml.indexOf('<', end + 1);
    if (m) {
      yield {
        name: m[2],
        closing: m[1] === '/',
        selfClose: xml[end - 1] === '/',
        attrText: body.slice(m[0].length),
        text: xml.slice(end + 1, next < 0 ? xml.length : next),
      };
    }
    i = end + 1;
  }
}

const tidy = (s) =>
  s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Word: every run of text, with paragraph, line, tab and table-cell breaks kept. */
export function docxText(xml) {
  const out = [];
  let inTabStops = false;
  for (const t of xmlTags(xml)) {
    if (t.name === 'w:tabs') inTabStops = !t.closing && !t.selfClose;
    else if (t.closing) {
      if (t.name === 'w:p') out.push('\n');
      else if (t.name === 'w:tc') {
        // A cell ends its last paragraph with a newline; a table row reads better on one line.
        if (out[out.length - 1] === '\n') out.pop();
        out.push('\t');
      } else if (t.name === 'w:tr') {
        if (out[out.length - 1] === '\t') out.pop();
        out.push('\n');
      }
    } else if (t.name === 'w:t') {
      if (!t.selfClose) out.push(decodeXml(t.text));
    } else if (t.name === 'w:tab') {
      // Tab stops in a paragraph's settings are <w:tab> too, and are not text.
      if (!inTabStops) out.push('\t');
    } else if (t.name === 'w:br' || t.name === 'w:cr') out.push('\n');
  }
  return tidy(out.join(''));
}

/** PowerPoint: the text of one slide, a line per paragraph. */
export function slideText(xml) {
  const out = [];
  for (const t of xmlTags(xml)) {
    if (t.closing) {
      if (t.name === 'a:p') out.push('\n');
    } else if (t.name === 'a:t') {
      if (!t.selfClose) out.push(decodeXml(t.text));
    } else if (t.name === 'a:br') out.push('\n');
  }
  return tidy(out.join(''));
}

/** 0-based column from a cell reference: A is 0, Z is 25, AA is 26. */
function columnOf(ref) {
  const letters = /^[A-Z]{1,3}/i.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The shared strings of a workbook, in order, with phonetic guides left out. */
function sharedStrings(xml) {
  const out = [];
  let cur = null;
  let inGuide = false;
  for (const t of xmlTags(xml)) {
    if (t.name === 'si') {
      if (t.closing || t.selfClose) {
        out.push(cur ?? '');
        cur = null;
      } else cur = '';
    } else if (t.name === 'rPh') inGuide = !t.closing && !t.selfClose;
    else if (t.name === 't' && !t.closing && !t.selfClose && cur !== null && !inGuide) cur += decodeXml(t.text);
  }
  return out;
}

/** One worksheet as tab-separated rows, each led by its row number. */
export function sheetText(xml, shared) {
  const rows = [];
  let skipped = 0;
  let narrowed = false;
  let rowNo = '';
  let cells = null;
  let cell = null;
  let inlineText = false;

  const finishCell = () => {
    const { a, v, inline } = cell;
    cell = null;
    let value = '';
    if (a.t === 'inlineStr') value = inline;
    else if (a.t === 's') value = shared[Number(v)] ?? '';
    else if (a.t === 'b') value = v === '' ? '' : v === '1' ? 'TRUE' : 'FALSE';
    else value = decodeXml(v);
    if (value === '') return;
    const col = columnOf(a.r);
    const at = col >= 0 ? col : cells.length;
    if (at >= MAX_SHEET_COLS) {
      narrowed = true;
      return;
    }
    while (cells.length < at) cells.push('');
    cells[at] = value.replace(/[\t\r\n]+/g, ' ');
  };

  for (const t of xmlTags(xml)) {
    if (t.name === 'row') {
      if (t.closing) {
        if (cells?.length) {
          if (rows.length >= MAX_SHEET_ROWS) skipped++;
          else rows.push(`${rowNo}\t${cells.join('\t')}`);
        }
        cells = null;
      } else if (!t.selfClose) {
        rowNo = attrs(t.attrText).r || '';
        cells = [];
      }
    } else if (!cells) continue;
    else if (t.name === 'c') {
      if (t.closing) {
        if (cell) finishCell();
      } else {
        if (cell) finishCell(); // a cell left open by a damaged file
        cell = { a: attrs(t.attrText), v: '', inline: '' };
        if (t.selfClose) cell = null;
      }
    } else if (!cell) continue;
    else if (t.name === 'v') {
      if (!t.closing && !t.selfClose) cell.v = t.text;
    } else if (t.name === 'is') inlineText = !t.closing && !t.selfClose;
    else if (t.name === 't' && inlineText && !t.closing && !t.selfClose) cell.inline += decodeXml(t.text);
  }
  if (skipped) rows.push(`(${skipped} more rows not shown)`);
  if (narrowed) rows.push(`(columns past ${MAX_SHEET_COLS} not shown)`);
  return rows.join('\n');
}

/** Sheets in workbook order, each with the zip path of its XML. */
function workbookSheets(entries, read) {
  const wb = entries.has('xl/workbook.xml') ? read('xl/workbook.xml') : '';
  const rels = entries.has('xl/_rels/workbook.xml.rels') ? read('xl/_rels/workbook.xml.rels') : '';
  const target = new Map();
  for (const t of xmlTags(rels)) {
    if (t.name !== 'Relationship' || t.closing) continue;
    const a = attrs(t.attrText);
    if (a.Id && a.Target) target.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const sheets = [];
  for (const t of xmlTags(wb)) {
    if (t.name !== 'sheet' || t.closing) continue;
    const a = attrs(t.attrText);
    const path = target.get(a['r:id']);
    if (path && entries.has(path)) sheets.push({ name: a.name || path, path, hidden: a.state && a.state !== 'visible' });
  }
  return sheets;
}

/**
 * Text of an Office file.
 *
 * @param {Buffer} buf
 * @param {'docx'|'xlsx'|'pptx'} kind
 * @returns {{ text: string, truncated: boolean } | { error: string }}
 */
export function extractOfficeText(buf, kind, { maxChars = MAX_TEXT_CHARS } = {}) {
  const zip = openZip(buf);
  if (zip.error) return { error: zip.error };
  const { entries } = zip;
  const read = (name) => entries.get(name)().toString('utf8');

  let text;
  try {
    if (kind === 'docx') {
      if (!entries.has('word/document.xml')) return { error: 'This is not a Word document (no word/document.xml).' };
      const extras = [...entries.keys()]
        .filter((n) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n))
        .slice(0, MAX_SHEETS)
        .map((n) => {
          const t = docxText(read(n));
          return t && `[${n.slice(5, -4)}] ${t}`;
        });
      text = [docxText(read('word/document.xml')), ...extras].filter(Boolean).join('\n\n');
    } else if (kind === 'pptx') {
      const num = (n) => Number(/(\d+)\.xml$/.exec(n)?.[1] || 0);
      const all = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
      if (!all.length) return { error: 'This is not a PowerPoint file (no slides found).' };
      const parts = [];
      let size = 0;
      for (const n of all.slice(0, MAX_SLIDES)) {
        const notes = `ppt/notesSlides/notesSlide${num(n)}.xml`;
        const body = slideText(read(n));
        const note = entries.has(notes) ? slideText(read(notes)) : '';
        const part = `--- Slide ${num(n)} ---\n${body}${note ? `\n[Speaker notes] ${note}` : ''}`;
        parts.push(part);
        size += part.length;
        if (size > maxChars) break; // the rest would be cut anyway
      }
      if (all.length > parts.length) parts.push(`(${all.length - parts.length} more slides not read)`);
      text = parts.join('\n\n');
    } else if (kind === 'xlsx') {
      const sheets = workbookSheets(entries, read);
      if (!sheets.length) return { error: 'This is not an Excel workbook (no sheets found).' };
      const shared = sharedStrings(entries.has('xl/sharedStrings.xml') ? read('xl/sharedStrings.xml') : '');
      const parts = [];
      let size = 0;
      for (const s of sheets.slice(0, MAX_SHEETS)) {
        const part = `=== Sheet: ${s.name}${s.hidden ? ' (hidden)' : ''} ===\n${sheetText(read(s.path), shared) || '(empty)'}`;
        parts.push(part);
        size += part.length;
        if (size > maxChars) break;
      }
      if (sheets.length > parts.length) parts.push(`(${sheets.length - parts.length} more sheets not read)`);
      text =
        parts.join('\n\n') +
        '\n\nRows start with their row number. Formulas show their last saved result. Dates appear as Excel serial numbers (days since 1899-12-30).';
    } else {
      return { error: `Unsupported kind ${kind}.` };
    }
  } catch (err) {
    if (err instanceof OfficeError) return { error: err.message };
    return { error: `Could not read the file: ${err?.message || 'unknown error'}.` };
  }

  const truncated = text.length > maxChars;
  return { text: truncated ? `${text.slice(0, maxChars)}\n… (truncated)` : text, truncated };
}
