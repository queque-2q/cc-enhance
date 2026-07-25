// Copy webview HTML templates from src/webview/ to out/webview/
// This is needed because .vscodeignore excludes src/** from the VSIX package

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'webview');
const OUT = path.join(ROOT, 'out', 'webview');

// Ensure output directory exists
if (!fs.existsSync(OUT)) {
  fs.mkdirSync(OUT, { recursive: true });
}

// Copy all files from src/webview/ to out/webview/
const files = fs.readdirSync(SRC);
for (const file of files) {
  // Skip TS files (they get compiled), only copy static assets
  if (/\.(html|css|js|json|png|svg|woff2?)$/i.test(file)) {
    const src = path.join(SRC, file);
    const dest = path.join(OUT, file);
    fs.copyFileSync(src, dest);
    console.log(`[copy-webview] Copied ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)}`);
  }
}

console.log('[copy-webview] Done');
