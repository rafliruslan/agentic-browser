/**
 * Plain text out of Word, Excel and PowerPoint files, with no shell and no library.
 *
 * The agent that cannot run a command cannot unzip a .docx, and a .docx is a zip
 * of XML. Reading the file here, inside the Slack tool server, gives her the
 * words without giving her Bash. Node already ships the one piece that needs
 * code, `zlib`, so there is no dependency to audit.
 *
 * The file is untrusted. Nothing here runs it: a zip is parsed by offset, entries
 * are inflated into memory with a size ceiling, and names inside the archive are
 * only ever looked up, never used as a path. Macros live in a part this never
 * opens. Text is pulled out with a few regular expressions, not a DOM, so there
 * is no entity expansion to abuse.
 */
import { inflateRawSync } from 'node:zlib';

/** Most bytes one archive entry may inflate to. A big sheet is tens of MB of XML. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Most characters of text handed back. Past this the reader gets a note, not a wall. */
export const MAX_TEXT_CHARS = 400_000;

/** Rows kept per sheet. */
export const MAX_SHEET_ROWS = 5000;

const MAX_ENTRIES = 20_000;

/** The file kinds this reads, from the name Slack gives. Old binary formats are not among them. */
export function officeKind(name) {
  const m = /\.(docx|xlsx|pptx)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Names of the legacy formats, so the agent is told why they fail and what to ask for. */
export function isLegacyOffice(name) {
  return /\.(doc|xls|ppt)$/i.test(String(name || ''));
}

/**
 * The entries of a zip, by name, as lazy readers.
 *
 * @returns {{ entries: Map<string, () => Buffer> } | { error: string }}
 */
export function openZip(buf) {
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
      if (flags & 1) throw new Error('The file is password-protected.');
      if (usize > MAX_ENTRY_BYTES) throw new Error(`"${name}" is too large to read.`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('The zip is damaged.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + csize > buf.length) throw new Error('The zip is damaged.');
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`Unsupported compression method ${method}.`);
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

const tidy = (s) =>
  s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Word: every run of text, with paragraph, line, tab and table-cell breaks kept. */
export function docxText(xml) {
  const out = [];
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  for (const m of xml.matchAll(token)) {
    const t = m[0];
    if (m[1] !== undefined) out.push(decodeXml(m[1]));
    else if (t.startsWith('<w:tab')) out.push('\t');
    else if (t === '</w:tc>') {
      // A cell ends its last paragraph with a newline; a table row reads better on one line.
      if (out[out.length - 1] === '\n') out.pop();
      out.push('\t');
    } else if (t === '</w:tr>') {
      if (out[out.length - 1] === '\t') out.pop();
      out.push('\n');
    } else out.push('\n');
  }
  return tidy(out.join(''));
}

/** PowerPoint: the text of one slide, a line per paragraph. */
export function slideText(xml) {
  const out = [];
  for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>|<a:br\b[^>]*\/>/g)) {
    out.push(m[1] !== undefined ? decodeXml(m[1]) : '\n');
  }
  return tidy(out.join(''));
}

/** 0-based column from a cell reference: A is 0, Z is 25, AA is 26. */
function columnOf(ref) {
  const letters = /^[A-Z]+/i.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The text of every `<t>` in a fragment, leaving out phonetic guides. */
function textRuns(fragment) {
  return [...fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => decodeXml(m[1]))
    .join('');
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
}

/** One worksheet as tab-separated rows, each led by its row number. */
export function sheetText(xml, shared) {
  const rows = [];
  let skipped = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rm[2] === undefined) continue;
    const rowNo = attrs(rm[1]).r || '';
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      const body = cm[2] || '';
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
      let value = '';
      if (a.t === 'inlineStr') value = textRuns(body);
      else if (a.t === 's') value = v ? shared[Number(v[1])] ?? '' : '';
      else if (a.t === 'b') value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      else if (v) value = decodeXml(v[1]);
      if (value === '') continue;
      const col = columnOf(a.r);
      const at = col >= 0 ? col : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value.replace(/[\t\r\n]+/g, ' ');
    }
    if (!cells.length) continue;
    if (rows.length >= MAX_SHEET_ROWS) {
      skipped++;
      continue;
    }
    rows.push(`${rowNo}\t${cells.join('\t')}`);
  }
  if (skipped) rows.push(`(${skipped} more rows not shown)`);
  return rows.join('\n');
}

/** Sheets in workbook order, each with the zip path of its XML. */
function workbookSheets(entries, read) {
  const wb = entries.has('xl/workbook.xml') ? read('xl/workbook.xml') : '';
  const rels = entries.has('xl/_rels/workbook.xml.rels') ? read('xl/_rels/workbook.xml.rels') : '';
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) target.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
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
        .map((n) => {
          const t = docxText(read(n));
          return t && `[${n.slice(5, -4)}] ${t}`;
        });
      text = [docxText(read('word/document.xml')), ...extras].filter(Boolean).join('\n\n');
    } else if (kind === 'pptx') {
      const num = (n) => Number(/(\d+)\.xml$/.exec(n)?.[1] || 0);
      const slides = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
      if (!slides.length) return { error: 'This is not a PowerPoint file (no slides found).' };
      text = slides
        .map((n) => {
          const notes = `ppt/notesSlides/notesSlide${num(n)}.xml`;
          const body = slideText(read(n));
          const note = entries.has(notes) ? slideText(read(notes)) : '';
          return `--- Slide ${num(n)} ---\n${body}${note ? `\n[Speaker notes] ${note}` : ''}`;
        })
        .join('\n\n');
    } else if (kind === 'xlsx') {
      const sheets = workbookSheets(entries, read);
      if (!sheets.length) return { error: 'This is not an Excel workbook (no sheets found).' };
      const shared = sharedStrings(entries.has('xl/sharedStrings.xml') ? read('xl/sharedStrings.xml') : '');
      text =
        sheets.map((s) => `=== Sheet: ${s.name}${s.hidden ? ' (hidden)' : ''} ===\n${sheetText(read(s.path), shared) || '(empty)'}`).join('\n\n') +
        '\n\nRows start with their row number. Formulas show their last saved result. Dates appear as Excel serial numbers (days since 1899-12-30).';
    } else {
      return { error: `Unsupported kind ${kind}.` };
    }
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      return { error: `Refused: a part of the file inflates to more than ${MAX_ENTRY_BYTES} bytes.` };
    }
    return { error: `Could not read the file: ${err?.message || 'unknown error'}.` };
  }

  const truncated = text.length > maxChars;
  return { text: truncated ? `${text.slice(0, maxChars)}\n… (truncated)` : text, truncated };
}
