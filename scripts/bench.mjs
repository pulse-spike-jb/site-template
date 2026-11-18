// Spike 0.1 benchmarks. Runs against a throwaway copy of this template at spikes/.work/bench,
// reusing node_modules from spikes/.work/astro-head (run `node spikes/setup.mjs` first).
//
//   node scripts/bench.mjs build 1000 5000     # time `npm run build` at each page count
//   node scripts/bench.mjs edge 1000           # build N pages, run wrangler dev, measure Worker/HTMLRewriter overhead
//
// Results are appended to spikes/.work/bench-results.json.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const template = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = resolve(template, "../.work");
const bench = join(work, "bench");
const modules = join(work, "astro-head/node_modules");
const resultsFile = join(work, "bench-results.json");

const WORDS = "care clinic patient referral appointment service general practice diagnostics imaging specialist local fast connected results team nurse doctor health community support booking same day week family children seniors physiotherapy cardiology dermatology bloods screening vaccination advice".split(" ");

const [mode = "build", ...args] = process.argv.slice(2);
const counts = args.map(Number).filter(Boolean);

if (!existsSync(modules)) {
  console.error("node_modules not found at spikes/.work/astro-head. Run `node spikes/setup.mjs` first.");
  process.exit(1);
}

if (mode === "build") {
  for (const n of counts.length ? counts : [1000, 5000]) await buildBench(n);
} else if (mode === "edge") {
  await edgeBench(counts[0] ?? 1000);
} else {
  console.error(`Unknown mode "${mode}". Use build or edge.`);
  process.exit(1);
}

// ---------------------------------------------------------------- build benchmark
async function buildBench(n) {
  prepare(n);
  const t0 = performance.now();
  await run("npm", ["run", "build"], { cwd: bench, quiet: true });
  const seconds = (performance.now() - t0) / 1000;
  const dist = du(join(bench, "dist"));
  const result = {
    kind: "build", pages: n + 6, seconds: +seconds.toFixed(1), perThousand: +((seconds / (n + 6)) * 1000).toFixed(1),
    htmlFiles: dist.html, distMB: +(dist.bytes / 1e6).toFixed(1), node: process.version, at: new Date().toISOString(),
  };
  record(result);
  console.log(`build ${result.pages} pages: ${result.seconds}s (${result.perThousand}s per 1k), ${result.htmlFiles} HTML files, ${result.distMB} MB`);
}

