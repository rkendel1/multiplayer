#!/usr/bin/env node
/**
 * Turn the Fly.io (or container) artifact `feltkit deploy` wrote into the public demo:
 *
 *   npm run deploy:demo        = npx feltkit deploy --target fly && node scripts/demo-artifact.mjs
 *   npx feltkit fly deploy     deploys it, exactly as for production
 *
 * The artifact stays FeltKit's (built, verified, same Dockerfile and fly.toml). This only changes how the
 * container starts: scripts/demo-server.mjs runs the app in FeltKit's development environment, so visitors are
 * signed in as a dev user (no login page), and loads the demo data once (scripts/demo-seed.ts). The
 * development runtime files (.feltkit/development: local AuthBoundry, admin token) are kept on the volume
 * with the data, so a redeploy keeps both. Every FeltKit starter ships this same file.
 *
 *   node scripts/demo-artifact.mjs [artifact dir]   (default .feltkit/deploy)
 *
 * The demo is its own Fly app, `<app>-demo` (https://<app>-demo.fly.dev), so it never replaces a production
 * deployment; name it with package.json "feltkitDemo": { "flyApp": "…" } or DEMO_FLY_APP.
 * Extra files the seed needs at runtime: package.json "feltkitDemo": { "include": ["scripts/seed.ts"] }.
 * DEMO ONLY: see scripts/demo-server.mjs.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = resolve(root, process.argv[2] ?? ".feltkit/deploy");
const fail = (message) => {
  console.error(`[demo] ${message}`);
  process.exit(1);
};

const targetFile = join(dir, ".feltkit", "target.json");
if (!existsSync(targetFile)) fail(`No deploy artifact at ${dir}. Build it first: npx feltkit deploy --target fly`);
const { target } = JSON.parse(readFileSync(targetFile, "utf8"));
if (!["fly", "container"].includes(target)) fail(`The artifact is for --target ${target}; a demo runs on a volume: --target fly (or container).`);

const dockerfile = join(dir, "Dockerfile");
let docker = readFileSync(dockerfile, "utf8");
if (docker.includes("scripts/demo-server.mjs")) {
  console.log(`[demo] ${dir} is already the demo.`);
  process.exit(0);
}
// The demo keeps everything on the volume FeltKit's artifact declares; managed or self-hosted data has none.
if (!docker.includes("FELTKIT_STATE_DIR=/data/state")) fail("The artifact keeps no state on a /data volume (--data managed or self-hosted?). Build it with the default --data volume.");
const START = 'CMD ["node", "node_modules/@feltdb/feltkit/bin/feltkit.js", "start", "--host", "0.0.0.0"]';
if (!docker.includes(START)) fail(`The Dockerfile does not start the app with ${START}; this FeltKit's artifact is not one this script knows.`);

// What the demo needs at runtime: the launcher, the seed, the generated function references, and declared extras.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = ["scripts/demo-server.mjs", "scripts/demo-seed.ts", "feltkit/_generated", ...(pkg.feltkitDemo?.include ?? [])];
for (const file of files) {
  if (!existsSync(join(root, file))) continue;
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  cpSync(join(root, file), join(dir, file), { recursive: true });
}

// The local AuthBoundry (delegation), which development runs, is a native binary built against glibc 2.39 and
// OpenSSL 3; node:22-slim (Debian 12: glibc 2.36, no libssl3) cannot load it. Debian 13's slim image has both.
const lock = existsSync(join(dir, "package-lock.json")) ? readFileSync(join(dir, "package-lock.json"), "utf8") : "";
if (lock.includes('"node_modules/@authboundry/core"')) {
  if (!/^FROM node:22-slim$/m.test(docker)) fail("The app runs a local AuthBoundry, but the Dockerfile is not FROM node:22-slim; check its base has glibc >= 2.39 and libssl3.");
  docker = docker.replace(/^FROM node:22-slim$/m, "# Demo: the local AuthBoundry binary needs glibc >= 2.39 and OpenSSL 3 (Debian 13).\nFROM node:22-trixie-slim");
}

docker = docker
  .replace(
    "USER node",
    [
      "# Demo: FeltKit's development runtime files live on the volume beside the state (created at start),",
      "# and the app may write under .feltkit (the seed's cache).",
      "RUN mkdir -p .feltkit && ln -sfn /data/development .feltkit/development && chown node:node .feltkit",
      "USER node",
    ].join("\n"),
  )
  .replace(
    START,
    [
      "# PUBLIC DEMO (scripts/demo-artifact.mjs): the development environment, visitors signed in as dev users,",
      "# demo data loaded once. Never give it real credentials. Production: npx feltkit deploy --target fly.",
      'CMD ["sh", "-c", "mkdir -p /data/development && exec node scripts/demo-server.mjs"]',
    ].join("\n"),
  );
writeFileSync(dockerfile, docker);

// Its own Fly app, never the production one: "<app>-demo" unless named (package.json feltkitDemo.flyApp, or DEMO_FLY_APP).
const flyToml = join(dir, "fly.toml");
let flyApp = null;
if (existsSync(flyToml)) {
  const toml = readFileSync(flyToml, "utf8");
  const current = /^app\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!current) fail(`${flyToml} names no app.`);
  flyApp = process.env.DEMO_FLY_APP || pkg.feltkitDemo?.flyApp || `${current}-demo`;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(flyApp)) fail(`"${flyApp}" is not a Fly app name (lowercase letters, digits, dashes).`);
  writeFileSync(flyToml, toml.replace(/^app\s*=\s*"[^"]+"/m, `app = "${flyApp}"`));
}

const deployMd = join(dir, "DEPLOY.md");
if (existsSync(deployMd)) {
  writeFileSync(
    deployMd,
    readFileSync(deployMd, "utf8") +
      "\n## This artifact is the public demo\n\n" +
      "`scripts/demo-artifact.mjs` changed how the container starts: `scripts/demo-server.mjs` runs the app in FeltKit's\n" +
      "development environment, so every visitor is signed in as a dev user, with that user's roles, on one shared copy\n" +
      "of the data, and loads the demo data once (`scripts/demo-seed.ts`). The development runtime files are on the\n" +
      "volume at /data/development. Never give this deployment real credentials. For production, rebuild with\n" +
      "`npx feltkit deploy --target fly` and do not run `scripts/demo-artifact.mjs`.\n",
  );
}
console.log(`[demo] ${dir} now starts the public demo${flyApp ? ` (Fly app ${flyApp}: https://${flyApp}.fly.dev)` : ""}. Deploy it: npx feltkit fly deploy`);
