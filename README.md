# gemini-relay-worker

Cloudflare Worker port of [gemini-web2api](../gemini-web2api) — exposes Google Gemini's
**web** StreamGenerate endpoint as an OpenAI-compatible API, running at the edge.

> **Status: full port (v0.2.0).** The Cloudflare IP path is validated (`wrangler dev`
> reaches Gemini Web). Workers `fetch()` has no proxy escape hatch, unlike the Python
> version's `--proxy` — if Google ever blocks Cloudflare egress IPs, there is no
> in-Worker workaround. Confirm with a real `wrangler deploy` before relying on it.

## Implemented

OpenAI Chat Completions:
- `GET /` — status + model list
- `GET /v1/models` — OpenAI model list
- `POST /v1/chat/completions` — chat completion, **streaming (SSE)** + **tool calling**

OpenAI Responses API (Codex CLI):
- `POST /v1/responses` — streaming + non-streaming, with tool calling

Google native API (Gemini CLI):
- `GET /v1beta/models`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- function calling + inline image upload (Scotty resumable upload, cookie-dependent)

Image input is only wired through the Google `/v1beta` path (inline data), mirroring
the Python server; OpenAI `image_url` parts are replaced with a text note.

## Develop

```bash
npm install
npm run typecheck          # tsc --noEmit
cp .dev.vars.example .dev.vars   # optional: add COOKIE / API_KEYS
npm run dev                # wrangler dev → http://localhost:8787
```

### Smoke test (the actual validation)

```bash
curl http://localhost:8787/v1/models

curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"Say hi in one word"}]}'
```

A real reply ⇒ Cloudflare IPs work, proceed with the full port.
An empty/`502`/blocked response ⇒ Gemini is rejecting datacenter IPs; reconsider.

> Note: `wrangler dev` proxies subrequests through Cloudflare's edge, so a local
> success is a strong signal. Confirm with a real `wrangler deploy` before trusting it.

## Deploy

```bash
wrangler deploy
wrangler secret put COOKIE        # optional, for Pro routing
wrangler secret put API_KEYS      # optional, to require auth
```

## Configuration

| Name | Where | Purpose |
|------|-------|---------|
| `GEMINI_BL` | `wrangler.jsonc` var | Date-stamped Gemini build label; Google rotates it. Refresh if requests start failing. |
| `DEFAULT_MODEL` | `wrangler.jsonc` var | Fallback model name. |
| `REQUEST_TIMEOUT_SEC` | `wrangler.jsonc` var | Upstream fetch timeout (I/O wait, not CPU). |
| `API_KEYS` | secret / `.dev.vars` | Comma-separated; empty ⇒ auth disabled. |
| `COOKIE` | secret / `.dev.vars` | Signed-in cookie header for Pro routing. |
| `XSRF_TOKEN` | secret / `.dev.vars` | Page `SNlM0e` token for authenticated requests. |
| `AUTH_USER` | secret / `.dev.vars` | Google account index for `/u/<index>/` routing. |

## Architecture

Mirrors the Python package, minus the server plumbing (the Worker runtime replaces it):

- `src/models.ts` — model name → `MODE_CATEGORY` + thinking depth (`@think=N` suffix).
- `src/gemini.ts` — the reverse-engineered protocol: positional payload array
  (`inner[79]`=model, `inner[17]`=think), `SAPISIDHASH` via Web Crypto, `wrb.fr`
  response parsing, and `generate` / `generateStream`.
- `src/tools.ts` — prompt-engineered function calling (OpenAI + Google formats) and
  message/contents → prompt flattening.
- `src/multimodal.ts` — Scotty resumable image upload (`content-push.googleapis.com`).
- `src/index.ts` — `fetch` handler / router for all three API surfaces.
