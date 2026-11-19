import { describe, it, expect } from "vitest";
import { bytesToBase64, crc32, makeZip } from "./zip";

// Tiny reader, written independently of makeZip, to prove the archive is
// structurally valid: end record → central directory → local headers → data.
function readZip(zip: Uint8Array) {
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

describe("zip writer", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips several files, including non-ASCII names and content", () => {
    const zip = makeZip([
      { name: "a.csv", content: "x,y\n1,2\n" },
      { name: "ünï.csv", content: "₹ 450 — चाय" },
      { name: "empty.csv", content: "" },
    ]);
    const files = readZip(zip);
    expect(Object.keys(files)).toEqual(["a.csv", "ünï.csv", "empty.csv"]);
    expect(files["a.csv"].text).toBe("x,y\n1,2\n");
    expect(files["ünï.csv"].text).toBe("₹ 450 — चाय");
    expect(files["empty.csv"].text).toBe("");
    expect(Object.values(files).every((f) => f.crcOk)).toBe(true);
  });

  it("handles a large file", () => {
    const big = "row,1234.56\n".repeat(200_000);
    expect(readZip(makeZip([{ name: "big.csv", content: big }]))["big.csv"].text).toBe(big);
  });
});

describe("bytesToBase64", () => {
  it("matches btoa for small input and survives a large one", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(bytesToBase64(new Uint8Array(500_000)).length).toBeGreaterThan(600_000);
  });
});
