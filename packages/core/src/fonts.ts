import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliDecompressSync, inflateSync } from 'node:zlib';

/**
 * Font files (#303): read the family, weight, style, variation axes and
 * licence note of a TTF, OTF, WOFF or WOFF2 file, without a font library.
 * The upload path refuses files that do not parse (a font a browser cannot
 * load would only fail later, in the middle of a render), and engines
 * register each project font under the family name inside it.
 *
 * Only the tables needed are read (`name`, `OS/2`, `head`, `fvar`); every
 * offset is bounds-checked. WOFF tables are zlib streams, WOFF2 table data
 * is one Brotli stream (W3C WOFF2 §5); `name`, `OS/2`, `head` and `fvar` are
 * never transformed in WOFF2, so they are read as they are.
 */

export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontError';
  }
}

export interface FontAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

export interface FontInfo {
  format: 'ttf' | 'otf' | 'woff' | 'woff2';
  /** Family name as registered in CSS (typographic family, characters CSS font-family tokens allow). */
  family: string;
  /** Family name exactly as in the file. */
  familyInFile: string;
  subfamily: string;
  fullName?: string;
  /** usWeightClass (100-900), or the wght axis default. */
  weight: number;
  italic: boolean;
  /** Variation axes (fvar): a variable font. */
  axes: FontAxis[];
  /** Licence description and URL from the name table (IDs 13, 14), if any. */
  licence?: string;
  licenceUrl?: string;
}

/** Largest font accepted (bytes); a CJK family is about 20 MB. */
export const MAX_FONT_BYTES = 64 * 1024 * 1024;

const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];
const WANTED = new Set(['name', 'OS/2', 'head', 'fvar']);

function need(cond: boolean, what: string): asserts cond {
  if (!cond) throw new FontError(`not a valid font file: ${what}`);
}

class Reader {
  constructor(readonly b: Buffer) {}
  u8(o: number) {
    need(o >= 0 && o + 1 <= this.b.length, 'truncated');
    return this.b.readUInt8(o);
  }
  u16(o: number) {
    need(o >= 0 && o + 2 <= this.b.length, 'truncated');
    return this.b.readUInt16BE(o);
  }
  u32(o: number) {
    need(o >= 0 && o + 4 <= this.b.length, 'truncated');
    return this.b.readUInt32BE(o);
  }
  i32(o: number) {
    need(o >= 0 && o + 4 <= this.b.length, 'truncated');
    return this.b.readInt32BE(o);
  }
  tag(o: number) {
    need(o >= 0 && o + 4 <= this.b.length, 'truncated');
    return this.b.toString('latin1', o, o + 4);
  }
  slice(o: number, n: number) {
    need(o >= 0 && n >= 0 && o + n <= this.b.length, 'a table lies outside the file');
    return this.b.subarray(o, o + n);
  }
}

/** The tables we read, from an sfnt (TTF/OTF) file. */
function sfntTables(b: Buffer): Map<string, Buffer> {
  const r = new Reader(b);
  const n = r.u16(4);
  need(n > 0 && n < 512, 'table count');
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = r.tag(rec);
    if (WANTED.has(tag)) out.set(tag, r.slice(r.u32(rec + 8), r.u32(rec + 12)));
  }
  return out;
}

function woffTables(b: Buffer): Map<string, Buffer> {
  const r = new Reader(b);
  const n = r.u16(12);
  need(n > 0 && n < 512, 'table count');
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const rec = 44 + i * 20;
    const tag = r.tag(rec);
    if (!WANTED.has(tag)) continue;
    const data = r.slice(r.u32(rec + 4), r.u32(rec + 8));
    const orig = r.u32(rec + 12);
    let table: Buffer;
    try {
      table = data.length < orig ? inflateSync(data, { maxOutputLength: orig }) : data;
    } catch {
      throw new FontError(`not a valid font file: the ${tag} table does not decompress`);
    }
    need(table.length === orig, `${tag} table length`);
    out.set(tag, table);
  }
  return out;
}

function base128(r: Reader, o: { at: number }): number {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const byte = r.u8(o.at++);
    need(!(i === 0 && byte === 0x80), 'base128 leading zero');
    need((v & 0xfe000000) === 0, 'base128 overflow');
    v = (v << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return v >>> 0;
  }
  throw new FontError('not a valid font file: base128 too long');
}

