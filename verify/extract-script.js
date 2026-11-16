// Extract the inline <script> from index.html so `node --check` can parse it.
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO INLINE SCRIPT FOUND'); process.exit(1); }
const out = path.join(__dirname, '_extracted.js');
fs.writeFileSync(out, m[1], 'utf8');
console.log('extracted ' + m[1].length + ' chars of JS to ' + out);