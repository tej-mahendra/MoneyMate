import { makeZip } from "./zip";

// Minimal .xlsx (Excel workbook) writer — enough for tables of text, numbers,
// true/false and dates, one table per sheet. An .xlsx file is a zip of small
// XML files, so this reuses the zip writer instead of adding a library.
// Power BI, Excel, LibreOffice and pandas all open the result.

export type XCell = string | number | boolean | null | undefined;

export interface Sheet {
  /** Sheet (tab) name: at most 31 characters, none of  [ ] : * ? / \  */
  name: string;
  /** Header row. */
  columns: string[];
  rows: XCell[][];
  /** Columns holding "yyyy-mm-dd" text that should become real Excel dates. */
  dateColumns?: string[];
  /** Width (in characters) for column A only — used for the README sheet. */
  firstColumnWidth?: number;
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Cell styles (indexes into cellXfs below): 0 plain, 1 date, 2 bold header.
const S_DATE = 1;
const S_HEADER = 2;

/** Drops characters XML 1.0 forbids (stray control characters would make the
 *  whole file "corrupt" in Excel). Tab, newline and carriage return are allowed. */
function stripInvalidXml(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const forbidden = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff;
    if (!forbidden) out += s[i];
  }
  return out;
}

/** Escapes text for XML (and drops forbidden characters). */
export function xmlText(s: string): string {
  return stripInvalidXml(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → A, 25 → Z, 26 → AA … */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel's day number for a real "yyyy-mm-dd" date (1900 system), or null if
 *  the text isn't a valid calendar date (so "2026-02-30" stays text instead
 *  of silently becoming 2 March). */
export function excelDateSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / 86_400_000) + 25569; // 25569 = 1970-01-01
}

function validateName(name: string, seen: Set<string>) {
  if (name.length === 0 || name.length > 31 || /[[\]:*?/\\]/.test(name)) {
    throw new Error(`Invalid sheet name: "${name}"`);
  }
  if (seen.has(name.toLowerCase())) throw new Error(`Duplicate sheet name: "${name}"`);
  seen.add(name.toLowerCase());
}

function cellXml(ref: string, v: XCell, style?: number, asDate = false): string {
  if (v === null || v === undefined || v === "") return "";
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number") {
    return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
  }
  if (asDate) {
    const serial = excelDateSerial(v);
    if (serial !== null) return `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
}

function sheetXml(sheet: Sheet, selected: boolean): string {
  const nCols = sheet.columns.length;
  const dateCols = new Set(
    (sheet.dateColumns ?? []).map((c) => sheet.columns.indexOf(c)).filter((i) => i >= 0),
  );
  // Column widths from the longest value (capped), so nothing is cut off.
  const widths = sheet.columns.map((c, i) => {
    let w = c.length;
    for (const r of sheet.rows) {
      const v = r[i];
      const len = typeof v === "string" ? v.length : v === null || v === undefined ? 0 : String(v).length;
      if (len > w) w = len;
    }
    return Math.min(Math.max(w + 2, 8), 60);
  });
  if (sheet.firstColumnWidth) widths[0] = sheet.firstColumnWidth;

  const lastRow = sheet.rows.length + 1;
  const lastCol = columnLetter(Math.max(nCols - 1, 0));
  const out: string[] = [];
  out.push(`${HEAD}<worksheet xmlns="${NS}" xmlns:r="${REL}">`);
  out.push(`<dimension ref="A1:${lastCol}${lastRow}"/>`);
  out.push(
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ""} workbookViewId="0">` +
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft"/></sheetView></sheetViews>`,
  );
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  out.push(
    "<cols>" +
      widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") +
      "</cols>",
  );
  out.push("<sheetData>");
  out.push(
    `<row r="1">${sheet.columns.map((c, i) => cellXml(`${columnLetter(i)}1`, c, S_HEADER)).join("")}</row>`,
  );
  sheet.rows.forEach((row, r) => {
    const rn = r + 2;
    let cells = "";
    for (let c = 0; c < nCols; c++) {
      cells += cellXml(`${columnLetter(c)}${rn}`, row[c], undefined, dateCols.has(c));
    }
    out.push(`<row r="${rn}">${cells}</row>`);
  });
  out.push("</sheetData>");
  // Filter buttons on the header row (not on a sheet with only a header).
  if (sheet.rows.length > 0) out.push(`<autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  out.push("</worksheet>");
  return out.join("");
}

const STYLES = `${HEAD}<styleSheet xmlns="${NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Builds a workbook with one sheet per entry, in order. */
export function makeWorkbook(sheets: Sheet[], when: Date = new Date()): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  const seen = new Set<string>();
  sheets.forEach((s) => validateName(s.name, seen));

  const contentTypes =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";

  const rootRels =
    `${HEAD}<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  // Excel records every filtered range as a hidden name; files that include
  // it (as XlsxWriter and openpyxl write them) are the best-trodden path.
  const filterNames = sheets
    .map((s, i) =>
      s.rows.length > 0
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">` +
          `'${xmlText(s.name.replace(/'/g, "''"))}'!$A$1:$${columnLetter(Math.max(s.columns.length - 1, 0))}$${s.rows.length + 1}</definedName>`
        : "",
    )
    .join("");

  const workbook =
    `${HEAD}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets>" +
    (filterNames ? `<definedNames>${filterNames}</definedNames>` : "") +
    "</workbook>";

  const workbookRels =
    `${HEAD}<Relationships xmlns="${PKG_REL}">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;

  return makeZip(
    [
      { name: "[Content_Types].xml", content: contentTypes },
      { name: "_rels/.rels", content: rootRels },
      { name: "xl/workbook.xml", content: workbook },
      { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
      { name: "xl/styles.xml", content: STYLES },
      ...sheets.map((s, i) => ({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        content: sheetXml(s, i === 0),
      })),
    ],
    when,
  );
}
