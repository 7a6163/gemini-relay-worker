// Tool calling + message parsing, ported from gemini-web2api's tools.py.
// Function calling is prompt-engineered, not native: tool defs are injected as
// a prompt preamble, and the model's ```tool_call``` / ```function_call```
// blocks are parsed back into structured calls.

/** Image as [bytes-or-URL, mimeType]. URLs are fetched at upload time. */
export type ImageItem = [Uint8Array | string, string];

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ToolChoice = "none" | "auto" | "required" | { type?: string; function?: { name?: string } } | undefined;

function newCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ─── OpenAI side ───────────────────────────────────────────────────────────

function toolChoiceInstruction(toolChoice: ToolChoice): string {
  if (toolChoice === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (toolChoice === "required")
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  if (typeof toolChoice === "object" && toolChoice) {
    const fnName = toolChoice.function?.name;
    if (fnName) return `\n\nIMPORTANT: You MUST call the tool "${fnName}". Do not call other tools.`;
  }
  return "";
}

interface OpenAITool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
  name?: string;
  description?: string;
  parameters?: unknown;
}

interface ChatMessage {
  role?: string;
  name?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

/** Convert OpenAI messages → { prompt, images }. */
export function messagesToPrompt(
  messages: ChatMessage[],
  tools?: OpenAITool[],
  toolChoice?: ToolChoice,
): { prompt: string; images: ImageItem[] } {
  const parts: string[] = [];
  const images: ImageItem[] = [];

  if (tools && tools.length && toolChoice !== "none") {
    const toolDefs: ToolDef[] = tools.map((tool) => {
      const fn = tool.type === "function" && tool.function ? tool.function : tool;
      return {
        name: fn.name ?? tool.name ?? "",
        description: fn.description ?? tool.description ?? "",
        parameters: fn.parameters ?? tool.parameters ?? {},
      };
    });
    if (toolDefs.length) {
      parts.push(
        "# Tool Use\n\n" +
          "You can call the following tools. Call format:\n" +
          '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
          "When calling tools, output ONLY the tool_call block(s).\n\n" +
          `Available tools:\n${JSON.stringify(toolDefs, null, 2)}` +
          toolChoiceInstruction(toolChoice),
      );
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    let content: string;
    if (Array.isArray(msg.content)) {
      content = msg.content
        .map((c) => {
          if (c?.type === "text" || c?.type === "input_text") return c.text || "";
          if (c?.type === "image_url" || c?.type === "image")
            return "[Note: Image input not supported in this API. Please describe the image in text.]";
          return "";
        })
        .join(" ");
    } else {
      content = msg.content ?? "";
    }

    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      if (msg.tool_calls?.length) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return `\`\`\`tool_call\n{"name": "${fn.name}", "arguments": ${fn.arguments || "{}"}}\n\`\`\``;
        });
        parts.push(`[Assistant]: ${content || ""}\n${tcStrs.join("\n")}`);
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name || ""}]: ${content}`);
    } else if (content) {
      parts.push(content);
    }
  }

  return { prompt: parts.filter((p) => p).join("\n\n"), images };
}

/** Extract ```tool_call``` blocks → (cleanText, toolCalls). */
export function parseToolCalls(text: string): { clean: string; toolCalls: OpenAIToolCall[] } {
  const toolCalls: OpenAIToolCall[] = [];
  const pattern = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts: string[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    try {
      const data = JSON.parse(m[1].trim());
      toolCalls.push({
        id: newCallId(),
        type: "function",
        function: { name: data.name, arguments: JSON.stringify(data.arguments ?? {}) },
      });
    } catch {
      // ignore malformed block
    }
  }
  cleanParts.push(text.slice(lastEnd));
  return { clean: cleanParts.join("").trim(), toolCalls };
}

// ─── Google native side ──────────────────────────────────────────────────────

export function buildToolPrompt(toolDefs: ToolDef[]): string {
  const toolSpec = JSON.stringify(toolDefs, null, 2);
  return (
    "# Tool Use\n\n" +
    "You can call the following tools to help accomplish tasks. " +
    "These tools connect to the user's local environment and will execute when called.\n\n" +
    "Call format (use this exact format):\n" +
    "```function_call\n" +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    "```\n\n" +
    "When calling tools:\n" +
    "- Output ONLY the function_call block(s), nothing else\n" +
    "- You may call multiple tools with multiple blocks\n" +
    "- After receiving a [Tool result for ...], use that data to answer the user\n\n" +
    `Available tools:\n${toolSpec}`
  );
}

interface GoogleRequest {
  contents?: Array<{ role?: string; parts?: GooglePart[] }>;
  tools?: Array<{ functionDeclarations?: Array<Record<string, unknown>> }>;
  toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
  systemInstruction?: { parts?: GooglePart[] };
}

interface GooglePart {
  text?: string;
  inlineData?: { mimeType?: string; data: string };
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

function googleToolChoiceInstruction(req: GoogleRequest): string {
  const fc = req.toolConfig?.functionCallingConfig || {};
  const mode = fc.mode || "AUTO";
  const allowed = fc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Convert Google API contents/tools/systemInstruction → { prompt, images }. */
export function googleContentsToPrompt(req: GoogleRequest): { prompt: string; images: ImageItem[] } {
  const parts: string[] = [];
  const images: ImageItem[] = [];

  const fcMode = req.toolConfig?.functionCallingConfig?.mode || "AUTO";
  const toolDefs: ToolDef[] = [];
  if (req.tools && fcMode !== "NONE") {
    for (const group of req.tools) {
      for (const fn of group.functionDeclarations || []) {
        const td: ToolDef = { name: (fn.name as string) || "", description: (fn.description as string) || "" };
        const params = fn.parameters ?? fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || [])
      .map((p) => p.text || "")
      .filter(Boolean)
      .join(" ");
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts: string[] = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        const mime = p.inlineData.mimeType || "image/png";
        images.push([b64ToBytes(p.inlineData.data), mime]);
      } else if (p.functionCall) {
        msgParts.push(
          `\`\`\`function_call\n${JSON.stringify({ name: p.functionCall.name, args: p.functionCall.args ?? {} })}\n\`\`\``,
        );
      } else if (p.functionResponse) {
        msgParts.push(
          `[Tool result for ${p.functionResponse.name || ""}]: ${JSON.stringify(p.functionResponse.response ?? {})}`,
        );
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }

  return { prompt: parts.filter((p) => p).join("\n\n"), images };
}

export interface GoogleFunctionCall {
  name: string;
  args: unknown;
}

/** Extract function_call blocks from model output (3 formats). */
export function parseGoogleFunctionCalls(text: string): { clean: string; functionCalls: GoogleFunctionCall[] } {
  const functionCalls: GoogleFunctionCall[] = [];
  const patterns = [/```function_call\s*\n([\s\S]*?)\n```/g, /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g];
  let clean = text;
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      try {
        const data = JSON.parse(match[1].trim());
        if ("name" in data) functionCalls.push({ name: data.name, args: data.args ?? data.arguments ?? {} });
      } catch {
        // ignore
      }
    }
    clean = clean.replace(pattern, "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if ("name" in data && ("args" in data || "arguments" in data)) {
        functionCalls.push({ name: data.name, args: data.args ?? data.arguments ?? {} });
        clean = "";
      }
    } catch {
      // ignore
    }
  }
  return { clean, functionCalls };
}
