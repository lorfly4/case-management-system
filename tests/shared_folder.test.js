const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSharedFolderPath,
  makeRemoteDocumentPath,
  normalizeSharePath,
  normalizeRemotePath,
  sanitizeCaseFolderName,
} = require('../lib/shared_folder');

test('case folder uses a sanitized title and a unique case ID suffix', () => {
  assert.equal(sanitizeCaseFolderName('Rawat Inap / Demam Berdarah', 12), 'Rawat Inap _ Demam Berdarah - 12');
});

test('remote document path keeps an allowed extension and safe segments', () => {
  const remotePath = makeRemoteDocumentPath('Klaim Hospital', 12, '../../surat.pdf');

  assert.match(remotePath, /^Klaim Hospital - 12\/[^/]+\.pdf$/);
  assert.equal(normalizeRemotePath(`smb:${remotePath}`), remotePath.replace(/\//g, '\\'));
});

test('remote path rejects traversal and identifies stored SMB paths', () => {
  assert.throws(() => normalizeRemotePath('smb:case/../secret.pdf'), /Invalid shared-folder path/);
  assert.equal(isSharedFolderPath('smb:Case - 1/file.pdf'), true);
  assert.equal(isSharedFolderPath('local-file.pdf'), false);
});

test('share URL and UNC formats normalize to an SMB2 share path', () => {
  assert.equal(normalizeSharePath('smb://host.example/SharedFolder'), '\\\\host.example\\SharedFolder');
  assert.equal(normalizeSharePath('\\\\host.example\\SharedFolder'), '\\\\host.example\\SharedFolder');
});