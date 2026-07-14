# Mem0 OpenCode Plugin (Self-Hosted)

A fork of the Mem0 OpenCode plugin that swaps the hosted mem0.ai cloud API for
a **self-hosted mem0 FastAPI server** (this repo's `server/`).

## Features

- Plugin targets any HTTP endpoint via `MEM0_API_BASE_URL`
- Bundles its own thin REST client — no `mem0ai` npm SDK dependency
- Works against `server/` on `docker-compose up` (localhost:8888)
- Optional auth: works with `AUTH_DISABLED=true` in dev, or `X-API-Key` in prod

## Why

The upstream plugin is hard-wired to `api.mem0.ai/v1/*`. This fork rewires
every memory operation to the self-hosted OSS server, drops the cloud-only
features that the server never had (`app_id`, custom categories, async event
queue, `AND/OR` filters), and folds project isolation into `user_id` so the
server's flat identity model is enough. See
[integrations/mem0-plugin/.opencode-plugin/README.md](integrations/mem0-plugin/.opencode-plugin/README.md)
for the plugin-side setup guide.

## Quick start

```bash
# 1. Run the self-hosted mem0 server
cd server && docker-compose up

# 2. Point the plugin at it (in the shell where you launch OpenCode)
export MEM0_API_BASE_URL="http://localhost:8888"

# 3. Install the plugin
opencode plugin @mem0/opencode-plugin
```

## License

Apache-2.0. Original project: https://github.com/mem0ai/mem0
