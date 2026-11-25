import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipFiles } from "../scripts/zip.mjs";

const AT = new Date("2030-01-02T03:04:06Z");
const enc = new TextEncoder();

/** Reads the central directory back: path, timestamp fields and the inflated data. */
function unzip(zip: Buffer) {
  const end = zip.length - 22;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: { path: string; time: number; date: number; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const packed = zip.readUInt32LE(at + 20);
    const localName = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + localName;
    files.push({
      path: zip.toString("utf8", at + 46, at + 46 + nameLength),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      text: inflateRawSync(zip.subarray(start, start + packed)).toString("utf8"),
    });
    at += 46 + nameLength;
  }
  return files;
}

describe("reproducible zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("gives the same bytes whatever order the files come in", () => {
    const a = { path: "b/manifest.json", data: enc.encode("{}") };
    const b = { path: "a.js", data: enc.encode("console.log(1)") };
    expect(zipFiles([a, b], AT).equals(zipFiles([b, a], AT))).toBe(true);
  });

  it("stores sorted paths, the fixed time and the contents", () => {
    const zip = zipFiles(
      [
        { path: "z.txt", data: enc.encode("last") },
        { path: "icons/icon-16.png", data: enc.encode("png") },
      ],
      AT,
    );
    expect(unzip(zip)).toEqual([
      { path: "icons/icon-16.png", time: (3 << 11) | (4 << 5) | 3, date: (50 << 9) | (1 << 5) | 2, text: "png" },
      { path: "z.txt", time: (3 << 11) | (4 << 5) | 3, date: (50 << 9) | (1 << 5) | 2, text: "last" },
    ]);
  });

  it("refuses absolute and backslash paths", () => {
    expect(() => zipFiles([{ path: "/etc/x", data: enc.encode("") }], AT)).toThrow();
    expect(() => zipFiles([{ path: "a\\b", data: enc.encode("") }], AT)).toThrow();
  });
});
