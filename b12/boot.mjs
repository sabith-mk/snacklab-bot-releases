// The Snack Lab bot: what the Windows service starts. It picks the build to run (state.json), counts its starts, and
// goes back to the last build that ran well when a new one fails to start three times. Kept small: updates can
// replace it, but it must never break.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
process.env.SNACKLAB_ROOT = root;
const stateFile = join(root, "state.json");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function readState() {
  try {
    // Windows PowerShell writes a byte-order mark first; JSON doesn't allow one.
    return JSON.parse(readFileSync(stateFile, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}
function writeState(s) {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}

const s = readState();
s.bad ??= [];
s.attempts ??= {};
const launcherOf = (build) => join(root, "versions", String(build), "launcher.mjs");

// No readable state (a damaged file): the newest build there is.
if (!s.current || !existsSync(launcherOf(s.current))) {
  let builds = [];
  try {
    builds = readdirSync(join(root, "versions")).filter((d) => /^b\d+$/.test(d) && existsSync(launcherOf(d)));
  } catch {
    builds = [];
  }
  const newest = builds.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1);
  if (!s.current && newest) {
    s.current = newest;
    writeState(s);
  }
}

// A build that isn't known good yet: three starts without getting good (the launcher marks it after 3 minutes) and
// it's given up, back to the good one.
if (s.current && s.current !== s.good) {
  s.attempts[s.current] = (s.attempts[s.current] ?? 0) + 1;
  if ((s.attempts[s.current] > 3 || !existsSync(launcherOf(s.current))) && s.good && existsSync(launcherOf(s.good))) {
    s.rolledBack = { from: s.current, to: s.good, at: stamp(), why: "it didn't start properly" };
    s.bad = [...new Set([...s.bad, s.current])];
    s.previous = s.current;
    s.current = s.good;
  }
  writeState(s);
}

try {
  await import(pathToFileURL(launcherOf(s.current)).href);
} catch (error) {
  console.error(`Build ${s.current} couldn't start:`, error);
  // Exit "failed": the service starts it again, and the count above takes it back to the good build.
  process.exit(1);
}
