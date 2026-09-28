const path = require('path');
const fs = require('fs');
const Module = require('module');

const originalLoad = Module._load;
let appObj = null;

Module._load = function(request, parent, isMain) {
  const exports = originalLoad.apply(this, arguments);
  return exports;
};

const appFile = path.join(__dirname, 'app.js');
const appSrc = fs.readFileSync(appFile, 'utf8');

const appExportSrc = appSrc + '\n;' + `
module.exports = {
  getApp: () => {
    try {
      const stack = (typeof app !== 'undefined') ? app._router.stack : null;
      return {
        stack,
        routes: stack ? stack.filter(l => l.route).map(l => ({
          path: l.route.path,
          methods: Object.keys(l.route.methods),
        })) : null,
      };
    } catch(e) { return { error: e.message, stack: e.stack }; }
  }
};
`;

const appDir = __dirname;
process.chdir(appDir);
delete require.cache[require.resolve('./app.js')];

const http = require('http');
// Override app.listen so it doesn't actually listen during this probe
const origListen = require('http').Server.prototype.listen;
let capturedApp = null;
const express = require('express');

// Patch require('express') to capture the app instance inside app.js
const appCode = fs.readFileSync(appFile, 'utf8');
const modifiedSrc = appCode
  .replace(/app\.listen\(/g, 'if (false) app.listen(')
  .replace(/console\.log\(`Server running/g, 'void (0) && console.log(`Server not running');

const wrapped = `
${modifiedSrc}
// After app is set up, export the probe
global.__probeRoutes = function() {
  try {
    const stack = app._router.stack;
    return stack
      .filter(l => l.route)
      .map(l => ({
        path: typeof l.route.path === 'string' ? l.route.path : String(l.route.path),
        methods: Object.keys(l.route.methods),
      }))
      .sort((a,b) => a.path.localeCompare(b.path));
  } catch(e) { return ['ERROR: ' + e.message]; }
};
`;

try {
  eval(wrapped);
  const routes = global.__probeRoutes();
  console.log('REGISTERED ROUTES (' + routes.length + ' total):');
  routes.forEach(r => {
    console.log('  ' + r.methods.join(',').toUpperCase().padEnd(8) + ' ' + r.path);
  });
  const upJson = routes.filter(r => r.path.includes('upload-json') || r.path.includes('upload_json'));
  const importCsv = routes.filter(r => r.path.includes('import-cases'));
  console.log('\nFiltered:');
  console.log('  import-cases:', JSON.stringify(importCsv));
  console.log('  upload-json-cases:', JSON.stringify(upJson));
  if (upJson.length === 0) {
    console.log('\n❌ ROUTE /upload-json-cases NOT REGISTERED!');
    const idx = routes.findIndex(r => r.path.includes('upload-document'));
    console.log('  After upload-document (idx', idx + '):', JSON.stringify(routes.slice(Math.max(0, idx-1), Math.min(routes.length, idx+4))));
  } else {
    console.log('\n✓ ROUTE /upload-json-cases REGISTERED');
  }
} catch (e) {
  console.error('EVAL FAILED:', e.message, e.stack);
}
