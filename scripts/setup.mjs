// One-off local setup: git repo, post-commit release hook, dev secret, first release.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
if (!existsSync(".git")) run("git init -b main");

// Every commit triggers a release (stand-in for: merge to main → CI gates → deploy).
writeFileSync(".git/hooks/post-commit", "#!/bin/sh\nnode scripts/release.mjs\n", { mode: 0o755 });
console.log("post-commit hook installed");

const hasCommits = (() => { try { execSync("git rev-parse HEAD", { stdio: "ignore" }); return true; } catch { return false; } })();
if (!hasCommits) {
  run("git add -A");
  run('git commit -m "Initial site"'); // the hook performs the first release
}
