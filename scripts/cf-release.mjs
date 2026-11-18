// Spike 0.1: the release flow on real Cloudflare (standard Worker per site, the customer-account / fallback target).
// Stands in for the platform's deploy service. Run from the site working copy (spikes/.work/astro-head).
//
// Needs: CLOUDFLARE_ACCOUNT_ID and PROD_URL, plus either `wrangler login` or CLOUDFLARE_API_TOKEN.
// PROD_URL is the live URL, e.g. https://<name>.<sub>.workers.dev
//
//   node scripts/cf-release.mjs upload            gate + build HEAD, upload as a new Worker version tagged with the git sha (= Staging)
//   node scripts/cf-release.mjs promote [sha]     deploy that version to 100% (= Publish). Default: the newest upload
//   node scripts/cf-release.mjs rollback          deploy the previously promoted version (no rebuild)
//   node scripts/cf-release.mjs status            current deployment + recent versions
//   node scripts/cf-release.mjs cycle             upload → promote → empty commit → upload → promote → rollback, timing each step
//
// Every promote and rollback is verified: the script polls PROD_URL until the footer shows the expected sha
// and reports how long that took. Results are appended to spikes/.work/bench-results.json.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { CLOUDFLARE_ACCOUNT_ID, PROD_URL } = process.env;
if (!CLOUDFLARE_ACCOUNT_ID || !PROD_URL) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and PROD_URL first (and run `wrangler login` or set CLOUDFLARE_API_TOKEN).");
  process.exit(1);
}

const LOG = ".releases/cf-history.json"; // stands in for the platform's `releases` table
const RESULTS = resolve("../bench-results.json");
const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Calls wrangler's JS entry point through Node with no shell, so arguments (e.g. messages with spaces) pass through intact.
const WRANGLER = resolve("node_modules/wrangler/bin/wrangler.js");
const wrangler = (...args) =>
  execFileSync(process.execPath, [WRANGLER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const history = () => (existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : { uploads: [], promotions: [] });
const save = (h) => writeFileSync(LOG, JSON.stringify(h, null, 2));
const timed = async (fn) => { const t0 = performance.now(); const v = await fn(); return [v, +((performance.now() - t0) / 1000).toFixed(2)]; };

const [cmd = "status", arg] = process.argv.slice(2);
const commands = { upload, promote, rollback, status, cycle };
if (!commands[cmd]) { console.error(`Unknown command ${cmd}`); process.exit(1); }
await commands[cmd](arg);

async function upload() {
  const sha = sh("git rev-parse --short HEAD");
  const message = sh("git log -1 --pretty=%s");
  // The build is the validation gate: if it fails, nothing is uploaded and the live site is unchanged.
  const [, buildSeconds] = await timed(() =>
    execSync("npm run build", { stdio: "ignore", env: { ...process.env, GIT_SHA: sha, ASTRO_TELEMETRY_DISABLED: "1" } }));
  const [, uploadSeconds] = await timed(() => wrangler("versions", "upload", "--tag", sha, "--message", `${sha} ${message}`.slice(0, 100)));
  const versionId = resolveVersion(sha);
  const h = history();
  h.uploads.unshift({ sha, versionId, message, uploadedAt: new Date().toISOString() });
  save(h);
  console.log(`✔ uploaded ${sha} as version ${versionId} (build ${buildSeconds}s, upload ${uploadSeconds}s)`);
  record({ kind: "cf-upload", sha, versionId, buildSeconds, uploadSeconds });
  return { sha, versionId };
}

async function promote(sha) {
  const h = history();
  const target = sha ? h.uploads.find((u) => u.sha === sha) : h.uploads[0];
  if (!target) throw new Error(`No uploaded version for ${sha ?? "latest"}. Run upload first.`);
  const [, apiSeconds] = await timed(() => wrangler("versions", "deploy", `${target.versionId}@100%`, "--yes", "--message", `promote ${target.sha}`));
  const liveSeconds = await waitForRelease(target.sha);
  h.promotions.unshift({ ...target, promotedAt: new Date().toISOString() });
  save(h);
  console.log(`✔ promoted ${target.sha}: API ${apiSeconds}s, visible at ${PROD_URL} after ${liveSeconds}s`);
  record({ kind: "cf-promote", sha: target.sha, apiSeconds, liveSeconds });
}

async function rollback() {
  const h = history();
  const [current, previous] = h.promotions;
  if (!previous) throw new Error("Nothing to roll back to.");
  const [, apiSeconds] = await timed(() => wrangler("rollback", previous.versionId, "--yes", "--message", `rollback ${current.sha} → ${previous.sha}`));
  const liveSeconds = await waitForRelease(previous.sha);
  h.promotions.unshift({ ...previous, promotedAt: new Date().toISOString(), rollbackOf: current.sha });
  save(h);
  console.log(`↩ rolled back ${current.sha} → ${previous.sha}: API ${apiSeconds}s, visible after ${liveSeconds}s`);
  record({ kind: "cf-rollback", from: current.sha, to: previous.sha, apiSeconds, liveSeconds });
}

async function status() {
  console.log(wrangler("deployments", "status"));
  const versions = JSON.parse(wrangler("versions", "list", "--json"));
  for (const v of versions.slice(-5).reverse()) console.log(`${v.id}  ${v.annotations?.["workers/tag"] ?? ""}  ${v.metadata?.created_on ?? ""}`);
}

async function cycle() {
  const a = await upload();
  await promote(a.sha);
  execSync('git commit --allow-empty --no-verify -m "spike 0.1 release cycle"', { stdio: "ignore" });
  const b = await upload();
  await promote(b.sha);
  await rollback();
  console.log("✔ cycle complete: upload, promote, second release, rollback all verified against PROD_URL");
}

/** The tag we uploaded with is the release id, so the platform never has to parse wrangler's text output. */
function resolveVersion(tag) {
  const versions = JSON.parse(wrangler("versions", "list", "--json"));
  const match = versions.filter((v) => v.annotations?.["workers/tag"] === tag).pop();
  if (!match) throw new Error(`Uploaded, but no version tagged ${tag} found`);
  return match.id;
}

/** Polls PROD_URL until the footer shows the release sha. Measures how long a promote or rollback takes to be visible. */
async function waitForRelease(sha, timeoutMs = 120_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      const html = await (await fetch(`${PROD_URL}/?_=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } })).text();
      if (html.includes(`<code>${sha}</code>`)) return +((performance.now() - t0) / 1000).toFixed(2);
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${PROD_URL} did not show release ${sha} within ${timeoutMs / 1000}s`);
}

function record(result) {
  const all = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : [];
  all.push({ ...result, at: new Date().toISOString() });
  writeFileSync(RESULTS, JSON.stringify(all, null, 2));
}
