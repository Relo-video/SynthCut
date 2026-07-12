// electron-builder afterAllArtifactBuild hook: write a SHA256SUMS.txt next to the
// built artifacts so users (and the GitHub release) can verify downloads without
// a code-signing certificate. Returns the checksum file so it's published too.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

module.exports = async function afterAllArtifactBuild(buildResult) {
  const paths = (buildResult.artifactPaths || []).filter(
    (p) => !p.endsWith(".blockmap") && !p.endsWith("SHA256SUMS.txt"),
  );
  if (paths.length === 0) return [];

  const lines = paths.map((p) => {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    return `${hash}  ${path.basename(p)}`;
  });

  const outDir = path.dirname(paths[0]);
  const sumsFile = path.join(outDir, "SHA256SUMS.txt");
  fs.writeFileSync(sumsFile, lines.join("\n") + "\n", "utf8");
  console.log(`[afterbuild] wrote ${sumsFile} (${lines.length} artifact(s))`);
  return [sumsFile];
};
