import { describe, it, expect } from "vitest";
import { bytesToBase64, crc32, makeZip } from "./zip";
import { readZip } from "../test/zipReader";

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
