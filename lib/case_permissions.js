const ROLES = ['admin', 'spv', 'user'];

function canViewAllCases(role) {
  return ROLES.includes(role);
}

function canCreateCase(role) {
  return ROLES.includes(role);
}

function canImportCases(role) {
  return ROLES.includes(role);
}

function canUploadCaseDocument(role) {
  return ['admin', 'spv'].includes(role);
}

module.exports = {
  ROLES,
  canViewAllCases,
  canCreateCase,
  canImportCases,
  canUploadCaseDocument
};
