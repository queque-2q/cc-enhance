// scripts/copy-webview.js
// 复制 webview HTML 模板和 Monaco VS 资源到 out/ 目录

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_WEBVIEW = path.join(ROOT, 'out', 'webview');

// 确保输出目录存在
fs.mkdirSync(OUT_WEBVIEW, { recursive: true });

// 1. 复制 HTML 模板
const srcWebviewDir = path.join(ROOT, 'src', 'webview');
for (const name of fs.readdirSync(srcWebviewDir)) {
  if (name.endsWith('.html')) {
    const src = path.join(srcWebviewDir, name);
    const dst = path.join(OUT_WEBVIEW, name);
    fs.copyFileSync(src, dst);
    console.log(`  copied: src/webview/${name} -> out/webview/${name}`);
  }
}

// 2. 复制 Monaco VS 资源
const monacoSrc = path.join(ROOT, 'node_modules', 'monaco-editor', 'min', 'vs');
const monacoDst = path.join(OUT_WEBVIEW, 'vs');

if (!fs.existsSync(monacoSrc)) {
  console.error('ERROR: monaco-editor not found. Run: npm install');
  process.exit(1);
}

copyRecursive(monacoSrc, monacoDst);

const stats = countFiles(monacoDst);
console.log(`  copied: ${stats.files} files (${(stats.size / 1024 / 1024).toFixed(1)} MB) -> out/webview/vs/`);

// ── helpers ────────────────────────────────────────────────

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function countFiles(dir) {
  let size = 0, count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(p);
      count += sub.files;
      size += sub.size;
    } else {
      count++;
      size += fs.statSync(p).size;
    }
  }
  return { size, files: count };
}
