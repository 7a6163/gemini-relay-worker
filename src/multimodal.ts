// Multimodal image upload via Google's Scotty resumable-upload protocol,
// ported from gemini-web2api's multimodal.py. Cookie-dependent and best-effort:
// only the Google /v1beta path wires images through (mirrors the Python server).

import { type Env, makeSapisidHash } from "./gemini";
import type { ImageItem } from "./tools";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

interface PageTokens {
  push_id?: string;
  pctx?: string;
  at?: string;
}

let pageTokensCache: { tokens: PageTokens; ts: number } = { tokens: {}, ts: 0 };

async function getPageTokens(env: Env): Promise<PageTokens> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (env.COOKIE) headers["Cookie"] = env.COOKIE;
  try {
    const resp = await fetch("https://gemini.google.com/app", { headers });
    const html = await resp.text();
    const tokens: PageTokens = {};
    const patterns: Array<[keyof PageTokens, RegExp]> = [
      ["push_id", /"qKIAYe":"([^"]+)"/],
      ["pctx", /"Ylro7b":"([^"]+)"/],
      ["at", /"thykhd":"([^"]+)"/],
    ];
    for (const [key, pattern] of patterns) {
      const m = html.match(pattern);
      if (m) tokens[key] = m[1];
    }
    return tokens;
  } catch {
    return {};
  }
}

async function cachedPageTokens(env: Env): Promise<PageTokens> {
  const now = Date.now();
  if (now - pageTokensCache.ts > 600_000) {
    pageTokensCache = { tokens: await getPageTokens(env), ts: now };
  }
  return pageTokensCache.tokens;
}

function parseSapisidFromCookie(cookie: string): string | null {
  for (const pair of cookie.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq) === "SAPISID") return pair.slice(eq + 1);
  }
  return null;
}

/** Upload one image via Scotty resumable upload. Returns the file-reference path. */
export async function uploadImage(imageBytes: Uint8Array, mimeType: string, env: Env): Promise<string> {
  const tokens = await cachedPageTokens(env);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";

  const startHeaders: Record<string, string> = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(imageBytes.length),
    "X-Goog-Upload-Header-Content-Type": mimeType,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": USER_AGENT,
  };
  if (env.COOKIE) {
    startHeaders["Cookie"] = env.COOKIE;
    const sapisid = env.SAPISID || parseSapisidFromCookie(env.COOKIE);
    if (sapisid) startHeaders["Authorization"] = await makeSapisidHash(sapisid);
  }

  const startResp = await fetch("https://content-push.googleapis.com/upload/", {
    method: "POST",
    headers: startHeaders,
    body: "",
  });
  const uploadUrl =
    startResp.headers.get("X-Goog-Upload-URL") || startResp.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("No upload URL in Scotty start response");

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Type": "application/octet-stream",
      "User-Agent": USER_AGENT,
    },
    body: imageBytes,
  });
  const fileRef = (await uploadResp.text()).trim();
  if (!fileRef || !fileRef.startsWith("/")) throw new Error(`Invalid file reference: ${fileRef.slice(0, 100)}`);
  return fileRef;
}

async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/** Upload a batch of images; returns file refs, or null if none succeed. */
export async function uploadImages(images: ImageItem[] | undefined, env: Env): Promise<string[] | null> {
  if (!images || !images.length) return null;
  const refs: string[] = [];
  for (const [item, mime] of images) {
    try {
      let data: Uint8Array | null;
      let mimeType = mime;
      if (typeof item === "string") {
        data = await fetchImageBytes(item);
        mimeType = mime || "image/png";
      } else {
        data = item;
      }
      if (data && data.length) refs.push(await uploadImage(data, mimeType || "image/png", env));
    } catch {
      // skip failed image
    }
  }
  return refs.length ? refs : null;
}
