// Minimal ZIP writer (the "stored", uncompressed method) — enough to bundle
// a handful of small CSV files into one download without adding a library.
// Every ZIP reader (Windows Explorer, 7-Zip, Python's zipfile) opens these.

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
}

export function makeZip(entries: ZipEntry[], when: Date = new Date()): Uint8Array {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate =
    ((Math.max(when.getFullYear(), 1980) - 1980) << 9) |
    ((when.getMonth() + 1) << 5) |
    when.getDate();

  const prepared = entries.map((e) => {
    const name = enc.encode(e.name);
    const data = typeof e.content === "string" ? enc.encode(e.content) : e.content;
    return { name, data, crc: crc32(data) };
  });

  let total = 22; // end-of-central-directory record
  for (const p of prepared) total += 30 + p.name.length + p.data.length + 46 + p.name.length;

  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let pos = 0;
  const u16 = (n: number) => {
    v.setUint16(pos, n, true);
    pos += 2;
  };
  const u32 = (n: number) => {
    v.setUint32(pos, n >>> 0, true);
    pos += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, pos);
    pos += b.length;
  };

  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(pos);
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(0x0800); // flags: file names are UTF-8
    u16(0); // method: stored
    u16(dosTime);
    u16(dosDate);
    u32(p.crc);
    u32(p.data.length); // compressed size
    u32(p.data.length); // uncompressed size
    u16(p.name.length);
    u16(0); // extra length
    bytes(p.name);
    bytes(p.data);
  }
  const cdStart = pos;
  prepared.forEach((p, i) => {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20); // version needed
    u16(0x0800);
    u16(0);
    u16(dosTime);
    u16(dosDate);
    u32(p.crc);
    u32(p.data.length);
    u32(p.data.length);
    u16(p.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(offsets[i]);
    bytes(p.name);
  });
  const cdSize = pos - cdStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(prepared.length);
  u16(prepared.length);
  u32(cdSize);
  u32(cdStart);
  u16(0); // comment length
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunked: spreading a large array into String.fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