function woff2Tables(b: Buffer): Map<string, Buffer> {
  const r = new Reader(b);
  need(r.tag(4) !== 'ttcf', 'font collections are not supported');
  const n = r.u16(12);
  need(n > 0 && n < 512, 'table count');
  const compressed = r.u32(20);
  const pos = { at: 48 };
  const entries: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < n; i++) {
    const flags = r.u8(pos.at++);
    const known = flags & 0x3f;
    let tag: string;
    if (known === 63) {
      tag = r.tag(pos.at);
      pos.at += 4;
    } else {
      need(known < WOFF2_TAGS.length, 'unknown table tag index');
      tag = WOFF2_TAGS[known]!;
    }
    const version = (flags >> 6) & 3;
    const orig = base128(r, pos);
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128(r, pos) : orig;
    entries.push({ tag, length });
  }
  let data: Buffer;
  try {
    const total = entries.reduce((s, e) => s + e.length, 0);
    need(total <= MAX_FONT_BYTES * 4, 'too large');
    data = brotliDecompressSync(r.slice(pos.at, compressed), { maxOutputLength: total });
  } catch (e) {
    if (e instanceof FontError) throw e;
    throw new FontError('not a valid font file: the WOFF2 data does not decompress');
  }
  const d = new Reader(data);
  const out = new Map<string, Buffer>();
  let at = 0;
  for (const e of entries) {
    if (WANTED.has(e.tag)) out.set(e.tag, d.slice(at, e.length));
    at += e.length;
  }
  need(at <= data.length, 'table data length');
  return out;
}

function names(name: Buffer | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!name) return out;
  const r = new Reader(name);
  const count = r.u16(2);
  const strings = r.u16(4);
  // Best record per name id: Windows Unicode English, then any Windows Unicode, then Mac Roman.
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    const [platform, encoding, language, id, len, off] = [r.u16(rec), r.u16(rec + 2), r.u16(rec + 4), r.u16(rec + 6), r.u16(rec + 8), r.u16(rec + 10)];
    let score = 0;
    let text: string | null = null;
    if ((platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0) {
      score = platform === 3 && language === 0x409 ? 3 : 2;
      const raw = Buffer.from(r.slice(strings + off, len));
      text = raw.length % 2 === 0 ? raw.swap16().toString('utf16le') : null;
    } else if (platform === 1 && encoding === 0) {
      score = 1;
      text = r.slice(strings + off, len).toString('latin1');
    }
    if (text !== null && score > (rank.get(id) ?? 0)) {
      rank.set(id, score);
      out.set(id, text.replace(/\0/g, '').trim());
    }
  }
  return out;
}