/** Fresh copy of the template plus N generated pages under /bench/. */
function prepare(n) {
  rmSync(bench, { recursive: true, force: true });
  cpSync(template, bench, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.preview|\.staging|\.astro|\.wrangler)([\\/]|$)/.test(src.slice(template.length)),
  });
  symlinkSync(modules, join(bench, "node_modules"), "junction");
  writeFileSync(join(bench, ".dev.vars"), "SESSION_SECRET=bench-only-secret\n");
  const perSection = 25;
  for (let i = 0; i < n; i++) {
    const s = String(Math.floor(i / perSection)).padStart(3, "0");
    const p = String(i).padStart(5, "0");
    const dir = join(bench, "content/pages/bench", `s${s}`, `p${p}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.json"), JSON.stringify(page(i, s, p), null, 2));
  }
}

/** A realistic content page: personalised hero, 2-4 feature grids, CTA. ~8-15 KB of HTML. */
function page(i, s, p) {
  const lorem = (words, seed) => Array.from({ length: words }, (_, k) => WORDS[(seed * 7 + k * 13) % WORDS.length]).join(" ");
  const grids = 2 + (i % 3);
  const sections = [
    {
      id: `sec_${p}_hero`, component: "Hero",
      props: { heading: `Service ${i}: ${lorem(5, i)}`, subheading: lorem(25, i + 1).slice(0, 230), ctaLabel: "Book now", ctaHref: "/services/", tone: "primary" },
      ...(i % 3 === 0 ? { personalise: { healthcare: { heading: `Refer a patient for service ${i}`, ctaLabel: "Start a referral" }, uk: { subheading: lorem(20, i + 2).slice(0, 230) } } } : {}),
    },
    ...Array.from({ length: grids }, (_, g) => ({
      id: `sec_${p}_grid${g}`, component: "FeatureGrid",
      props: { heading: lorem(4, i + g), items: Array.from({ length: 3 + (g % 4) }, (_, k) => ({ title: lorem(3, i + g + k), body: lorem(22, i * g + k).slice(0, 230) })) },
    })),
    {
      id: `sec_${p}_cta`, component: "CTA",
      props: { heading: lorem(8, i + 9).slice(0, 110), label: "Talk to us", href: "/services/" },
      ...(i % 3 === 0 ? { personalise: { healthcare: { heading: "Questions about referrals?" } } } : {}),
    },
  ];
  return { id: `pg_bench_${p}`, title: `Bench ${s}/${p}`, seo: { description: lorem(18, i).slice(0, 150) }, sections };
}

// ---------------------------------------------------------------- edge (Worker) benchmark
async function edgeBench(n) {
  prepare(n);
  await run("npm", ["run", "build"], { cwd: bench, quiet: true });

  // Wrap the real Worker so one process can serve three modes, chosen per request by a header.
  writeFileSync(join(bench, "worker/bench.ts"), `
import worker from "./index";
export default {
  async fetch(req: Request, env: any, ctx: any): Promise<Response> {
    if (req.headers.get("x-bench-mode") === "raw") return env.ASSETS.fetch(req); // Worker invoked, no work
    return worker.fetch(req, env, ctx);                                        // full site Worker
  },
};`);
  const cfg = readFileSync(join(bench, "wrangler.jsonc"), "utf8").replace('"main": "worker/index.ts"', '"main": "worker/bench.ts"');
  writeFileSync(join(bench, "wrangler.bench.jsonc"), cfg);

  const port = 8799;
  const dev = spawn("npx", ["wrangler", "dev", "-c", "wrangler.bench.jsonc", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "error"],
    { cwd: bench, shell: true, stdio: "ignore" });
  try {
    await waitFor(`http://127.0.0.1:${port}/`);
    const personalised = "/bench/s000/p00000/"; // i % 3 === 0 → has personalisation markers
    const plain = "/bench/s000/p00001/";
    const cases = [
      ["raw: Worker returns the asset untouched", personalised, { "x-bench-mode": "raw" }],
      ["full Worker, no segment (markers stripped)", personalised, {}],
      ["full Worker, segment healthcare (rewritten)", `${personalised}?seg=healthcare`, {}],
      ["full Worker, page without markers", plain, {}],
    ];
    const out = [];
    for (const [label, path, headers] of cases) {
      await load(`http://127.0.0.1:${port}${path}`, headers, 200, 10); // warm up
      const r = await load(`http://127.0.0.1:${port}${path}`, headers, 2000, 10);
      out.push({ label, ...r });
      console.log(`${label.padEnd(48)} p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  (${r.bytes} bytes)`);
    }
    const base = out[0], seg = out[2];
    console.log(`\nWorker + personalisation overhead vs raw (local workerd): p50 +${(seg.p50 - base.p50).toFixed(2)} ms, p95 +${(seg.p95 - base.p95).toFixed(2)} ms`);
    record({ kind: "edge-local", pages: n + 6, cases: out, node: process.version, at: new Date().toISOString() });
  } finally {
    dev.kill();
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

async function load(url, headers, total, concurrency) {
  const times = [];
  let bytes = 0, next = 0;
  async function worker() {
    while (next < total) {
      next++;
      const t0 = performance.now();
      const res = await fetch(url, { headers, redirect: "manual" });
      const body = await res.arrayBuffer();
      times.push(performance.now() - t0);
      bytes = body.byteLength;
      if (res.status !== 200) throw new Error(`${url} → ${res.status}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  times.sort((a, b) => a - b);
  const q = (p) => +times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2);
  return { requests: total, concurrency, p50: q(0.5), p95: q(0.95), p99: q(0.99), bytes };
}

async function waitFor(url, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start at ${url}`);
}

// ---------------------------------------------------------------- helpers
function run(cmd, args, { cwd, quiet }) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, shell: true, stdio: quiet ? ["ignore", "ignore", "pipe"] : "inherit" });
    let err = "";
    p.stderr?.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${err.slice(-2000)}`))));
  });
}

function du(dir) {
  let bytes = 0, html = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) { const d = du(f); bytes += d.bytes; html += d.html; }
    else { bytes += statSync(f).size; if (e.name.endsWith(".html")) html++; }
  }
  return { bytes, html };
}

function record(result) {
  const all = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : [];
  all.push(result);
  writeFileSync(resultsFile, JSON.stringify(all, null, 2));
}

