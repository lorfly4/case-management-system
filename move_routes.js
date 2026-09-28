const fs = require('fs');
const path = require('path');
const appFile = path.join(__dirname, 'app.js');

const src = fs.readFileSync(appFile, 'utf8');
const lines = src.split(/\r?\n/);

// Find line numbers (0-indexed)
// Markers:
const BLOCK_START_MARKER = '// --- UPLOAD 2 JSON CASES (STANDALONE) ---';
const BLOCK_END_MARKER = '// --- ROOT ROUTE ---';
const INSERT_BEFORE_MARKER = '// --- CSV / EXCEL IMPORT ROUTE ---';

let blockStartIdx = -1;
let blockEndIdx = -1;
let insertBeforeIdx = -1;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes(BLOCK_START_MARKER)) blockStartIdx = i;
  if (line.includes(BLOCK_END_MARKER)) blockEndIdx = i;
  if (line.includes(INSERT_BEFORE_MARKER)) insertBeforeIdx = i;
}

console.log('blockStartIdx:', blockStartIdx, '(~line', blockStartIdx + 1, ')');
console.log('blockEndIdx:', blockEndIdx, '(~line', blockEndIdx + 1, ')');
console.log('insertBeforeIdx:', insertBeforeIdx, '(~line', insertBeforeIdx + 1, ')');

if (blockStartIdx < 0 || blockEndIdx < 0 || insertBeforeIdx < 0) {
  console.error('MARKER NOT FOUND, aborting');
  process.exit(1);
}

if (insertBeforeIdx >= blockStartIdx && insertBeforeIdx < blockEndIdx) {
  console.error('INSERT POINT IS INSIDE BLOCK, aborting');
  process.exit(1);
}

// Extract the block (from blockStartIdx (inclusive) to blockEndIdx (exclusive))
// Because blockEndIdx is the line that says "// --- ROOT ROUTE ---" which we should NOT include in the block
const block = lines.slice(blockStartIdx, blockEndIdx);
console.log('Block size (lines):', block.length);

// Remove block from original position
const beforeBlock = lines.slice(0, blockStartIdx);
const afterBlock = lines.slice(blockEndIdx);
const removed = beforeBlock.concat(afterBlock);
console.log('After removal total lines:', removed.length);

// Now compute new insertBeforeIdx in the removed array (because lines shifted after removal)
// If insertBeforeIdx was originally > blockStartIdx, then the insert point shifted:
//   newInsertIdx = insertBeforeIdx - block.length
let newInsertIdx = insertBeforeIdx;
if (insertBeforeIdx > blockStartIdx) {
  newInsertIdx = insertBeforeIdx - block.length;
}
console.log('newInsertIdx in removed array:', newInsertIdx, '(line', newInsertIdx + 1, ')');
console.log('Marker at that line:', removed[newInsertIdx]);

// Insert: removed[0..newInsertIdx-1] + block + removed[newInsertIdx..end]
const finalLines = removed.slice(0, newInsertIdx).concat(block).concat(removed.slice(newInsertIdx));
console.log('Final total lines:', finalLines.length);

const output = finalLines.join('\n');
fs.writeFileSync(appFile, output);
console.log('\nDONE. File written.');

// Verify: check that /upload-json-cases route comes before /import-cases route
const routes = [];
let routeMatch;
const routeRegex = /app\.(get|post|put|delete)\(\s*"([^"]+)"\s*,/g;
while ((routeMatch = routeRegex.exec(output)) !== null) {
  routes.push({ method: routeMatch[1], path: routeMatch[2] });
}
const upJson = routes.findIndex(r => r.path.includes('upload-json-cases'));
const impCase = routes.findIndex(r => r.path.includes('import-cases'));
console.log('\nPosition of /upload-json-cases in routes list:', upJson);
console.log('Position of /import-cases in routes list:', impCase);
if (upJson >= 0 && impCase >= 0 && upJson < impCase) {
  console.log('✓ upload-json-cases route is REGISTERED BEFORE import-cases = CORRECT');
} else {
  console.log('? UNEXPECTED ordering (upload-json index, import-cases index):', [upJson, impCase]);
}
