import { describe, it, expect } from "vitest";
import { columnLetter, excelDateSerial, makeWorkbook, xmlText } from "./xlsx";
import { readZip } from "../test/zipReader";

/** Reads a sheet's cells back out of the XML, independently of the writer. */
function cells(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  const out: Record<string, { t: string | null; s: string | null; v: string }> = {};
  doc.querySelectorAll("c").forEach((c) => {
    out[c.getAttribute("r")!] = {
      t: c.getAttribute("t"),
      s: c.getAttribute("s"),
      v: c.querySelector("t")?.textContent ?? c.querySelector("v")?.textContent ?? "",
    };
  });
  return out;
}

describe("helpers", () => {
  it("columnLetter follows A…Z, AA…", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
  it("excelDateSerial matches Excel's day numbers", () => {
    expect(excelDateSerial("1970-01-01")).toBe(25569);
    expect(excelDateSerial("2000-01-01")).toBe(36526);
    expect(excelDateSerial("1900-03-01")).toBe(61); // Excel counts a non-existent 29 Feb 1900
    expect(excelDateSerial("2028-02-29")).toBe(46812);
  });
  it("excelDateSerial refuses anything that isn't a real date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2027-02-29", "2026-1-5", "yesterday", ""]) {
      expect(excelDateSerial(bad)).toBeNull();
    }
  });
  it("xmlText escapes markup and drops characters XML forbids", () => {
    expect(xmlText(`a & b <c> "d"`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
    expect(xmlText("keep\ttab\nnl\rcr")).toBe("keep\ttab\nnl\rcr");
    expect(xmlText("bad\u0000\u0001\u001f\ufffe\uffffchars")).toBe("badchars");
  });
});

describe("makeWorkbook", () => {
  const wb = makeWorkbook([
    {
      name: "data",
      columns: ["Id", "Date", "Amount", "Flag", "Text"],
      dateColumns: ["Date"],
      rows: [
        [1, "2026-11-05", 450.5, true, "Swiggy & <Co>"],
        [2, "2026-02-30", -20, false, "=SUM(A1)"],
        [3, null, Infinity, undefined, ""],
      ],
    },
    { name: "empty", columns: ["A"], rows: [] },
  ]);
  const files = readZip(wb);

  it("contains exactly the parts an Excel workbook needs, all with valid checksums", () => {
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
      "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
    ]);
    expect(Object.values(files).every((f) => f.crcOk)).toBe(true);
  });
  it("every XML part is well-formed", () => {
    for (const [name, f] of Object.entries(files)) {
      const doc = new DOMParser().parseFromString(f.text, "application/xml");
      expect(doc.querySelector("parsererror"), name).toBeNull();
    }
  });
  it("lists the sheets in order with their names", () => {
    const names = [...new DOMParser().parseFromString(files["xl/workbook.xml"].text, "application/xml").querySelectorAll("sheet")].map((s) => s.getAttribute("name"));
    expect(names).toEqual(["data", "empty"]);
  });
  it("declares every part in [Content_Types].xml", () => {
    const ct = files["[Content_Types].xml"].text;
    for (const part of ["/xl/workbook.xml", "/xl/worksheets/sheet1.xml", "/xl/worksheets/sheet2.xml", "/xl/styles.xml"]) {
      expect(ct).toContain(`PartName="${part}"`);
    }
  });

  const c = cells(files["xl/worksheets/sheet1.xml"].text);
  it("writes text, numbers and true/false with the right cell types", () => {
    expect(c.A2).toEqual({ t: null, s: null, v: "1" }); // number
    expect(c.C2).toEqual({ t: null, s: null, v: "450.5" });
    expect(c.D2).toEqual({ t: "b", s: null, v: "1" }); // true
    expect(c.D3).toEqual({ t: "b", s: null, v: "0" }); // false
    expect(c.E2).toEqual({ t: "inlineStr", s: null, v: "Swiggy & <Co>" });
  });
  it("turns real dates into Excel dates (date style), but leaves non-dates as text", () => {
    expect(c.B2).toEqual({ t: null, s: "1", v: String(excelDateSerial("2026-11-05")) });
    expect(c.B3).toEqual({ t: "inlineStr", s: null, v: "2026-02-30" }); // impossible date stays text
  });
  it("keeps formula-looking text as text, never as a formula", () => {
    expect(c.E3).toEqual({ t: "inlineStr", s: null, v: "=SUM(A1)" });
    expect(files["xl/worksheets/sheet1.xml"].text).not.toContain("<f>");
  });
  it("skips empty, null, undefined and non-finite values", () => {
    expect(c.B4).toBeUndefined();
    expect(c.C4).toBeUndefined(); // Infinity
    expect(c.D4).toBeUndefined();
    expect(c.E4).toBeUndefined();
  });
  it("styles the header row bold, freezes it, and adds filter buttons when there are rows", () => {
    expect(c.A1.s).toBe("2");
    const xml = files["xl/worksheets/sheet1.xml"].text;
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<autoFilter ref="A1:E4"/>');
    expect(files["xl/worksheets/sheet2.xml"].text).not.toContain("autoFilter");
  });
  it("registers each filtered range as a hidden name, and none for a header-only sheet", () => {
    const wbXml = files["xl/workbook.xml"].text;
    expect(wbXml).toContain('name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'data\'!$A$1:$E$4<');
    expect(wbXml.match(/_xlnm\._FilterDatabase/g)).toHaveLength(1); // the empty sheet gets none
    // names must come after <sheets> (schema order)
    expect(wbXml.indexOf("<definedNames>")).toBeGreaterThan(wbXml.indexOf("</sheets>"));
  });
  it("selects only the first sheet's tab", () => {
    expect(files["xl/worksheets/sheet1.xml"].text).toContain('tabSelected="1"');
    expect(files["xl/worksheets/sheet2.xml"].text).not.toContain("tabSelected");
  });
});

describe("makeWorkbook — guards", () => {
  const ok = { columns: ["A"], rows: [] as never[] };
  it("rejects sheet names Excel would call corrupt", () => {
    for (const name of ["", "x".repeat(32), "a:b", "a/b", "a\\b", "a?b", "a*b", "[a]"]) {
      expect(() => makeWorkbook([{ name, ...ok }]), name).toThrow(/Invalid sheet name/);
    }
  });
  it("rejects duplicate names (case-insensitive) and an empty workbook", () => {
    expect(() => makeWorkbook([{ name: "Data", ...ok }, { name: "data", ...ok }])).toThrow(/Duplicate/);
    expect(() => makeWorkbook([])).toThrow(/at least one sheet/);
  });
  it("accepts the longest legal name and ordinary punctuation", () => {
    expect(() => makeWorkbook([{ name: "x".repeat(31), ...ok }, { name: "fact_month_summary", ...ok }, { name: "Q&A 2026", ...ok }])).not.toThrow();
  });
});
