import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
  console.error("npm_package_version is not set. Run this through `npm version`.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;

manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

let versions = {};
try {
  versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
  versions = {};
}

versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Updated manifest.json and versions.json to ${targetVersion}.`);
