---
name: add-thrive
description: Add the Thrive iOS and Android app as a channel. Connects Omega to users via RabbitMQ and Appwrite. Sends deliver, read, and typing receipts that the Thrive mobile client understands natively.
---

# Add Thrive Channel

This skill adds the Thrive iOS and Android channel to NanoClaw, then walks
through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/thrive.ts` exists. If it does, skip to Phase 3
(Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `thrive` remote is missing, add it:

```bash
git remote add thrive https://github.com/Sandile-Memela/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch thrive skill/thrive
git merge thrive/skill/thrive || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:

- `src/channels/thrive.ts` — ThriveChannel class with self-registration
- `import './thrive.js'` appended to `src/channels/index.ts`
- `registerGroup?` added to `ChannelOpts` in `src/channels/registry.ts`
- `amqplib ^1.0.3` and `node-appwrite ^14.2.0` npm dependencies
- `@types/amqplib ^0.10.8` dev dependency
- Thrive env vars in `.env.example`

If the merge reports conflicts, resolve them by reading both sides.

### Validate

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

Collect the following from the user (use `AskUserQuestion` if any are missing):

| Variable | Description |
|---|---|
| `RABBITMQ_URL` | `amqp://user:pass@host:5672` connection string |
| `THRIVE_APPWRITE_ENDPOINT` | Appwrite endpoint, e.g. `https://cloud.appwrite.io/v1` |
| `THRIVE_APPWRITE_PROJECT_ID` | Appwrite project ID |
| `THRIVE_APPWRITE_API_KEY` | Server API key with Functions execute permissions |
| `THRIVE_APPWRITE_FUNCTION_ID` | ID of the deployed RabbitMQ Appwrite function |
| `THRIVE_OMEGA_USER_ID` | Omega's Appwrite user ID (optional — leave blank if Omega has no account) |
| `THRIVE_OMEGA_SESSION_ID` | Leave blank — auto-generated and persisted on first run |

### Configure environment

Add to `.env`:

```
RABBITMQ_URL=amqp://user:pass@host:5672
THRIVE_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
THRIVE_APPWRITE_PROJECT_ID=<project-id>
THRIVE_APPWRITE_API_KEY=<api-key>
THRIVE_APPWRITE_FUNCTION_ID=<function-id>
THRIVE_OMEGA_USER_ID=
THRIVE_OMEGA_SESSION_ID=
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

Thrive users are **auto-registered** the first time they message Omega — no
manual registration step is needed. Each user gets an isolated group folder
under `groups/thrive_<userId>/`.

To manually pre-register a user (optional):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "<userId>-<userType>-<teamId>@thrive" \
  --name "<display-name>" \
  --folder "thrive_<userId>" \
  --trigger "@Omega" \
  --channel thrive \
  --no-trigger-required
```

## Phase 5: Verify

Tell the user:

> Have a Thrive iOS user send a message to Omega. You should see:
>
> 1. A delivery receipt tick on the iOS side within seconds
> 2. A read receipt tick shortly after
> 3. A typing indicator while Omega processes
> 4. Omega's reply arriving in the Thrive chat

Check logs if needed:

```bash
tail -f logs/nanoclaw.log | grep -i thrive
```

## How it works

- **Inbound** — Omega subscribes to its own RabbitMQ exchange (`omegaId-type-teamId@sessionId`). Messages arrive as `ThriveMessage` JSON. Non-text and receipt messages are filtered out before routing to the agent.
- **Receipts** — On each inbound message: a `deliver` receipt fires immediately, followed by a `read` receipt. Both are sent back via the Appwrite RabbitMQ function.
- **Typing indicator** — When the agent starts processing, a `type` receipt fires every 3 seconds until the reply is sent (or 5 minutes max as a safety valve). Interval failures are caught and logged as warnings rather than crashing the timer.
- **Outbound** — Replies longer than 900 characters are split into chunks and sent sequentially. The typing timer is cancelled synchronously before the first chunk is sent (so the interval cannot fire during an async yield and queue a stale typing receipt after the message). Each chunk is sent via the Appwrite function (`operation: receive`) with `async: true` so Appwrite queues the execution immediately without waiting for it to complete. If the HTTP call to Appwrite fails, it retries up to 3 times with a 2-second delay.
- **Auto-reconnect** — RabbitMQ disconnections trigger an automatic 5-second reconnect loop.
- **Session ID** — `THRIVE_OMEGA_SESSION_ID` is auto-generated and appended to `.env` on first run so Thrive devices can always find Omega's exchange.

## Troubleshooting

### Omega not receiving messages

1. Check `RABBITMQ_URL` is correct and the broker is reachable
2. Verify `THRIVE_OMEGA_SESSION_ID` in `.env` matches what the iOS app is publishing to
3. Check logs: `tail -f logs/nanoclaw.log | grep -i "thrive\|rabbitmq"`
4. Confirm the exchange name the iOS app targets matches `<OMEGA_ID>-<OMEGA_TYPE>-<OMEGA_TEAM_ID>@<sessionId>` — these constants are hardcoded at the top of `src/channels/thrive.ts`

### Replies not reaching the user

1. Check `THRIVE_APPWRITE_API_KEY` has `Functions execute` permissions
2. Verify `THRIVE_APPWRITE_FUNCTION_ID` is the deployed RabbitMQ function, not another function
3. Look for retry warnings in the log — three consecutive failures mean Appwrite is unreachable

### Receipts not showing in iOS

1. Confirm the `operation: receipt` path is handled by the deployed Appwrite function
2. The receipt message JSON uses `'` in place of `"` and `~~` in place of `'` — this is the encoding the function expects

## Removal

1. Delete `src/channels/thrive.ts`
2. Remove `import './thrive.js'` from `src/channels/index.ts`
3. Remove the `registerGroup?` line from `ChannelOpts` in `src/channels/registry.ts` (only if no other channel uses it)
4. Remove Thrive vars from `.env`
5. Uninstall deps: `npm uninstall amqplib node-appwrite @types/amqplib`
6. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
