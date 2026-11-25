// The worker bundle that copilot-viz copies to a remote host over SSH, and the two Node scripts
// that run there: one verifies the installed bundle and starts it, the other installs it.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HERE } from './runtime.mjs';

// The static import closure of worker.mjs; a test keeps this list in step with the imports.
export const WORKER_FILES = ['worker.mjs', 'collector.mjs', 'model.mjs', 'monitor.mjs', 'wire.mjs'];
// The copies on a remote host carry the license notices of the package.
const NOTICE_FILES = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];
export const MISSING_EXIT = 75;
export const UNSUPPORTED_EXIT = 78;
export const MISSING_MARK = 'copilot-viz: the worker is not installed';
export const REMOTE_DIR = '.cache/copilot-viz/worker';

export function bundleId(files) {
  const h = createHash('sha256');
  for (const [name, data] of files) {
    h.update(`${name}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest('hex');
}

// Read once when the server starts, so that an upgrade on disk never mixes two releases on a host.
export async function workerBundle(dir = HERE) {
  const files = [
    ...await Promise.all(WORKER_FILES.map(async (name) => [name, await readFile(join(dir, name))])),
    ...await Promise.all(NOTICE_FILES.map(async (name) => [name, await readFile(join(dir, '..', name))])),
  ];
  return {
    id: bundleId(files),
    names: files.map(([name]) => name),
    payload: JSON.stringify(Object.fromEntries(files.map(([name, data]) => [name, data.toString('base64')]))),
  };
}

// The scripts pass through `sh -c` inside the login shell of the remote user, which may be fish.
// fish reads a backslash inside single quotes as an escape, so the scripts hold neither a
// backslash nor a single quote. They run from $HOME as CommonJS and parse on old Node versions,
// so that an old Node can report its version instead of a syntax error.
const COMMON = `
var fs = require("fs"), path = require("path"), crypto = require("crypto");
var args = process.argv.splice(1, 2), id = args[0], names = (args[1] || "").split(",");
var NUL = String.fromCharCode(0), LF = String.fromCharCode(10);
function quit(code, message) { process.stderr.write("copilot-viz: " + message + LF); process.exit(code); }
if (Number(process.versions.node.split(".")[0]) < 22) {
  quit(${UNSUPPORTED_EXIT}, "Node.js 22 or later is required on this host; " + process.execPath + " is " + process.version + ".");
}
if (!/^[0-9a-f]{64}$/.test(id) || !names.every(function (n) { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n); })) {
  quit(${UNSUPPORTED_EXIT}, "invalid worker bundle request.");
}
var root = ${JSON.stringify(REMOTE_DIR)}, dir = path.join(root, id.slice(0, 16));
var parents = root.split("/").map(function (_, i, a) { return a.slice(0, i + 1).join("/"); });
// Another user who could write to a directory on the path could swap the code after it is
// checked. ~/.cache may be a symlink, and may be writable by the own group of the user, as with
// umask 002; copilot-viz makes the directories below it. Returns false when d does not exist.
function guard(d, i) {
  var st;
  try {
    st = i === 0 ? fs.statSync(d) : fs.lstatSync(d);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  var shared = st.mode & (i === 0 && st.gid === process.getgid() ? 2 : 18);
  if (!st.isDirectory() || st.uid !== process.getuid() || shared) {
    quit(${UNSUPPORTED_EXIT}, "refusing to use " + path.resolve(d) + "; it must be a directory of this user that no other user can write to.");
  }
  return true;
}
// Reads only regular files of this user that no other user can write to.
function digest(d) {
  var h = crypto.createHash("sha256");
  try {
    names.forEach(function (n) {
      var p = path.join(d, n), st = fs.lstatSync(p);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 18) !== 0) throw new Error("unsafe");
      var b = fs.readFileSync(p);
      h.update(n + NUL + b.length + NUL);
      h.update(b);
    });
  } catch (e) {
    return null;
  }
  return h.digest("hex");
}
`;

export const BOOT = `${COMMON}
if (!parents.concat([dir]).every(guard) || digest(dir) !== id) {
  quit(${MISSING_EXIT}, ${JSON.stringify(MISSING_MARK.slice('copilot-viz: '.length))});
}
import(require("url").pathToFileURL(path.resolve(dir, "worker.mjs")).href);
`;

export const INSTALL = `${COMMON}
var chunks = [], size = 0;
process.stdin.on("data", function (c) {
  size += c.length;
  if (size > 16777216) quit(1, "the worker upload is too large.");
  chunks.push(c);
});
process.stdin.on("end", function () {
  var tmp, old, error;
  try {
    var files = JSON.parse(Buffer.concat(chunks).toString());
    fs.mkdirSync(root, { recursive: true, mode: 448 });
    // guard exits the process, so it runs before there is anything to clean up.
    if (!parents.every(guard)) throw new Error("the directory disappeared.");
    tmp = fs.mkdtempSync(path.join(root, ".tmp-"));
    names.forEach(function (n) { fs.writeFileSync(path.join(tmp, n), Buffer.from(String(files[n]), "base64"), { mode: 384 }); });
    if (digest(tmp) !== id) throw new Error("the upload is corrupt.");
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY" && e.code !== "ENOTDIR") throw e;
      // Another connection installed it first, or a damaged copy is in the way.
      if (digest(dir) !== id) {
        old = tmp + "-old";
        fs.renameSync(dir, old);
        try {
          fs.renameSync(tmp, dir);
        } catch (e2) {
          if (digest(dir) !== id) throw e2;
        }
      }
    }
  } catch (e) {
    error = e;
  }
  // A renamed directory is gone from its old path, and force ignores a missing path.
  [tmp, old].forEach(function (p) {
    try {
      if (p) fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {}
  });
  if (error) quit(1, "cannot install the worker in " + path.resolve(root) + ": " + error.message);
});
`;
