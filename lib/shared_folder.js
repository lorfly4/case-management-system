const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const workerPath = path.join(__dirname, "shared_folder_worker.js");

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

const normalizeRemotePath = (remotePath) => {
  const segments = String(remotePath || "")
    .replace(/^smb:/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid shared-folder path");
  }
  return segments.join("\\");
};

const uploadToSharedFolder = async ({ title, caseId, originalName, data }) => {
  const remotePath = makeRemoteDocumentPath(title, caseId, originalName);
  await runWorker("upload", normalizeRemotePath(remotePath), data);
  return `smb:${remotePath}`;
};

const readFromSharedFolder = (storedPath) =>
  runWorker("read", normalizeRemotePath(storedPath));

const deleteFromSharedFolder = (storedPath) =>
  runWorker("delete", normalizeRemotePath(storedPath));

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