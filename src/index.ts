// gemini-relay-worker — full port of gemini-web2api's server.py.
//
// Routes three API surfaces, all converging on gemini.ts generate/generateStream:
//   GET  /, /v1/models                              status + OpenAI model list
//   POST /v1/chat/completions                       OpenAI Chat Completions (+ stream, tools)
//   POST /v1/responses                              OpenAI Responses API (Codex CLI)
//   GET  /v1beta/models                             Google native model list
//   POST /v1beta/models/{m}:generateContent         Google native (+ stream, tools, images)
//        /v1beta/models/{m}:streamGenerateContent

import { MODELS, resolveModel } from "./models";
import { generate, generateStream, type Env } from "./gemini";
import {
  messagesToPrompt,
  parseToolCalls,
  googleContentsToPrompt,
  parseGoogleFunctionCalls,
  type ImageItem,
} from "./tools";
import { uploadImages } from "./multimodal";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const now = () => Math.floor(Date.now() / 1000);
const approxTokens = (s: string) => Math.floor((s || "").length / 4);
const newId = (prefix: string, len: number) =>
  `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, len)}`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Wrap an async generator of pre-framed SSE strings into a streaming Response. */
function sse(frames: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of frames) controller.enqueue(encoder.encode(frame));
      } catch {
        // client disconnect / upstream abort — close quietly
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS_HEADERS },
  });
}

