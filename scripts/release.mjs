// Packs a release from dist/ (run `npm run build` first): one zip per browser, the sources for
// AMO's review, and SHA256SUMS. Reproducible: a checkout of the same commit built with the same
// lockfile gives byte-identical zips, so anyone can check a store upload against the sums.
// Every entry is stamped with SOURCE_DATE_EPOCH, else the commit's time.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipFiles } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(pkg.version);

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

if (git(["status", "--porcelain"]).trim() !== "") {
  throw new Error("The working tree has changes: commit them first, a release is built from a commit.");
}
const epoch = process.env.SOURCE_DATE_EPOCH ?? git(["log", "-1", "--format=%ct"]).trim();
const at = new Date(Number(epoch) * 1000);
if (Number.isNaN(at.getTime())) throw new Error(`Not a timestamp: ${epoch}`);

/** @param {string} dir */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = join(entry.parentPath, entry.name);
        return { path: relative(dir, full).split(sep).join("/"), data: await readFile(full) };
      }),
  );
}

const sources = await Promise.all(
  git(["ls-files", "-z"])
    .split("\0")
    .filter((path) => path !== "")
    .map(async (path) => ({ path, data: await readFile(join(root, path)) })),
);

const archives = {
  [`open-parcels-firefox-${version}.zip`]: await filesUnder(join(root, "dist", "firefox")),
  [`open-parcels-chromium-${version}.zip`]: await filesUnder(join(root, "dist", "chromium")),
  [`open-parcels-extension-source-${version}.zip`]: sources,
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const sums = [];
for (const [name, files] of Object.entries(archives)) {
  if (files.length === 0) throw new Error(`Nothing to pack for ${name}: run npm run build first.`);
  const zip = zipFiles(files, at);
  await writeFile(join(out, name), zip);
  sums.push(`${createHash("sha256").update(zip).digest("hex")}  ${name}`);
  console.log(`release/${name}`);
}
await writeFile(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log("release/SHA256SUMS");
