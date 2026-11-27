// Pushes secrets from .local/secrets.json to Vercel production via stdin (never on the command line).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(".local/secrets.json", "utf8"));
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["DATABASE_URL", "MASTER_KEY", "CRON_SECRET", "ACCESS_KEY", "WEBHOOK_SECRET"];
for (const name of names) {
  spawnSync("vercel", ["env", "rm", name, "production", "--yes"], { shell: true, stdio: "ignore" });
  const r = spawnSync("vercel", ["env", "add", name, "production", "--sensitive"], { input: s[name], shell: true, encoding: "utf8" });
  console.log(name, r.status === 0 ? "set" : `failed: ${(r.stderr || r.stdout).split("\n").slice(-3).join(" ")}`);
}