/** CSS-safe family: the characters theme font-family tokens allow (letters, digits, space, - _ .). */
export function cssFamily(name: string): string {
  return name.replace(/[^A-Za-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

/** Read a font file's family, style, weight, axes and licence note. Throws FontError when it does not parse. */
export function readFontInfo(b: Buffer): FontInfo {
  need(b.length >= 12 && b.length <= MAX_FONT_BYTES, 'size');
  const sig = b.toString('latin1', 0, 4);
  let format: FontInfo['format'];
  let tables: Map<string, Buffer>;
  if (sig === 'wOFF') {
    format = 'woff';
    tables = woffTables(b);
  } else if (sig === 'wOF2') {
    format = 'woff2';
    tables = woff2Tables(b);
  } else if (sig === 'OTTO') {
    format = 'otf';
    tables = sfntTables(b);
  } else if (b.readUInt32BE(0) === 0x00010000 || sig === 'true') {
    format = 'ttf';
    tables = sfntTables(b);
  } else {
    throw new FontError('not a TTF, OTF, WOFF or WOFF2 file');
  }
  need(tables.has('name'), 'no name table');
  need(tables.has('head'), 'no head table');
  const n = names(tables.get('name'));
  const familyInFile = n.get(16) || n.get(1) || '';
  need(familyInFile.length > 0, 'no family name');
  const head = new Reader(tables.get('head')!);
  need(head.u32(12) === 0x5f0f3cf5, 'bad head table');
  const os2 = tables.get('OS/2');
  const os2r = os2 ? new Reader(os2) : null;
  const axes: FontAxis[] = [];
  const fvar = tables.get('fvar');
  if (fvar) {
    const f = new Reader(fvar);
    const offset = f.u16(4);
    const count = f.u16(8);
    const size = f.u16(10);
    need(size >= 20 && count < 64, 'fvar');
    for (let i = 0; i < count; i++) {
      const o = offset + i * size;
      axes.push({ tag: f.tag(o), min: f.i32(o + 4) / 65536, default: f.i32(o + 8) / 65536, max: f.i32(o + 12) / 65536 });
    }
  }
  const wght = axes.find((a) => a.tag === 'wght');
  const weight = wght ? Math.round(wght.default) : os2r ? os2r.u16(4) || 400 : 400;
  const italic = os2r && os2!.length >= 64 ? (os2r.u16(62) & 1) === 1 : (head.u16(44) & 2) === 2;
  const family = cssFamily(familyInFile) || 'Unnamed Font';
  return {
    format,
    family,
    familyInFile,
    subfamily: n.get(17) || n.get(2) || (italic ? 'Italic' : 'Regular'),
    ...(n.get(4) ? { fullName: n.get(4)! } : {}),
    weight: Math.min(1000, Math.max(1, weight)),
    italic,
    axes,
    ...(n.get(13) ? { licence: n.get(13)!.slice(0, 2000) } : {}),
    ...(n.get(14) ? { licenceUrl: n.get(14)!.slice(0, 500) } : {}),
  };
}

/** @font-face descriptors for a parsed font: a variable font covers its wght (and wdth) range. */
export function fontFaceDescriptors(info: FontInfo): { weight: string; style: 'normal' | 'italic'; stretch?: string } {
  const wght = info.axes.find((a) => a.tag === 'wght');
  const wdth = info.axes.find((a) => a.tag === 'wdth');
  return {
    weight: wght ? `${Math.round(wght.min)} ${Math.round(wght.max)}` : String(info.weight),
    style: info.italic ? 'italic' : 'normal',
    ...(wdth ? { stretch: `${wdth.min}% ${wdth.max}%` } : {}),
  };
}

/** One face of a bundled font: a woff2 file in its npm package, with the descriptors from the package's CSS. */
export interface BundledFace {
  family: string;
  file: string;
  weight: string;
  style: 'normal' | 'italic';
  unicodeRange?: string;
}

/**
 * The default font set shipped with ReelForge (#303): OFL-1.1 variable fonts
 * from the Fontsource packages, so themes that name them render the same on
 * every machine whatever is installed. Licences: docs/public/manifest/fonts.md.
 */
export const BUNDLED_FONTS = [
  { family: 'Inter', pkg: '@fontsource-variable/inter', version: '5.3.0', licence: 'OFL-1.1', copyright: 'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)' },
  { family: 'Source Serif 4', pkg: '@fontsource-variable/source-serif-4', version: '5.3.1', licence: 'OFL-1.1', copyright: '© 2014 - 2021 Adobe Systems Incorporated (http://www.adobe.com/), with Reserved Font Name ‘Source’.' },
  { family: 'JetBrains Mono', pkg: '@fontsource-variable/jetbrains-mono', version: '5.3.0', licence: 'OFL-1.1', copyright: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)' },
] as const;

let bundled: BundledFace[] | undefined;

/** Every face of the bundled fonts (weight axis files, normal and italic, every unicode subset). Read once from the packages' CSS. */
export function bundledFontFaces(): BundledFace[] {
  if (bundled) return bundled;
  const require = createRequire(import.meta.url);
  const out: BundledFace[] = [];
  for (const f of BUNDLED_FONTS) {
    const dir = dirname(require.resolve(`${f.pkg}/package.json`));
    for (const css of ['wght.css', 'wght-italic.css']) {
      const text = readFileSync(join(dir, css), 'utf8');
      for (const block of text.match(/@font-face\s*{[^}]*}/g) ?? []) {
        const get = (k: string) => new RegExp(`${k}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
        const src = /url\(\.\/files\/([\w.-]+\.woff2)\)/.exec(block)?.[1];
        if (!src) continue;
        out.push({
          family: f.family,
          file: join(dir, 'files', src),
          weight: get('font-weight') ?? '400',
          style: get('font-style') === 'italic' ? 'italic' : 'normal',
          ...(get('unicode-range') ? { unicodeRange: get('unicode-range')! } : {}),
        });
      }
    }
  }
  bundled = out;
  return out;
}
