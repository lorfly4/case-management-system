const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeJsonParse, resolveCaseJsonData, saveJsonUploadToDisk } = require('../lib/case_json_utils');

test('safeJsonParse parses JSON string into object', () => {
  const parsed = safeJsonParse('{"informasi_polis":{"no_polis":"ABC-123"}}');
  assert.deepEqual(parsed, { informasi_polis: { no_polis: 'ABC-123' } });
});

test('saveJsonUploadToDisk stores JSON file and resolveCaseJsonData reads it back', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-case-json-'));
  const payload = { informasi_polis: { no_polis: 'POLIS-001', pemegang_polis: 'Budi' } };

  const relativePath = saveJsonUploadToDisk({ buffer: Buffer.from(JSON.stringify(payload)) }, 999, tempDir);
  const storedFile = path.join(tempDir, relativePath.replace(/^uploads\//, ''));

  assert.equal(fs.existsSync(storedFile), true);

  const data = resolveCaseJsonData({ json_file_path: relativePath }, tempDir);
  assert.deepEqual(data, payload);
});
