#!/usr/bin/env node
/**
 * Public demo deployment. Locally: `npm run build && npm run start:demo`. On Fly.io: `npm run deploy:demo`, then
 * `npx feltkit fly deploy` (scripts/demo-artifact.mjs makes the container start with this file).
 *
 * Runs the built application in FeltKit's development environment, so its declared dev users are
 * offered and the app signs a visitor straight in (no login page), then loads the demo data once
 * through the app's own functions (scripts/demo-seed.ts). Every FeltKit starter ships this same file.
 *
 * DEMO ONLY. Every visitor acts as a dev user, with that user's roles, on one shared copy of the data.
 * Do not give a demo deployment real provider keys, credentials or customer data.
 *
 *   PORT=8080 npm run start:demo                 listen on 8080 (default: FeltKit's, from 3000)
 *   HOST=127.0.0.1 npm run start:demo            interface (default 0.0.0.0)
 *   FELTKIT_STATE_DIR=/data npm run start:demo   keep the demo state on a volume
 *   DEMO_SEED=0 npm run start:demo               serve without loading demo data
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const feltkit = `${root}node_modules/@feltdb/feltkit/bin/feltkit.js`;

if (process.env.FELTKIT_ENV && process.env.FELTKIT_ENV !== "development") {
  console.error(`[demo] FELTKIT_ENV is "${process.env.FELTKIT_ENV}"; a demo deployment runs the development environment. Unset it.`);
  process.exit(1);
}
const args = [feltkit, "start", "--env", "development", "--host", process.env.HOST ?? "0.0.0.0", ...process.argv.slice(2)];
const server = spawn(process.execPath, args, { cwd: root, stdio: ["inherit", "pipe", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

let seeded = false;
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const url = !seeded && String(chunk).match(/serving (https?:\/\/\S+)/)?.[1];
  if (!url) return;
  seeded = true;
  void seed(url);
});

async function seed(url) {
  const script = fileURLToPath(new URL("./demo-seed.ts", import.meta.url));
  if (process.env.DEMO_SEED === "0" || !existsSync(script)) return;
  // Reach the server on loopback whatever interface it listens on.
  const local = url.replace(/\/\/[^/:]+/, "//127.0.0.1");
  // tsx ships with FeltKit; `--import` resolves it from the project.
  const child = spawn(process.execPath, ["--import", "tsx", script, local], { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => console.log(code === 0 ? "[demo] Demo data ready." : `[demo] Loading demo data failed (exit ${code}); the app is still served.`));
}
