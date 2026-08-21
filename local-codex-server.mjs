import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Codex } from "@openai/codex-sdk";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CODEX_BRIDGE_PORT || 3210);
const MAX_BODY_BYTES = 28 * 1024 * 1024;
const cacheRoot = path.resolve(process.cwd(), "work", "codex-frame-cache");
const codex = new Codex();

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { time: { type: "string" }, observation: { type: "string" } },
        required: ["time", "observation"],
      },
    },
    prompt: { type: "string" },
    negativePrompt: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "timeline", "prompt", "negativePrompt", "notes"],
};

const h3Rules = `Follow MiniMax H3 official Prompting Guidance. H3 outputs 4–15 second audio-video. For extracted reference-video frames, use full-reference mode by default. The final H3 prompt is written in English, except original dialogue inside <d>[Language] ...</d> and visible on-screen text. Use stable <Subject N>, <Video N>, and speaker (S1) labels. Organize the final prompt as exactly: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Describe shots in playback order; [Shot 1] has no timestamp and later cuts use [Shot N] At MM:SS.mmm. Write camera motion naturally with motion type, amplitude, and speed when meaningful. Keep identity, clothing, props, colors, lighting, and spatial relationships consistent. overall_soundscape covers ambience, physical sounds, and non-verbal sounds without repeating dialogue. non_diegetic_music covers instrumentation, tempo, rhythm, and dynamics, or N/A. Produce one directly pasteable positive natural-language H3 prompt, not JSON inside the prompt. negativePrompt should be empty unless custom rules explicitly require it.`;

function valueText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const preferred = value.text ?? value.content ?? value.observation ?? value.note ?? value.description;
    if (preferred !== undefined) return valueText(preferred);
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return "";
}

function normalizeAnalysis(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("模型返回结果不是有效的分析对象。");
  const timelineSource = Array.isArray(result.timeline)
    ? result.timeline
    : result.timeline && typeof result.timeline === "object"
      ? Object.entries(result.timeline).map(([time, observation]) => ({ time, observation }))
      : result.timeline ? [result.timeline] : [];
  const timeline = timelineSource.map((item, index) => {
    if (typeof item === "string") return { time: `镜头 ${index + 1}`, observation: item };
    return {
      time: valueText(item?.time ?? item?.timestamp ?? item?.start ?? `镜头 ${index + 1}`),
      observation: valueText(item?.observation ?? item?.description ?? item?.content ?? item),
    };
  }).filter((item) => item.observation);
  const notesSource = Array.isArray(result.notes) ? result.notes : result.notes == null || result.notes === "" ? [] : [result.notes];
  const notes = notesSource.map(valueText).filter(Boolean);
  const prompt = valueText(result.prompt ?? result.positivePrompt ?? result.positive_prompt ?? result.finalPrompt ?? result.final_prompt);
  if (!prompt) throw new Error("模型返回结果中缺少最终提示词，请重试或更换模型。");
  return {
    summary: valueText(result.summary ?? result.overview ?? result.description) || "提示词已生成。",
    timeline,
    prompt,
    negativePrompt: valueText(result.negativePrompt ?? result.negative_prompt),
    notes,
  };
}

function allowedOrigin(origin) {
  if (!origin) return "http://localhost";
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : "";
}

