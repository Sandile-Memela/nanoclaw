#!/usr/bin/env node
/**
 * GitHub webhook receiver for NanoClaw auto-deploy.
 * Listens on PORT (default 9000), verifies HMAC-SHA256 signature,
 * and runs pull + build + restart on push to the configured branch.
 *
 * Required env vars:
 *   WEBHOOK_SECRET   — GitHub webhook secret (set when registering the hook)
 *   DEPLOY_BRANCH    — branch that triggers a deploy (default: "main")
 *   NANOCLAW_DIR     — absolute path to the nanoclaw install (default: /root/nanoclaw)
 *   PORT             — port to listen on (default: 9000)
 */

import http from "http";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.PORT ?? "9000", 10);
const SECRET = process.env.WEBHOOK_SECRET ?? "";
const BRANCH = process.env.DEPLOY_BRANCH ?? "main";
const DIR = process.env.NANOCLAW_DIR ?? "/root/nanoclaw";

if (!SECRET) {
  console.error("[webhook] WEBHOOK_SECRET is not set — refusing to start.");
  process.exit(1);
}

function verifySignature(payload, signature) {
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(payload);
  const expected = "sha256=" + hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function deploy() {
  console.log("[webhook] deploying...");
  const steps = [
    ["git", ["-C", DIR, "pull", "origin", BRANCH]],
    ["npm", ["--prefix", DIR, "ci"]],
    ["npm", ["--prefix", DIR, "run", "build"]],
    ["systemctl", ["restart", "nanoclaw"]],
  ];

  for (const [cmd, args] of steps) {
    console.log(`[webhook] $ ${cmd} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: DIR });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } catch (err) {
      console.error(`[webhook] step failed: ${cmd} ${args.join(" ")}`);
      console.error(err.message);
      return false;
    }
  }
  console.log("[webhook] deploy complete.");
  return true;
}

let deploying = false;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end("not found");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const sig = req.headers["x-hub-signature-256"] ?? "";

    if (!verifySignature(body, sig)) {
      console.warn("[webhook] bad signature — ignoring");
      res.writeHead(401).end("unauthorized");
      return;
    }

    const event = req.headers["x-github-event"];
    if (event !== "push") {
      res.writeHead(200).end("ignored");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    const pushedBranch = payload.ref?.replace("refs/heads/", "");
    if (pushedBranch !== BRANCH) {
      console.log(`[webhook] push to ${pushedBranch}, not ${BRANCH} — skipping`);
      res.writeHead(200).end("skipped");
      return;
    }

    res.writeHead(202).end("deploying");

    if (deploying) {
      console.warn("[webhook] deploy already in progress — skipping");
      return;
    }
    deploying = true;
    try {
      await deploy();
    } finally {
      deploying = false;
    }
  });
});

server.listen(PORT, () => {
  console.log(`[webhook] listening on port ${PORT} — branch: ${BRANCH} — dir: ${DIR}`);
});
