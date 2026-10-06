const crypto = require("crypto");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const path = require("path");
const workerPath = path.join(__dirname, "shared_folder_worker.js");

// Jika UPLOAD_DIR di-set (mis. di VPS: /srv/samba/SharedFolder), file ditulis
// langsung ke disk. Folder itu di-share oleh Samba, jadi tetap terlihat via SMB.
// Jika tidak di-set (mis. di lokal), pakai klien SMB lewat worker seperti semula.
const getLocalRoot = () =>
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : null;

const normalizeSharePath = (share) => {
  const segments = String(share || "")
    .trim()
    .replace(/^smb:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    throw new Error("SMB_SHARE must include a server and share name");
  }
  return `\\\\${segments.join("\\")}`;
};

const runWorker = (operation, remotePath, data) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--openssl-legacy-provider", workerPath, operation, remotePath],
      { env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SMB worker exited with code ${code}`));
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(data);
  });

const sanitizeCaseFolderName = (title, caseId) => {
  const safeTitle = String(title || "Case")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 150) || "Case";
  return `${safeTitle} - ${caseId}`;
};

const safeExtension = (originalName) => {
  const extension = path.extname(path.basename(originalName)).toLowerCase();
  return [".pdf", ".jpg", ".jpeg", ".png"].includes(extension) ? extension : ".bin";
};

const makeRemoteDocumentPath = (title, caseId, originalName) => {
  const folder = sanitizeCaseFolderName(title, caseId);
  const fileName = `${crypto.randomUUID()}${safeExtension(originalName)}`;
  return `${folder}/${fileName}`;
};

const splitRemotePath = (remotePath) => {
  const segments = String(remotePath || "")
    .replace(/^smb:/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid shared-folder path");
  }
  return segments;
};

const normalizeRemotePath = (remotePath) => splitRemotePath(remotePath).join("\\");

// Ubah path tersimpan menjadi path absolut di disk, dengan pengaman path traversal.
const resolveLocalPath = (root, storedPath) => {
  const full = path.resolve(root, ...splitRemotePath(storedPath));
  if (!full.startsWith(root + path.sep)) {
    throw new Error("Invalid shared-folder path");
  }
  return full;
};

const uploadToSharedFolder = async ({ title, caseId, originalName, data }) => {
  const remotePath = makeRemoteDocumentPath(title, caseId, originalName);
  const root = getLocalRoot();
  if (root) {
    const full = resolveLocalPath(root, remotePath);
    const dir = path.dirname(full);
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o2775).catch(() => {});
    await fs.writeFile(full, data, { mode: 0o664 });
  } else {
    await runWorker("upload", normalizeRemotePath(remotePath), data);
  }
  return `smb:${remotePath}`;
};

const readFromSharedFolder = (storedPath) => {
  const root = getLocalRoot();
  if (root) return fs.readFile(resolveLocalPath(root, storedPath));
  return runWorker("read", normalizeRemotePath(storedPath));
};

const deleteFromSharedFolder = (storedPath) => {
  const root = getLocalRoot();
  if (root) return fs.unlink(resolveLocalPath(root, storedPath));
  return runWorker("delete", normalizeRemotePath(storedPath));
};

module.exports = {
  deleteFromSharedFolder,
  isSharedFolderPath: (storedPath) => String(storedPath || "").startsWith("smb:"),
  makeRemoteDocumentPath,
  normalizeSharePath,
  normalizeRemotePath,
  readFromSharedFolder,
  sanitizeCaseFolderName,
  uploadToSharedFolder,
};