function sendJson(response, status, data, origin = "") {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求过大，请减少分析帧数。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function imageBytes(dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("检测到无效的视频画面数据。");
  return { extension: match[1] === "jpg" ? "jpeg" : match[1], bytes: Buffer.from(match[2], "base64") };
}

async function analyze(body) {
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, 24) : [];
  const mode = ["video", "text", "image", "first_last"].includes(body.mode) ? body.mode : "video";
  if (!body.requirement?.trim()) throw new Error("请先填写明确的生成要求。");
  if (mode === "video" && frames.length < 2) throw new Error("视频拆解模式至少需要两个视频画面。");

  await mkdir(cacheRoot, { recursive: true });
  const sessionDirectory = path.join(cacheRoot, crypto.randomUUID());
  await mkdir(sessionDirectory, { recursive: true });

  try {
    const imageInputs = [];
    const frameIndex = [];
    for (let index = 0; index < frames.length; index += 1) {
      const image = imageBytes(frames[index].dataUrl);
      const filePath = path.join(sessionDirectory, `frame-${String(index + 1).padStart(2, "0")}.${image.extension}`);
      await writeFile(filePath, image.bytes);
      imageInputs.push({ type: "local_image", path: filePath });
      frameIndex.push(`Frame ${index + 1}: ${formatTime(Number(frames[index].time || 0))}`);
    }

    let referenceInstruction = "";
    const referenceImages = Array.isArray(body.referenceImages)
      ? body.referenceImages.slice(0, 9)
      : body.referenceImage?.dataUrl ? [body.referenceImage] : [];
    if (mode === "image" && referenceImages.length < 1) throw new Error("图生视频模式至少需要一张参考图。");
    if (mode === "first_last" && referenceImages.length !== 2) throw new Error("首尾帧模式必须提供两张图片。");
    for (let index = 0; index < referenceImages.length; index += 1) {
      const reference = imageBytes(referenceImages[index].dataUrl);
      const referencePath = path.join(sessionDirectory, `reference-picture-${index + 1}.${reference.extension}`);
      await writeFile(referencePath, reference.bytes);
      imageInputs.push({ type: "local_image", path: referencePath });
    }
    if (mode === "video" && referenceImages.length) {
      referenceInstruction = `
视频抽帧之后的最后 ${referenceImages.length} 张随附图片不是视频帧，而是用户提供的角色参考图，按顺序标记为 <Picture 1> 到 <Picture ${referenceImages.length}>。先判断这些图片是同一人物的不同角度，还是多个不同人物：同一人物的多角度图片应合并定义为一个稳定的 <Subject 1>；不同人物则按用户要求分别定义为 <Subject N>。生成目标是用参考图人物的可见身份特征（脸部、五官、发型、年龄感、体型及要求保留的服装特征）替换参考视频中的对应人物，同时保留 <Video 1> 的表演动作、姿态变化、镜头运动、构图、场景、道具、光线、节奏和时间结构。不要混合不同人物的面部特征。除非用户另有要求，原视频人物只提供动作和时序，不提供最终身份外观。`;
    } else if (mode === "image") {
      referenceInstruction = `
随附的 ${referenceImages.length} 张图片是图生视频素材，按顺序标记为 <Picture 1> 到 <Picture ${referenceImages.length}>。从图片中准确提取主体身份、服装、场景、构图、光线和材质，并在保持视觉一致性的前提下，根据用户要求设计可拍摄的动作发展、镜头运动、环境动态、声音和时间节奏。多张图可能是同一主体的不同角度，也可能是多个主体，先判断再定义稳定的 <Subject N>。不要凭空改变图片中的核心身份特征。`;
    } else if (mode === "first_last") {
      referenceInstruction = `
随附两张图片分别是 <First Frame> 起始帧和 <Last Frame> 结束帧。提示词必须明确从第一张画面的主体姿态、构图、机位、光线和环境状态开始，经过连贯、物理合理且可执行的中间动作与运镜，自然到达第二张画面的最终状态。保持人物身份、服装、道具和空间关系连续；解释必要的位移、转身、表情、镜头轨迹和环境变化，但不要加入无法从两帧与用户要求支持的突兀事件。`;
    }

    const modeInstruction = mode === "video"
      ? `这是“视频拆解”任务。分析同一视频的抽帧，图片顺序与下列时间点一一对应：\n${frameIndex.join("\n")}`
      : mode === "text"
        ? "这是“文生视频”任务。用户没有提供视频或图片；请从文字需求原创完整的镜头设计、动作、场景、声音和节奏。"
        : mode === "image"
          ? "这是“图生视频”任务。以随附参考图作为视觉起点和主体约束，创作动态视频提示词。"
          : "这是“首尾帧生成”任务。以两张随附图片作为视频的精确起始状态与结束状态，设计中间连续过程。";

    const customRules = typeof body.customRules === "string" ? body.customRules.trim().slice(0, 60000) : "";
    const prompt = `你是资深视频导演、分镜师和 MiniMax H3 提示词工程师。
${modeInstruction}

用户要求：${body.requirement}
${mode === "video" ? `文件名：${body.fileName || "未命名视频"}\n参考视频时长：${Number(body.duration || 0).toFixed(1)} 秒` : "请从用户要求中的目标时长设计时间结构；未指定时默认设计约 10 秒。"}
${referenceInstruction}

默认规则：
${h3Rules}
${customRules ? `\n用户上传规则（格式和创意选择冲突时优先）：\n${customRules}` : ""}

请重点处理主体一致性、动作变化、场景、构图、景别、机位、镜头运动、光线、色彩、材质、情绪、转场、声音线索与节奏。视频拆解时不要声称看到了抽帧之间未提供的信息；不确定时在中文分析中写“推测”。没有原视频的创作模式中，timeline 应输出设计好的分镜时间线，而不是声称逐帧观察。summary、timeline、notes 使用中文；prompt 输出完整英文 H3 提示词；negativePrompt 默认空字符串。只返回符合指定 schema 的 JSON。不要修改文件，不要调用外部工具。`;

    if (body.provider && body.provider !== "codex") {
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      const baseUrl = typeof body.apiBaseUrl === "string" ? body.apiBaseUrl.trim() : "";
      const protocol = ["responses", "chat", "anthropic", "gemini"].includes(body.apiProtocol) ? body.apiProtocol : "chat";
      if (!apiKey) throw new Error("缺少 API Key。");
      if (!model) throw new Error("缺少模型名称。");
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 地址必须以 http:// 或 https:// 开头。");
      return normalizeAnalysis(await analyzeWithExternalApi({ provider: body.provider, apiKey, model, baseUrl, protocol, prompt, frames, referenceImages }));
    }

    const threadOptions = {
      workingDirectory: process.cwd(),
      sandboxMode: "read-only",
      approvalPolicy: "never",
      modelReasoningEffort: "medium",
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    };
    const thread = codex.startThread(threadOptions);
    const turn = await thread.run([{ type: "text", text: prompt }, ...imageInputs], { outputSchema });
    return normalizeAnalysis(JSON.parse(turn.finalResponse));
  } finally {
    await rm(sessionDirectory, { recursive: true, force: true });
  }
}

