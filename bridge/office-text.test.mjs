import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  extractOfficeText, openZip, officeKind, isLegacyOffice, decodeXml, docxText, MAX_SHEET_ROWS,
} from './office-text.mjs';

/** A zip in memory. `files` is [name, content, { store, flags, lieSize }]. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, opts = {}] of files) {
    const data = Buffer.from(content);
    const comp = opts.store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const claimed = opts.lieSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(opts.flags || 0, 6);
    lh.writeUInt16LE(opts.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(claimed, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(opts.flags || 0, 8);
    ch.writeUInt16LE(opts.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(claimed, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const W = (body) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;

// --- names -----------------------------------------------------------------------

test('only the three modern Office extensions are read, and the old ones are named as such', () => {
  assert.equal(officeKind('Kontrak.DOCX'), 'docx');
  assert.equal(officeKind('a.xlsx'), 'xlsx');
  assert.equal(officeKind('a.pptx'), 'pptx');
  assert.equal(officeKind('a.doc'), null);
  assert.equal(officeKind('a.docx.exe'), null);
  assert.equal(isLegacyOffice('a.xls'), true);
  assert.equal(isLegacyOffice('a.xlsx'), false);
});

test('XML references decode, and a bad code point is left as written', () => {
  assert.equal(decodeXml('a &amp; b &lt;c&gt; &#65;&#x42; &quot;x&quot;'), 'a & b <c> AB "x"');
  assert.equal(decodeXml('&#99999999999;'), '&#99999999999;');
  assert.equal(decodeXml('&nbsp;'), '&nbsp;');
});

// --- docx ------------------------------------------------------------------------

test('a Word file keeps paragraphs, tabs, line breaks and table rows', () => {
  const xml = W(
    '<w:p><w:r><w:t>Perjanjian</w:t></w:r><w:r><w:t xml:space="preserve"> Kerja</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nama</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Nilai</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  );
  const out = docxText(xml);
  assert.match(out, /^Perjanjian Kerja\nA\tB\nC/);
  assert.match(out, /\nNama\tNilai$/);
});

test('field codes, deleted text and empty runs do not leak into a Word file', () => {
  const xml = W(
    '<w:p><w:r><w:instrText> HYPERLINK "http://x" </w:instrText></w:r><w:r><w:t/></w:r>' +
    '<w:del><w:r><w:delText>old</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>',
  );
  assert.equal(docxText(xml), 'kept');
});

test('extract reads a docx, with its footer', () => {
  const buf = zip([
    ['word/document.xml', W('<w:p><w:r><w:t>Isi &amp; tanda</w:t></w:r></w:p>')],
    ['word/footer1.xml', W('<w:p><w:r><w:t>Halaman 1</w:t></w:r></w:p>')],
  ]);
  const r = extractOfficeText(buf, 'docx');
  assert.equal(r.text, 'Isi & tanda\n\n[footer1] Halaman 1');
});

test('a zip with no word/document.xml is not called a Word file', () => {
  assert.match(extractOfficeText(zip([['x.txt', 'hi']]), 'docx').error, /not a Word/);
});

// --- xlsx ------------------------------------------------------------------------

const BOOK =
  '<workbook xmlns:r="r"><sheets><sheet name="Harga" sheetId="1" r:id="rId1"/><sheet name="Rahasia" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>';
const RELS =
  '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
const SST = '<sst><si><t>Produk</t></si><si><r><t>Total</t></r><r><t xml:space="preserve"> IDR</t></r><rPh><t>x</t></rPh></si></sst>';
const SHEET1 =
  '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>0spike</t></is></c><c r="B2"><v>12500.5</v></c><c r="D2" t="b"><v>1</v></c></row>' +
  '<row r="3"/><row r="4"><c r="A4"/></row>' +
  '</sheetData></worksheet>';

test('an Excel file keeps column positions, shared and inline strings, and skips empty rows', () => {
  const buf = zip([
    ['xl/workbook.xml', BOOK], ['xl/_rels/workbook.xml.rels', RELS], ['xl/sharedStrings.xml', SST],
    ['xl/worksheets/sheet1.xml', SHEET1], ['xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>'],
  ]);
  const { text } = extractOfficeText(buf, 'xlsx');
  assert.match(text, /=== Sheet: Harga ===\n1\tProduk\t\tTotal IDR\n2\t0spike\t12500\.5\t\tTRUE\n/);
  assert.match(text, /=== Sheet: Rahasia \(hidden\) ===\n\(empty\)/);
  assert.match(text, /serial numbers/);
  assert.equal(text.includes('x\n'), false, 'phonetic guide text is left out');
});

test('a sheet longer than the row limit says how many rows it left out', () => {
  const rows = Array.from({ length: MAX_SHEET_ROWS + 3 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const buf = zip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rows}</sheetData></worksheet>`],
  ]);
  assert.match(extractOfficeText(buf, 'xlsx').text, /\(3 more rows not shown\)/);
});

// --- pptx ------------------------------------------------------------------------

test('slides come out in numeric order, with their speaker notes', () => {
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const buf = zip([
    ['ppt/slides/slide10.xml', slide('ten')], ['ppt/slides/slide2.xml', slide('two')],
    ['ppt/notesSlides/notesSlide2.xml', slide('say this')],
  ]);
  const { text } = extractOfficeText(buf, 'pptx');
  assert.ok(text.indexOf('Slide 2') < text.indexOf('Slide 10'));
  assert.match(text, /--- Slide 2 ---\ntwo\n\[Speaker notes\] say this/);
});

// --- hostile archives ------------------------------------------------------------

test('not a zip, or too short to be one, is an error and not a crash', () => {
  assert.match(extractOfficeText(Buffer.from('hello'), 'docx').error, /Not a zip/);
  assert.match(extractOfficeText(Buffer.alloc(500, 1), 'docx').error, /Not a zip/);
});

test('a password-protected entry is reported', () => {
  const buf = zip([['word/document.xml', W(''), { flags: 1 }]]);
  assert.match(extractOfficeText(buf, 'docx').error, /password/);
});

test('an entry that lies about its size and inflates past the ceiling is stopped', () => {
  const big = Buffer.alloc(70 * 1024 * 1024, 0x61);
  const buf = zip([['word/document.xml', big, { lieSize: 10 }]]);
  const r = extractOfficeText(buf, 'docx');
  assert.match(r.error, /inflates to more than/);
});

test('an entry that declares more than the ceiling is refused before inflating', () => {
  const buf = zip([['word/document.xml', 'x', { lieSize: 0x7fffffff }]]);
  assert.match(extractOfficeText(buf, 'docx').error, /too large/);
});

test('a directory pointing outside the file is a damaged zip, not an out-of-range read', () => {
  const good = zip([['word/document.xml', W('<w:p><w:r><w:t>x</w:t></w:r></w:p>')]]);
  const bad = Buffer.from(good);
  const eocd = bad.length - 22;
  bad.writeUInt32LE(bad.length + 5000, eocd + 16);
  assert.match(openZip(bad).error, /damaged/);
});

test('long output is cut with a note', () => {
  const buf = zip([['word/document.xml', W(`<w:p><w:r><w:t>${'a'.repeat(1000)}</w:t></w:r></w:p>`)]]);
  const r = extractOfficeText(buf, 'docx', { maxChars: 100 });
  assert.equal(r.truncated, true);
  assert.match(r.text, /… \(truncated\)$/);
});

test('an archive entry named like a path is only ever looked up, never written', () => {
  const buf = zip([['../../evil.txt', 'x'], ['word/document.xml', W('<w:p><w:r><w:t>ok</w:t></w:r></w:p>')]]);
  assert.equal(extractOfficeText(buf, 'docx').text, 'ok');
});
