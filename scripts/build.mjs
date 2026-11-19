// Builds dist/firefox and dist/chromium from one source tree.
import { build } from "esbuild";
import { Resvg } from "@resvg/resvg-js";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = JSON.parse(await readFile(join(root, "src", "manifest.base.json"), "utf8"));

const entries = {
  background: "src/background.ts",
  content: "src/content.ts",
  approve: "src/pages/approve.ts",
  options: "src/pages/options.ts",
  popup: "src/pages/popup.ts",
};
const staticFiles = ["approve.html", "options.html", "popup.html", "pages.css"];
const iconSizes = [16, 32, 48, 128];

const targets = {
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "extension@open-parcels.github.io", strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  },
  chromium: {
    ...base,
    background: { service_worker: "background.js" },
    minimum_chrome_version: "116",
  },
};

// The logo carries a prefers-color-scheme rule; resvg renders the light variant, which suits
// toolbar icons on both themes reasonably.
const svg = await readFile(join(root, "assets", "logo.svg"));
const icons = new Map(
  iconSizes.map((size) => [size, new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()]),
);

await rm(dist, { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const out = join(dist, name);
  await mkdir(join(out, "icons"), { recursive: true });
  await build({
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
    outdir: out,
    bundle: true,
    format: "iife",
    target: name === "firefox" ? "firefox128" : "chrome116",
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
  for (const file of staticFiles) await cp(join(root, "src", "pages", file), join(out, file));
  for (const [size, png] of icons) await writeFile(join(out, "icons", `icon-${size}.png`), png);
  await writeFile(join(out, "manifest.json"), `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);
  console.log(`built dist/${name}`);
}
