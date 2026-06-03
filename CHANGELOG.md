# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-02

Full port of [gemini-web2api](https://github.com/zhiyu1998/gemini-web2api)'s
`server.py` to a Cloudflare Worker, plus production deployment and auth.

### Added
- **OpenAI Chat Completions** (`POST /v1/chat/completions`) with SSE streaming
  and prompt-engineered tool calling.
- **OpenAI Responses API** (`POST /v1/responses`) for OpenAI Codex CLI, streaming
  and non-streaming, with tool calling.
- **Google native API** for Gemini CLI: `GET /v1beta/models`,
  `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`,
  including function calling and inline image upload.
- **Image upload** via Google's Scotty resumable-upload protocol
  (`content-push.googleapis.com`), wired through the Google `/v1beta` path.
- **API-key auth** (`API_KEYS` secret) gating `/v1/*`; disabled when unset.
- `src/tools.ts` (tool calling + message flattening) and `src/multimodal.ts`
  (image upload) modules.

### Changed
- `src/gemini.ts` gained `generateStream` (incremental delta streaming via
  `ReadableStream`) and file-reference support in the payload builder.

## [0.1.0] - 2026-06-02

Minimal validation slice — built to confirm Gemini Web accepts requests from
Cloudflare datacenter IPs before investing in the full port.

### Added
- Worker scaffold: `wrangler.jsonc`, `tsconfig.json`, strict TypeScript.
- `GET /`, `GET /v1/models`, and non-streaming `POST /v1/chat/completions`.
- `src/gemini.ts` — reverse-engineered StreamGenerate protocol: positional
  payload array (`inner[79]`=model, `inner[17]`=think), `SAPISIDHASH` via Web
  Crypto, and `wrb.fr` response parsing.
- `src/models.ts` — model name → `MODE_CATEGORY` mapping with `@think=N` suffix.

[Unreleased]: https://github.com/7a6163/gemini-relay-worker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/7a6163/gemini-relay-worker/releases/tag/v0.2.0
[0.1.0]: https://github.com/7a6163/gemini-relay-worker/releases/tag/v0.1.0
