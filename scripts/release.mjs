// Local stand-in for "merge to main → gates → build → release".
// Builds the current commit into .releases/<sha>. If the build (our validation gate) fails, the live site is untouched.
// On success, the build is copied into dist/, which `wrangler dev` serves (it reloads on asset changes).
// In Cloudflare this step is `wrangler versions upload` (staging) then `wrangler versions deploy` (publish).
//
//   node scripts/release.mjs             release the current HEAD
//   node scripts/release.mjs --rollback  re-release the previous successful build
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELEASES = ".releases";
const HISTORY = join(RELEASES, "history.json");
const LIVE = "dist";
const KEEP = 5;

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const history = () => (existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : []);

function goLive(sha) {
  // Replace contents in place (keeps the dist/ folder itself so the dev server's watcher stays attached).
  mkdirSync(LIVE, { recursive: true });
  for (const entry of readdirSync(LIVE)) rmSync(join(LIVE, entry), { recursive: true, force: true });
  cpSync(join(RELEASES, sha), LIVE, { recursive: true });
}

mkdirSync(RELEASES, { recursive: true });
const log = history();

if (process.argv.includes("--rollback")) {
  if (log.length < 2) { console.error("✖ nothing to roll back to"); process.exit(1); }
  const [current, previous] = log;
  goLive(previous.sha);
  log.shift(); // current release drops off the top; previous becomes live
  writeFileSync(HISTORY, JSON.stringify(log, null, 2));
  console.log(`↩ rolled back ${current.sha} → ${previous.sha} ("${previous.message}")`);
  process.exit(0);
}

const sha = sh("git rev-parse --short HEAD");
const message = sh("git log -1 --pretty=%s");
const out = join(RELEASES, sha);
console.log(`▶ release ${sha} "${message}"`);

const started = Date.now();
try {
  rmSync(out, { recursive: true, force: true });
  sh("npm run build", { env: { ...process.env, OUT_DIR: out, GIT_SHA: sha, ASTRO_TELEMETRY_DISABLED: "1" } });
} catch (err) {
  rmSync(out, { recursive: true, force: true });
  const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  const reason = output.match(/Content validation failed:[\s\S]*?(?=\n\s*(?:Location|Stack|at |$))/)?.[0] ?? output.split("\n").filter(Boolean).slice(-15).join("\n");
  console.error(`✖ gate failed: release ${sha} blocked. The live site is unchanged.\n${reason}`);
  process.exit(1);
}

goLive(sha);
log.unshift({ sha, message, releasedAt: new Date().toISOString() });
for (const old of log.splice(KEEP)) rmSync(join(RELEASES, old.sha), { recursive: true, force: true });
writeFileSync(HISTORY, JSON.stringify(log, null, 2));
console.log(`✔ released ${sha} in ${((Date.now() - started) / 1000).toFixed(1)}s (previous: ${log[1]?.sha ?? "none"})`);