function endpoint(baseUrl, suffix, provider = "") {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.toLowerCase().endsWith(suffix.toLowerCase())) return clean;
  if (provider === "custom") {
    try {
      const parsed = new URL(clean);
      if (!parsed.pathname || parsed.pathname === "/") return `${clean}/v1${suffix}`;
    } catch {}
  }
  return `${clean}${suffix}`;
}

function geminiEndpoint(baseUrl, model, provider = "") {
  let cleanBase = baseUrl.replace(/\/+$/, "");
  if (cleanBase.includes(":generateContent")) return cleanBase;
  if (provider === "custom") {
    try {
      const parsed = new URL(cleanBase);
      if (!parsed.pathname || parsed.pathname === "/") cleanBase = `${cleanBase}/v1beta`;
    } catch {}
  }
  return `${cleanBase}/models/${encodeURIComponent(model)}:generateContent`;
}

function dataUrlImage(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("检测到无效的图片数据。");
  return { mediaType: match[1], data: match[2] };
}

function parseModelJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("API 没有返回可解析结果。");
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("模型返回的不是有效 JSON，请换用更强的模型重试。");
  }
}

async function fetchJson(url, options, providerName, timeoutMs = 240000) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error(`${providerName} 请求超时，请减少抽帧数量后重试。`);
    throw new Error(`${providerName} 无法连接：${error instanceof Error ? error.message : "网络错误"}`);
  }
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch { result = { raw }; }
  if (!response.ok) {
    const detail = result?.error?.message || result?.message || result?.base_resp?.status_msg || raw.slice(0, 500);
    throw new Error(`${providerName} API 调用失败（${response.status}）：${detail || "未知错误"}`);
  }
  return result;
}

function openAiImageContent(prompt, frames, referenceImages) {
  const content = [{ type: "input_text", text: prompt }];
  for (let index = 0; index < frames.length; index += 1) {
    content.push({ type: "input_text", text: `Video frame ${index + 1} at ${formatTime(Number(frames[index].time || 0))}` });
    content.push({ type: "input_image", image_url: frames[index].dataUrl, detail: "low" });
  }
  for (let index = 0; index < referenceImages.length; index += 1) {
    content.push({ type: "input_text", text: `User reference <Picture ${index + 1}>` });
    content.push({ type: "input_image", image_url: referenceImages[index].dataUrl, detail: "high" });
  }
  return content;
}

async function analyzeWithResponses({ provider, apiKey, model, baseUrl, prompt, frames, referenceImages }) {
  const result = await fetchJson(endpoint(baseUrl, "/responses", provider), {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: openAiImageContent(prompt, frames, referenceImages) }],
      reasoning: { effort: "medium" },
      text: { verbosity: "medium", format: { type: "json_schema", name: "video_prompt_analysis", strict: true, schema: outputSchema } },
      max_output_tokens: 4000,
    }),
  }, "Responses");
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  return parseModelJson(outputText);
}

