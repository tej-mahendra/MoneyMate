import { expect } from "vitest";
import { crc32 } from "../lib/zip";

/** Test helper: reads a ZIP independently of the writer (end record → central
 *  directory → local headers → data) and checks every CRC. */
export function readZip(zip: Uint8Array): Record<string, { text: string; crcOk: boolean }> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files: Record<string, { text: string; crcOk: boolean }> = {};
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const localOff = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(localOff, true)).toBe(0x04034b50);
    const lNameLen = v.getUint16(localOff + 26, true);
    const lExtraLen = v.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = zip.subarray(start, start + size);
    files[name] = { text: dec.decode(data), crcOk: crc32(data) === crc };
    p += 46 + nameLen;
  }
  return files;
}