function authorized(req: Request, env: Env): boolean {
  const keys = (env.API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return true;
  const auth = req.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-api-key") || "";
  return keys.includes(key);
}

async function parseJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ─── /v1/chat/completions ────────────────────────────────────────────────────

async function handleChat(req: Request, env: Env): Promise<Response> {
  const body = await parseJson(req);
  if (body === null) return json({ error: { message: "invalid JSON" } }, 400);

  const { name, modeId, thinkMode, extra, error } = resolveModel(body.model || env.DEFAULT_MODEL || "gemini-3.5-flash");
  if (error) return json({ error: { message: error } }, 400);

  const tools = body.tools;
  const toolChoice = body.tool_choice ?? "auto";
  const { prompt } = messagesToPrompt(body.messages || [], tools, toolChoice);
  if (!prompt.trim()) return json({ error: { message: "empty prompt" } }, 400);

  const stream = body.stream === true;
  const cid = newId("chatcmpl-", 12);

  if (stream && (!tools || toolChoice === "none")) {
    return sse(
      (async function* () {
        for await (const delta of generateStream(prompt, modeId, thinkMode, null, extra, env)) {
          const chunk = {
            id: cid,
            object: "chat.completion.chunk",
            created: now(),
            model: name,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          };
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
        const end = {
          id: cid,
          object: "chat.completion.chunk",
          created: now(),
          model: name,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        yield `data: ${JSON.stringify(end)}\n\n`;
        yield "data: [DONE]\n\n";
      })(),
    );
  }

  let text: string;
  try {
    text = await generate(prompt, modeId, thinkMode, null, extra, env);
  } catch (e) {
    return json({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const parsed = parseToolCalls(text);
    text = parsed.clean;
    if (parsed.toolCalls.length) toolCalls = parsed.toolCalls;
  }
  const msg: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  const finish = toolCalls ? "tool_calls" : "stop";

  if (stream) {
    return sse(
      (async function* () {
        const chunk = {
          id: cid,
          object: "chat.completion.chunk",
          created: now(),
          model: name,
          choices: [{ index: 0, delta: msg, finish_reason: finish }],
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
        yield "data: [DONE]\n\n";
      })(),
    );
  }

  return json({
    id: cid,
    object: "chat.completion",
    created: now(),
    model: name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: approxTokens(prompt),
      completion_tokens: approxTokens(text),
      total_tokens: approxTokens(prompt) + approxTokens(text),
    },
  });
}

// ─── /v1/responses (Codex CLI) ───────────────────────────────────────────────

async function handleResponses(req: Request, env: Env): Promise<Response> {
  const body = await parseJson(req);
  if (body === null) return json({ error: { message: "invalid JSON" } }, 400);

  const { name, modeId, thinkMode, extra, error } = resolveModel(body.model || env.DEFAULT_MODEL || "gemini-3.5-flash");
  if (error) return json({ error: { message: error } }, 400);

  const inputItems = body.input ?? [];
  let tools = body.tools;
  const messages: any[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        if (item.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        } else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          const cp = item.content ?? [];
          let textAcc = "";
          const tcList: any[] = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c && typeof c === "object") {
                if (c.type === "output_text") textAcc += c.text || "";
                else if (c.type === "function_call") tcList.push(c);
              }
            }
          } else if (typeof cp === "string") {
            textAcc = cp;
          }
          const m: Record<string, unknown> = { role: "assistant", content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`,
              type: "function",
              function: { name: tc.name || "", arguments: tc.arguments || "{}" },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || "user";
          let content = item.content || "";
          if (Array.isArray(content)) {
            content = content
              .filter((c: any) => c.type === "text" || c.type === "input_text")
              .map((c: any) => c.text || "")
              .join(" ");
          }
          messages.push({ role, content });
        }
      }
    }
  }

  if (tools) {
    tools = tools.map((t: any) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t,
    );
  }

  const toolChoice = body.tool_choice ?? "auto";
  const { prompt } = messagesToPrompt(messages, tools, toolChoice);
  if (!prompt.trim()) return json({ error: { message: "empty input" } }, 400);

  let text: string;
  try {
    text = await generate(prompt, modeId, thinkMode, null, extra, env);
  } catch (e) {
    return json({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls: any[] | null = null;
  if (tools && text && toolChoice !== "none") {
    const parsed = parseToolCalls(text);
    text = parsed.clean;
    if (parsed.toolCalls.length) toolCalls = parsed.toolCalls;
  }

  const rid = newId("resp_", 16);
  const mid = newId("msg_", 12);
  const output: any[] = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }
  if (text || !toolCalls) {
    output.push({
      type: "message",
      id: mid,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }

  const usage = {
    input_tokens: approxTokens(prompt),
    output_tokens: approxTokens(text),
    total_tokens: approxTokens(prompt) + approxTokens(text),
  };

  if (body.stream) {
    return sse(
      (async function* () {
        const created = { type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: name, output: [] } };
        yield `event: response.created\ndata: ${JSON.stringify(created)}\n\n`;
        for (const item of output) {
          if (item.type === "function_call") {
            const ev = { type: "response.function_call_arguments.done", item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments };
            yield `event: response.function_call_arguments.done\ndata: ${JSON.stringify(ev)}\n\n`;
          } else if (item.type === "message") {
            for (let ci = 0; ci < item.content.length; ci++) {
              const ev = { type: "response.output_text.done", item_id: item.id, content_index: ci, text: item.content[ci].text };
              yield `event: response.output_text.done\ndata: ${JSON.stringify(ev)}\n\n`;
            }
          }
        }
        const respObj = { id: rid, object: "response", status: "completed", model: name, output, usage };
        yield `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: respObj })}\n\n`;
      })(),
    );
  }

  return json({ id: rid, object: "response", created_at: now(), status: "completed", model: name, output, usage });
}

// ─── /v1beta/models (Google Gemini CLI) ───────────────────────────────────────

async function handleGoogleGenerate(req: Request, env: Env, path: string, stream: boolean): Promise<Response> {
  const body = await parseJson(req);
  if (body === null) return json({ error: { message: "invalid JSON" } }, 400);

  const m = path.match(/\/v1beta\/models\/([^:?]+)/);
  const requested = m ? m[1] : env.DEFAULT_MODEL || "gemini-3.5-flash";
  const { name, modeId, thinkMode, extra, error } = resolveModel(requested);
  if (error) return json({ error: { message: error } }, 400);

  const fcMode = body.toolConfig?.functionCallingConfig?.mode || "AUTO";
  const hasTools = Boolean(body.tools) && fcMode !== "NONE";
  const { prompt, images } = googleContentsToPrompt(body);
  if (!prompt.trim()) return json({ error: { message: "empty content" } }, 400);

  let fileRefs: string[] | null = null;
  try {
    fileRefs = await uploadImages(images as ImageItem[], env);
  } catch {
    fileRefs = null;
  }

  if (stream && !hasTools) {
    return sse(
      (async function* () {
        let full = "";
        for await (const delta of generateStream(prompt, modeId, thinkMode, fileRefs, extra, env)) {
          if (!delta) continue;
          full += delta;
          const chunk = { candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: name };
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
        const finalChunk = {
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: approxTokens(prompt), candidatesTokenCount: approxTokens(full), totalTokenCount: approxTokens(prompt) + approxTokens(full) },
          modelVersion: name,
        };
        yield `data: ${JSON.stringify(finalChunk)}\n\n`;
      })(),
    );
  }

  let text: string;
  try {
    text = await generate(prompt, modeId, thinkMode, fileRefs, extra, env);
  } catch (e) {
    return json({ error: { message: `upstream error: ${e}` } }, 502);
  }

  const responseParts: any[] = [];
  if (hasTools && text) {
    const { clean, functionCalls } = parseGoogleFunctionCalls(text);
    if (functionCalls.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of functionCalls) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }

  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: approxTokens(prompt), candidatesTokenCount: approxTokens(text), totalTokenCount: approxTokens(prompt) + approxTokens(text) },
    modelVersion: name,
  };

  if (stream) {
    return sse(
      (async function* () {
        yield `data: ${JSON.stringify(responseObj)}\n\n`;
      })(),
    );
  }
  return json(responseObj);
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (req.method === "GET") {
      if (path.startsWith("/v1/") && !authorized(req, env)) return json({ error: { message: "invalid api key" } }, 401);
      if (path === "/v1/models") {
        return json({
          object: "list",
          data: Object.entries(MODELS).map(([n, c]) => ({ id: n, object: "model", created: 1700000000, owned_by: "google", description: c.desc })),
        });
      }
      if (path.startsWith("/v1beta/models")) {
        return json({
          models: Object.entries(MODELS).map(([n, c]) => ({
            name: `models/${n}`,
            displayName: n,
            description: c.desc,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
          })),
        });
      }
      if (path === "/") return json({ status: "ok", version: "0.2.0", models: Object.keys(MODELS) });
      return json({ error: "not found" }, 404);
    }

    if (req.method === "POST") {
      if (path.startsWith("/v1/") && !authorized(req, env)) return json({ error: { message: "invalid api key" } }, 401);
      try {
        if (path === "/v1/chat/completions") return await handleChat(req, env);
        if (path === "/v1/responses") return await handleResponses(req, env);
        if (path.includes(":generateContent")) return await handleGoogleGenerate(req, env, path, false);
        if (path.includes(":streamGenerateContent")) return await handleGoogleGenerate(req, env, path, true);
      } catch (e) {
        return json({ error: { message: String(e) } }, 500);
      }
      return json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
