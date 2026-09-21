const test = require('node:test');
const assert = require('node:assert/strict');

const { canViewAllCases, canCreateCase, canUploadCaseDocument, canImportCases } = require('../lib/case_permissions');

test('user can view all cases', () => {
  assert.equal(canViewAllCases('user'), true);
  assert.equal(canViewAllCases('admin'), true);
  assert.equal(canViewAllCases('spv'), true);
});

test('user can create cases and import from manual or Excel', () => {
  assert.equal(canCreateCase('user'), true);
  assert.equal(canImportCases('user'), true);
});

test('only admin and spv can upload PDF documents', () => {
  assert.equal(canUploadCaseDocument('admin'), true);
  assert.equal(canUploadCaseDocument('spv'), true);
  assert.equal(canUploadCaseDocument('user'), false);
});