async function analyzeWithChat({ provider, apiKey, model, baseUrl, prompt, frames, referenceImages }) {
  const content = [{ type: "text", text: prompt }];
  for (let index = 0; index < frames.length; index += 1) {
    content.push({ type: "text", text: `Video frame ${index + 1} at ${formatTime(Number(frames[index].time || 0))}` });
    content.push({ type: "image_url", image_url: { url: frames[index].dataUrl, detail: "low" } });
  }
  for (let index = 0; index < referenceImages.length; index += 1) {
    content.push({ type: "text", text: `User reference <Picture ${index + 1}>` });
    content.push({ type: "image_url", image_url: { url: referenceImages[index].dataUrl, detail: "high" } });
  }
  const result = await fetchJson(endpoint(baseUrl, "/chat/completions", provider), {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost:3010", "X-Title": "FramePrompt" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false, max_tokens: 4000 }),
  }, "Chat Completions");
  const responseContent = result?.choices?.[0]?.message?.content;
  const text = typeof responseContent === "string" ? responseContent : Array.isArray(responseContent) ? responseContent.map((item) => item?.text || item?.content || "").join("") : "";
  return parseModelJson(text);
}

async function analyzeWithAnthropic({ provider, apiKey, model, baseUrl, prompt, frames, referenceImages }) {
  const content = [{ type: "text", text: prompt }];
  for (let index = 0; index < frames.length; index += 1) {
    const image = dataUrlImage(frames[index].dataUrl);
    content.push({ type: "text", text: `Video frame ${index + 1} at ${formatTime(Number(frames[index].time || 0))}` });
    content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  }
  for (let index = 0; index < referenceImages.length; index += 1) {
    const image = dataUrlImage(referenceImages[index].dataUrl);
    content.push({ type: "text", text: `User reference <Picture ${index + 1}>` });
    content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  }
  const result = await fetchJson(endpoint(baseUrl, "/messages", provider), {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content }] }),
  }, "Claude");
  return parseModelJson((result.content || []).filter((item) => item.type === "text").map((item) => item.text).join(""));
}

async function analyzeWithGemini({ provider, apiKey, model, baseUrl, prompt, frames, referenceImages }) {
  const parts = [{ text: prompt }];
  for (let index = 0; index < frames.length; index += 1) {
    const image = dataUrlImage(frames[index].dataUrl);
    parts.push({ text: `Video frame ${index + 1} at ${formatTime(Number(frames[index].time || 0))}` });
    parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } });
  }
  for (let index = 0; index < referenceImages.length; index += 1) {
    const image = dataUrlImage(referenceImages[index].dataUrl);
    parts.push({ text: `User reference <Picture ${index + 1}>` });
    parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } });
  }
  const url = geminiEndpoint(baseUrl, model, provider);
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 4000, responseMimeType: "application/json" } }),
  }, "Gemini");
  const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  return parseModelJson(text);
}

async function analyzeWithExternalApi(options) {
  if (options.protocol === "responses") return analyzeWithResponses(options);
  if (options.protocol === "anthropic") return analyzeWithAnthropic(options);
  if (options.protocol === "gemini") return analyzeWithGemini(options);
  return analyzeWithChat(options);
}

