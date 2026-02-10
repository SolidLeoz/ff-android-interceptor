const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  rmDir(dist);
  ensureDir(dist);
  ensureDir(path.join(dist, "ui"));
  ensureDir(path.join(dist, "lib"));

  await esbuild.build({
    entryPoints: [path.join(root, "src/background/index.ts")],
    outfile: path.join(dist, "background.js"),
    bundle: true,
    platform: "browser",
    target: "es2020",
    sourcemap: false,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "src/ui/dashboard.ts")],
    outfile: path.join(dist, "ui/dashboard.js"),
    bundle: true,
    platform: "browser",
    target: "es2020",
    sourcemap: false,
  });

  await esbuild.build({
    entryPoints: [path.join(root, "src/lib/utils.ts")],
    outfile: path.join(dist, "lib/utils.cjs"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
  });

  await esbuild.build({
    entryPoints: [path.join(root, "src/lib/redact.ts")],
    outfile: path.join(dist, "lib/redact.cjs"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
  });

  fs.copyFileSync(path.join(root, "src/ui/dashboard.html"), path.join(dist, "ui/dashboard.html"));
  fs.copyFileSync(path.join(root, "src/ui/dashboard.css"), path.join(dist, "ui/dashboard.css"));
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
  copyDir(path.join(root, "icons"), path.join(dist, "icons"));
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
