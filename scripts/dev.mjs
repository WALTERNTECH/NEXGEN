// Local dev: PGlite database with demo leads, Next dev server on :5340.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
const p = spawn(process.execPath, [next, "dev", "-p", process.env.PORT || "5340"], { cwd: root, stdio: "inherit", env: { ...process.env, NEXGEN_DEMO: "1", DATABASE_URL: "" } });
p.on("exit", (c) => process.exit(c ?? 0));
