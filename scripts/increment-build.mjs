import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const versionPath = join(rootDir, "version.json");
const indexPath = join(rootDir, "public", "index.html");
const version = JSON.parse(readFileSync(versionPath, "utf8"));

version.build = Number(version.build || 0) + 1;
writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`);

const label = `v${version.major}.${String(version.build).padStart(2, "0")}`;
const indexHtml = readFileSync(indexPath, "utf8").replace(
  /(<span id="versionBadge" class="version-badge">)v[^<]+(<\/span>)/,
  `$1${label}$2`,
);
writeFileSync(indexPath, indexHtml);
console.log(`Build version bumped to ${label}`);