async function validateExternalApi(body) {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const baseUrl = typeof body.apiBaseUrl === "string" ? body.apiBaseUrl.trim() : "";
  const protocol = ["responses", "chat", "anthropic", "gemini"].includes(body.apiProtocol) ? body.apiProtocol : "chat";
  const provider = typeof body.provider === "string" ? body.provider : "custom";
  if (!apiKey) throw new Error("缺少 API Key。");
  if (!model) throw new Error("缺少模型名称。");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 地址必须以 http:// 或 https:// 开头。");

  const testPrompt = "Reply with only OK.";
  if (protocol === "responses") {
    const requestUrl = endpoint(baseUrl, "/responses", provider);
    const result = await fetchJson(requestUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: testPrompt, max_output_tokens: 16 }),
    }, "Responses", 30000);
    if (!result.output_text && !result.output) throw new Error(`接口已连接，但返回内容不是 Responses API 格式。当前请求地址：${requestUrl}`);
  } else if (protocol === "anthropic") {
    const requestUrl = endpoint(baseUrl, "/messages", provider);
    const result = await fetchJson(requestUrl, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: testPrompt }] }),
    }, "Claude", 30000);
    if (!Array.isArray(result.content)) throw new Error(`接口已连接，但返回内容不是 Anthropic Messages 格式。当前请求地址：${requestUrl}`);
  } else if (protocol === "gemini") {
    const url = geminiEndpoint(baseUrl, model, provider);
    const result = await fetchJson(url, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: testPrompt }] }], generationConfig: { maxOutputTokens: 16 } }),
    }, "Gemini", 30000);
    if (!Array.isArray(result.candidates)) throw new Error(`接口已连接，但返回内容不是 Gemini 格式。当前请求地址：${url}`);
  } else {
    const requestUrl = endpoint(baseUrl, "/chat/completions", provider);
    const result = await fetchJson(requestUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost:3010", "X-Title": "FramePrompt" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: testPrompt }], stream: false, max_tokens: 16 }),
    }, "Chat Completions", 30000);
    const messageContent = result?.choices?.[0]?.message?.content;
    if (!Array.isArray(result.choices) || !result.choices.length || (typeof messageContent !== "string" && !Array.isArray(messageContent))) {
      throw new Error(`接口已连接，但返回内容不是 Chat Completions 格式。当前请求地址：${requestUrl}。请确认地址和模型 ID；自定义根地址会自动补 /v1/chat/completions。`);
    }
  }
  return { ok: true, model, protocol };
}

async function listExternalModels(body) {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const baseUrl = typeof body.apiBaseUrl === "string" ? body.apiBaseUrl.trim() : "";
  const protocol = ["responses", "chat", "anthropic", "gemini"].includes(body.apiProtocol) ? body.apiProtocol : "chat";
  const provider = typeof body.provider === "string" ? body.provider : "custom";
  if (!apiKey) throw new Error("缺少 API Key。");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 地址必须以 http:// 或 https:// 开头。");

  let result;
  let requestUrl;
  if (protocol === "gemini") {
    let cleanBase = baseUrl.replace(/\/+$/, "");
    if (provider === "custom") {
      try {
        const parsed = new URL(cleanBase);
        if (!parsed.pathname || parsed.pathname === "/") cleanBase = `${cleanBase}/v1beta`;
      } catch {}
    }
    requestUrl = cleanBase.toLowerCase().endsWith("/models") ? cleanBase : `${cleanBase}/models`;
    result = await fetchJson(requestUrl, { method: "GET", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" } }, "Gemini 模型列表", 30000);
  } else if (protocol === "anthropic") {
    requestUrl = endpoint(baseUrl, "/models", provider);
    result = await fetchJson(requestUrl, { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }, "Claude 模型列表", 30000);
  } else {
    requestUrl = endpoint(baseUrl, "/models", provider);
    result = await fetchJson(requestUrl, { method: "GET", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" } }, "模型列表", 30000);
  }

  const source = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
  const models = [...new Set(source.map((item) => {
    const value = typeof item === "string" ? item : item?.id || item?.name || "";
    return typeof value === "string" ? value.replace(/^models\//, "") : "";
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 500);
  if (!models.length) throw new Error(`服务已连接，但 ${requestUrl} 没有返回标准模型列表。该服务可能不支持读取模型，请向服务商索取准确的模型 ID。`);
  return { ok: true, models, endpoint: requestUrl };
}

const server = createServer(async (request, response) => {
  const origin = allowedOrigin(request.headers.origin);
  if (request.headers.origin && !origin) return sendJson(response, 403, { error: "只允许本地 FramePrompt 页面访问 Codex。" }, "null");
  if (request.method === "OPTIONS") return sendJson(response, 204, {}, origin);
  if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true, provider: "codex" }, origin);
  if (request.method !== "POST" || !["/analyze", "/validate-api", "/list-models"].includes(request.url)) return sendJson(response, 404, { error: "Not found" }, origin);

  try {
    const body = await readJson(request);
    const result = request.url === "/validate-api" ? await validateExternalApi(body) : request.url === "/list-models" ? await listExternalModels(body) : await analyze(body);
    sendJson(response, 200, result, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex 分析失败";
    const authHint = /codex.*(login|auth|credential)|(login|auth|credential).*codex/i.test(message) ? " 请先打开 Codex 并完成登录。" : "";
    sendJson(response, 500, { error: `${message}${authHint}` }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FramePrompt Codex bridge: http://${HOST}:${PORT}`);
});

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
