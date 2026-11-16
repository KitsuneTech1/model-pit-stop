// Independent verification of the site's self-contained SHA-256 against Node's crypto.
// Extracts the K table + sha256Hex() out of index.html and diffs it against the real thing.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const start = html.indexOf('var K = [');
const end = html.indexOf('// --- the gate');
if (start < 0 || end < 0) { console.error('EXTRACT FAILED'); process.exit(1); }
const chunk = html.slice(start, end);

const mod = {};
new Function('mod', chunk + '\nmod.sha256Hex = sha256Hex;')(mod);

const cases = [
  '1009',            // the real answer
  '1010',            // the plausible wrong answer, must NOT collide
  '0', '1', '42',
  '',                // empty input
  'a', 'abc',
  'The quick brown fox jumps over the lazy dog',
  'x'.repeat(55),    // just under the 56-byte padding boundary
  'x'.repeat(56),    // exactly at the boundary
  'x'.repeat(64),    // exactly one block
  'x'.repeat(1000),  // multi block
  '\u00e9\u4e2d\u6587\ud83d\ude00', // multibyte utf-8
];

let pass = 0, fail = 0;
for (const c of cases) {
  const mine = mod.sha256Hex(c);
  const real = crypto.createHash('sha256').update(c, 'utf8').digest('hex');
  const ok = mine === real;
  ok ? pass++ : fail++;
  if (!ok) console.log('MISMATCH', JSON.stringify(c).slice(0, 40), '\n  mine:', mine, '\n  real:', real);
}

// The hash baked into the page must actually be the hash of the verified answer.
const verifiedAnswer = '1009';
const baked = (html.match(/ANSWER_HASH = "([0-9a-f]{64})"/) || [])[1];
const bakedOk = baked === crypto.createHash('sha256').update(verifiedAnswer, 'utf8').digest('hex');

// And the plausible wrong answer must not open the door.
const wrongHash = crypto.createHash('sha256').update('1010', 'utf8').digest('hex');
const wrongRejected = wrongHash !== baked;

console.log('sha256Hex vs node crypto :', pass + ' pass, ' + fail + ' fail');
console.log('baked ANSWER_HASH correct:', bakedOk, '(' + baked + ')');
console.log('1010 correctly rejected  :', wrongRejected);
const allOk = fail === 0 && bakedOk && wrongRejected;
console.log(allOk ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(allOk ? 0 : 1);