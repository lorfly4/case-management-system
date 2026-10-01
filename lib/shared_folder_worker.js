const SMB2 = require("smb2");

const [operation, remotePath] = process.argv.slice(2);
const share = process.env.SMB_SHARE;
const username = process.env.SMB_USERNAME;
const password = process.env.SMB_PASSWORD;

if (!share || !username || !password) {
  process.stderr.write("SMB_SHARE, SMB_USERNAME, and SMB_PASSWORD must be configured");
  process.exit(1);
}

const segments = share
  .trim()
  .replace(/^smb:\/\//i, "")
  .replace(/\\/g, "/")
  .replace(/^\/+/, "")
  .split("/")
  .filter(Boolean);
if (segments.length < 2) {
  process.stderr.write("SMB_SHARE must include a server and share name");
  process.exit(1);
}

const client = new SMB2({
  share: `\\\\${segments.join("\\")}`,
  username,
  password,
  domain: process.env.SMB_DOMAIN || "",
  autoCloseTimeout: 1000,
  port: 445,
});

const invoke = (method, ...args) =>
  new Promise((resolve, reject) => {
    client[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });

const run = async () => {
  if (operation === "upload") {
    const buffers = [];
    for await (const chunk of process.stdin) buffers.push(chunk);
    const folder = remotePath.split("\\")[0];
    if (!(await invoke("exists", folder))) {
      try {
        await invoke("mkdir", folder);
      } catch (error) {
        if (!/already exists/i.test(error.message)) throw error;
      }
    }
    await invoke("writeFile", remotePath, Buffer.concat(buffers));
    return;
  }

  if (operation === "read") {
    const contents = await invoke("readFile", remotePath);
    process.stdout.write(contents);
    return;
  }

  if (operation === "delete") {
    await invoke("unlink", remotePath);
    return;
  }

  throw new Error("Unsupported SMB operation");
};

run().catch((error) => {
  process.stderr.write(error.message || "SMB operation failed");
  process.exitCode = 1;
});
