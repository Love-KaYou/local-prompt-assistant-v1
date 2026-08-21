"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";

type Frame = { time: number; dataUrl: string };
type Analysis = { summary: string; timeline: Array<{ time: string; observation: string }>; prompt: string; negativePrompt: string; notes: string[] };
type ProviderId = "codex" | "openai" | "minimax" | "deepseek" | "anthropic" | "gemini" | "openrouter" | "siliconflow" | "custom";
type ApiProtocol = "responses" | "chat" | "anthropic" | "gemini";
type WorkMode = "video" | "text" | "image" | "first_last";

const WORK_MODES: Record<WorkMode, { name: string; short: string; guide: string }> = {
  video: { name: "视频拆解", short: "视频 → 提示词", guide: "上传视频逐帧分析镜头、动作、场景和节奏。" },
  text: { name: "文生视频", short: "文字 → 提示词", guide: "无需视频或图片，描述故事、画面和时长即可生成提示词。" },
  image: { name: "图生视频", short: "图片 → 提示词", guide: "上传 1–9 张参考图，设计人物动作、镜头运动和声音。" },
  first_last: { name: "首尾帧", short: "起始帧 → 结束帧", guide: "上传两张图片，第 1 张是起始帧，第 2 张是结束帧。" },
};

const PROVIDERS: Record<ProviderId, { name: string; short: string; baseUrl: string; model: string; protocol: ApiProtocol; note: string }> = {
  codex: { name: "本机 Codex", short: "默认 · 无需 API Key", baseUrl: "", model: "", protocol: "responses", note: "复用当前 Codex 登录状态，默认推荐。" },
  openai: { name: "OpenAI", short: "Responses API", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", protocol: "responses", note: "使用 Responses API，模型需支持图片输入。" },
  minimax: { name: "MiniMax", short: "兼容接口", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2.7", protocol: "chat", note: "MiniMax 文本模型可能不接收图片；如接口报错，请改用其视觉模型或其他视觉提供商。" },
  deepseek: { name: "DeepSeek", short: "官方 API", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", protocol: "chat", note: "DeepSeek 官方对话模型目前以文本输入为主，逐帧图片分析可能不受支持。" },
  anthropic: { name: "Claude", short: "Anthropic Messages", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5-20250929", protocol: "anthropic", note: "使用 Claude 原生 Messages API，支持多张图片。" },
  gemini: { name: "Gemini", short: "Google AI", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash", protocol: "gemini", note: "使用 Gemini generateContent，支持内嵌图片。" },
  openrouter: { name: "OpenRouter", short: "多模型聚合", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", protocol: "chat", note: "可填写任意支持 image 输入的 OpenRouter 模型 ID。" },
  siliconflow: { name: "硅基流动", short: "视觉模型", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2-VL-72B-Instruct", protocol: "chat", note: "请选择模型广场中带“视觉”标签的模型。" },
  custom: { name: "自定义 API", short: "自填地址与协议", baseUrl: "", model: "", protocol: "chat", note: "地址可填 API 根地址或完整接口地址；Key 和图片会发送到该服务。" },
};

const EXAMPLE_REQUIREMENT = "还原参考视频的镜头语言，生成可直接用于 MiniMax H3 的提示词，保留人物、运镜、光线、动作和声音节奏。";
const API_STORAGE_KEY = "frameprompt-api-profiles-v1";

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("读取画面超时")), 8000);
    const done = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done, { once: true });
    video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
  });
}

function normalizeAnalysisPayload(payload: Partial<Analysis> & Record<string, unknown>): Analysis {
  const timeline = Array.isArray(payload.timeline)
    ? payload.timeline.map((item, index) => typeof item === "string" ? { time: `镜头 ${index + 1}`, observation: item } : { time: String(item?.time || `镜头 ${index + 1}`), observation: String(item?.observation || "") }).filter((item) => item.observation)
    : [];
  const notes = Array.isArray(payload.notes) ? payload.notes.map(String).filter(Boolean) : typeof payload.notes === "string" && payload.notes.trim() ? [payload.notes] : [];
  return {
    summary: typeof payload.summary === "string" ? payload.summary : "提示词已生成。",
    timeline,
    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
    negativePrompt: typeof payload.negativePrompt === "string" ? payload.negativePrompt : "",
    notes,
  };
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rulesInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [workMode, setWorkMode] = useState<WorkMode>("video");
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(12);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [requirement, setRequirement] = useState(EXAMPLE_REQUIREMENT);
  const [customRules, setCustomRules] = useState("");
  const [rulesFileName, setRulesFileName] = useState("");
  const [referenceImages, setReferenceImages] = useState<Array<{ id: string; name: string; dataUrl: string }>>([]);
  const [dragTarget, setDragTarget] = useState<"video" | "reference" | null>(null);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [apiKey, setApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ApiProtocol>("responses");
  const [apiValidation, setApiValidation] = useState<{ status: "idle" | "checking" | "success" | "error"; message: string }>({ status: "idle", message: "" });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelListStatus, setModelListStatus] = useState<{ loading: boolean; message: string }>({ loading: false, message: "" });
  const [saveApiLocally, setSaveApiLocally] = useState(false);
  const [apiStorageReady, setApiStorageReady] = useState(false);
  const [status, setStatus] = useState<"idle" | "extracting" | "analyzing" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [eggPosition, setEggPosition] = useState({ left: 16, top: 96, ready: false });

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => {
    const savedTheme = window.localStorage.getItem("frameprompt-theme");
    const nextTheme = savedTheme === "dark" || savedTheme === "light" ? savedTheme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;

    const placeEgg = () => {
      const maxLeft = Math.max(16, window.innerWidth - 92);
      const maxTop = Math.max(96, window.innerHeight - 58);
      setEggPosition({ left: Math.round(16 + Math.random() * (maxLeft - 16)), top: Math.round(88 + Math.random() * (maxTop - 88)), ready: true });
    };
    placeEgg();
    window.addEventListener("resize", placeEgg);
    return () => window.removeEventListener("resize", placeEgg);
  }, []);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(API_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const savedProvider = saved?.lastProvider as ProviderId;
        const profile = saved?.profiles?.[savedProvider];
        if (saved?.enabled && savedProvider && savedProvider in PROVIDERS && savedProvider !== "codex" && profile) {
          setSaveApiLocally(true);
          setProvider(savedProvider);
          setApiBaseUrl(typeof profile.baseUrl === "string" ? profile.baseUrl : PROVIDERS[savedProvider].baseUrl);
          setModel(typeof profile.model === "string" ? profile.model : PROVIDERS[savedProvider].model);
          setApiProtocol(["responses", "chat", "anthropic", "gemini"].includes(profile.protocol) ? profile.protocol : PROVIDERS[savedProvider].protocol);
          setApiKey(typeof profile.apiKey === "string" ? profile.apiKey : "");
        }
      }
    } catch {
      window.localStorage.removeItem(API_STORAGE_KEY);
    } finally {
      setApiStorageReady(true);
    }
  }, []);
  useEffect(() => {
    if (!apiStorageReady) return;
    if (!saveApiLocally) {
      window.localStorage.removeItem(API_STORAGE_KEY);
      return;
    }
    if (provider === "codex") return;
    let saved: { enabled: boolean; lastProvider: ProviderId; profiles: Record<string, { baseUrl: string; model: string; protocol: ApiProtocol; apiKey: string }> } = { enabled: true, lastProvider: provider, profiles: {} };
    try {
      const existing = window.localStorage.getItem(API_STORAGE_KEY);
      if (existing) saved = { ...saved, ...JSON.parse(existing), profiles: JSON.parse(existing).profiles || {} };
    } catch {}
    saved.enabled = true;
    saved.lastProvider = provider;
    saved.profiles[provider] = { baseUrl: apiBaseUrl, model, protocol: apiProtocol, apiKey };
    window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(saved));
  }, [apiStorageReady, saveApiLocally, provider, apiBaseUrl, model, apiProtocol, apiKey]);

  const loadVideoFile = (file: File) => {
    if (!file.type.startsWith("video/")) {
      setError("请拖入 MP4、MOV、WebM 等视频文件。");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setFileName(file.name);
    setFrames([]);
    setAnalysis(null);
    setStatus("idle");
    setError("");
  };

  const chooseVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadVideoFile(file);
  };

  const dropVideo = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragTarget(null);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("video/"));
    if (file) loadVideoFile(file);
    else setError("没有检测到可用的视频文件。");
  };

  const chooseRules = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["txt", "md", "json"].includes(extension)) {
      setError("提示词规则请上传 TXT、Markdown 或 JSON 文本文件。");
      event.target.value = "";
      return;
    }
    if (file.size > 64 * 1024) {
      setError("提示词规则文件不能超过 64 KB。");
      event.target.value = "";
      return;
    }
    const text = await file.text();
    if (!text.trim()) {
      setError("提示词规则文件内容为空。");
      event.target.value = "";
      return;
    }
    setCustomRules(text.slice(0, 60000));
    setRulesFileName(file.name);
  };

  const prepareReferenceImage = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      throw new Error(`${file.name} 不是图片文件。`);
    }
    if (file.size > 12 * 1024 * 1024) {
      throw new Error(`${file.name} 超过 12 MB。`);
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("无法读取角色参考图。"));
        image.src = objectUrl;
      });
      const maxEdge = 1536;
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法处理角色参考图。");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { id: `${file.name}-${file.lastModified}-${Math.random()}`, name: file.name, dataUrl: canvas.toDataURL("image/jpeg", 0.88) };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const addReferenceImages = async (files: FileList | File[]) => {
    setError("");
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setError("没有检测到可用的图片文件。");
      return;
    }
    const referenceLimit = workMode === "first_last" ? 2 : 9;
    const available = referenceLimit - referenceImages.length;
    if (available <= 0) {
      setError(workMode === "first_last" ? "首尾帧模式只能添加 2 张图片。" : "参考图最多只能添加 9 张。");
      return;
    }
    const selected = images.slice(0, available);
    try {
      const prepared = [];
      for (const file of selected) prepared.push(await prepareReferenceImage(file));
      setReferenceImages((current) => [...current, ...prepared].slice(0, referenceLimit));
      if (images.length > available) setError(`此模式最多添加 ${referenceLimit} 张，已载入前 ${available} 张图片。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取角色参考图。");
    }
  };

  const chooseReferenceImages = async (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) await addReferenceImages(event.target.files);
    event.target.value = "";
  };

  const dropReferenceImages = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragTarget(null);
    await addReferenceImages(event.dataTransfer.files);
  };

  const clearRules = () => {
    setCustomRules("");
    setRulesFileName("");
    if (rulesInputRef.current) rulesInputRef.current.value = "";
  };

  const extractFrames = async () => {
    const video = videoRef.current;
    if (!video || !duration) throw new Error("请先选择并载入视频");
    const canvas = document.createElement("canvas");
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法读取视频画面");

    const count = Math.min(frameCount, Math.max(2, Math.ceil(duration * 2)));
    const nextFrames: Frame[] = [];
    for (let index = 0; index < count; index += 1) {
      const time = count === 1 ? 0 : (duration * index) / (count - 1);
      await seek(video, time);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      nextFrames.push({ time, dataUrl: canvas.toDataURL("image/jpeg", 0.78) });
      setFrames([...nextFrames]);
      setProgress(Math.round(((index + 1) / count) * 42));
    }
    return nextFrames;
  };

  const analyze = async () => {
    if (!requirement.trim()) return;
    if (workMode === "video" && !videoUrl) { setError("视频拆解模式请先上传视频。"); return; }
    if (workMode === "image" && referenceImages.length < 1) { setError("图生视频模式请至少上传 1 张参考图。"); return; }
    if (workMode === "first_last" && referenceImages.length !== 2) { setError("首尾帧模式需要按顺序上传 2 张图片。"); return; }
    if (provider !== "codex" && !apiKey.trim()) {
      setError(`请输入 ${PROVIDERS[provider].name} API Key，或切换回本机 Codex。`);
      return;
    }
    if (provider !== "codex" && (!apiBaseUrl.trim() || !model.trim())) {
      setError("请填写 API 地址和模型名称。");
      return;
    }
    setError("");
    setAnalysis(null);
    setStatus("extracting");
    setProgress(2);
    try {
      const captured = workMode === "video" ? await extractFrames() : [];
      setStatus("analyzing");
      setProgress(workMode === "video" ? 52 : 35);
      const response = await fetch("http://127.0.0.1:3210/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: workMode, frames: captured, requirement, fileName, duration, customRules, referenceImages, provider, apiKey: provider === "codex" ? "" : apiKey.trim(), apiBaseUrl: apiBaseUrl.trim(), model: model.trim(), apiProtocol }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Codex 分析失败，请稍后重试");
      setProgress(100);
      const normalized = normalizeAnalysisPayload(payload);
      if (!normalized.prompt) throw new Error("模型返回结果中缺少最终提示词，请重试或更换模型。");
      setAnalysis(normalized);
      setStatus("done");
    } catch (caught) {
      setStatus("error");
      const message = caught instanceof Error ? caught.message : "发生未知错误";
      setError(message === "Failed to fetch" ? "Codex 本地服务未启动，请使用 start-local.ps1 启动完整应用。" : message);
    }
  };

  const copyPrompt = async () => {
    if (!analysis) return;
    await navigator.clipboard.writeText(`${analysis.prompt}\n\n负面提示词：${analysis.negativePrompt}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const isBusy = status === "extracting" || status === "analyzing";
  const referenceLimit = workMode === "first_last" ? 2 : 9;
  const canAnalyzeInput = Boolean(requirement.trim()) && (workMode === "video" ? Boolean(videoUrl) : workMode === "image" ? referenceImages.length >= 1 : workMode === "first_last" ? referenceImages.length === 2 : true);
  const providerInfo = PROVIDERS[provider];
  const selectProvider = (nextProvider: ProviderId) => {
    const preset = PROVIDERS[nextProvider];
    let savedProfile: { baseUrl?: string; model?: string; protocol?: ApiProtocol; apiKey?: string } | undefined;
    if (saveApiLocally && nextProvider !== "codex") {
      try { savedProfile = JSON.parse(window.localStorage.getItem(API_STORAGE_KEY) || "{}").profiles?.[nextProvider]; } catch {}
    }
    setProvider(nextProvider);
    setApiBaseUrl(savedProfile?.baseUrl ?? preset.baseUrl);
    setModel(savedProfile?.model ?? preset.model);
    setApiProtocol(savedProfile?.protocol ?? preset.protocol);
    setApiKey(savedProfile?.apiKey ?? "");
    setApiValidation({ status: "idle", message: "" });
    setModelOptions([]);
    setModelListStatus({ loading: false, message: "" });
    setError("");
  };
  const loadModels = async () => {
    if (!apiKey.trim() || !apiBaseUrl.trim()) {
      setModelListStatus({ loading: false, message: "请先填写 API 地址和 API Key。" });
      return;
    }
    setModelListStatus({ loading: true, message: "正在读取模型列表…" });
    try {
      const response = await fetch("http://127.0.0.1:3210/list-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim(), apiBaseUrl: apiBaseUrl.trim(), apiProtocol }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法获取模型列表");
      const models = Array.isArray(payload.models) ? payload.models : [];
      if (!models.length) throw new Error("服务端没有返回可用模型。");
      setModelOptions(models);
      setModelListStatus({ loading: false, message: `已读取 ${models.length} 个模型，请在模型框中选择。` });
      if (!models.includes(model)) setModel(models[0]);
      setApiValidation({ status: "idle", message: "" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法获取模型列表";
      setModelListStatus({ loading: false, message: message === "Failed to fetch" ? "本地分析服务未启动，请重新运行启动脚本。" : message });
    }
  };
  const validateApi = async () => {
    if (!apiKey.trim() || !apiBaseUrl.trim() || !model.trim()) {
      setApiValidation({ status: "error", message: "请先填写 API 地址、模型名称和 API Key。" });
      return;
    }
    setApiValidation({ status: "checking", message: "正在验证地址、Key 与模型…" });
    try {
      const response = await fetch("http://127.0.0.1:3210/validate-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim(), apiBaseUrl: apiBaseUrl.trim(), model: model.trim(), apiProtocol }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "验证失败");
      setApiValidation({ status: "success", message: `${providerInfo.name} 连接成功，模型 ${payload.model || model.trim()} 可响应。` });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "验证失败";
      setApiValidation({ status: "error", message: message === "Failed to fetch" ? "本地分析服务未启动，请重新运行启动脚本。" : message });
    }
  };
  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("frameprompt-theme", nextTheme);
  };
  const selectWorkMode = (nextMode: WorkMode) => {
    setWorkMode(nextMode);
    setFrames([]);
    setAnalysis(null);
    setStatus("idle");
    setError("");
    if (nextMode === "text") setReferenceImages([]);
    if (nextMode === "first_last") setReferenceImages((current) => current.slice(0, 2));
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FramePrompt 首页"><span className="brandMark">FP</span><span>FramePrompt</span></a>
        <div className="headerActions"><div className="headerTag"><span className="pulse" /> AI 视频拆解器</div><button className="themeToggle" onClick={toggleTheme} aria-label={`切换到${theme === "light" ? "黑夜" : "白天"}模式`} title={`切换到${theme === "light" ? "黑夜" : "白天"}模式`}><span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>{theme === "light" ? "黑夜" : "白天"}</button></div>
      </header>

      <a className={`easterEgg ${eggPosition.ready ? "ready" : ""}`} style={{ left: eggPosition.left, top: eggPosition.top }} href="https://ys.mihoyo.com/main/?from_fab=1" target="_blank" rel="noopener noreferrer" aria-label="打开彩蛋页面" title="发现一个彩蛋">彩蛋</a>

      <section className="hero" id="top">
        <div className="eyebrow">VIDEO → FRAMES → PROMPT</div>
        <h1>看懂每一帧，<br /><em>写出好提示词。</em></h1>
        <p>上传一段参考视频，自动抽取代表性画面并理解人物、场景、运镜与节奏，再按你的要求生成可直接使用的提示词。</p>
      </section>

      <section className="workspace" aria-label="视频分析工作区">
        <div className="panel inputPanel">
          <div className="panelHead"><span className="step">01</span><div><h2>选择创作模式</h2><p>既可以拆解视频，也可以不提供视频直接创作提示词</p></div></div>
          <div className="modeChoices">{(Object.keys(WORK_MODES) as WorkMode[]).map((id) => <button key={id} className={workMode === id ? "active" : ""} onClick={() => selectWorkMode(id)}><b>{WORK_MODES[id].name}</b><small>{WORK_MODES[id].short}</small></button>)}</div>
          <div className="modeGuide"><b>{WORK_MODES[workMode].name}</b><span>{WORK_MODES[workMode].guide}</span></div>

          {workMode === "video" && <>
          <input ref={fileInputRef} type="file" accept="video/mp4,video/webm,video/quicktime,video/*" onChange={chooseVideo} hidden />
          {!videoUrl ? (
            <button className={`dropzone ${dragTarget === "video" ? "dragging" : ""}`} onClick={() => fileInputRef.current?.click()} onDragEnter={() => setDragTarget("video")} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragTarget(null)} onDrop={dropVideo}>
              <span className="uploadIcon">↗</span><strong>选择或拖入视频文件</strong><small>MP4、MOV 或 WebM · 建议 3 分钟以内</small>
            </button>
          ) : (
            <div className={`videoWrap ${dragTarget === "video" ? "dragging" : ""}`} onDragEnter={() => setDragTarget("video")} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragTarget(null)} onDrop={dropVideo}>
              <video ref={videoRef} src={videoUrl} controls preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
              <div className="fileMeta"><span className="fileName">{fileName}</span><span>{formatTime(duration)} · {frames.length ? `${frames.length} 帧已读取` : "等待分析"}</span><button onClick={() => fileInputRef.current?.click()}>更换</button></div>
            </div>
          )}
          </>}

          {workMode !== "text" && <div className={`referenceBlock ${dragTarget === "reference" ? "dragging" : ""}`} onDragEnter={() => setDragTarget("reference")} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragTarget(null)} onDrop={dropReferenceImages}>
            <div className="referenceTitle"><span className="ruleBadge">{workMode === "first_last" ? "帧" : "参考"}</span><span><strong>{workMode === "video" ? "角色参考图" : workMode === "image" ? "图生视频参考图" : "首尾帧图片"} <b>{referenceImages.length}/{referenceLimit}</b></strong><small>{workMode === "first_last" ? "请按起始帧、结束帧顺序上传" : "可拖入多张 · 同一人物多角度或多个角色"}</small></span></div>
            <input ref={referenceInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/*" onChange={chooseReferenceImages} hidden />
            {!referenceImages.length ? (
              <button className="referenceUpload" onClick={() => referenceInputRef.current?.click()}><span className="portraitPlaceholder">{workMode === "first_last" ? "帧" : "图"}</span><span><b>{workMode === "first_last" ? "选择或拖入首尾帧" : "选择或拖入参考图片"}</b><small>最多 {referenceLimit} 张 · JPG / PNG / WebP</small></span></button>
            ) : (
              <div className="referenceGrid">{referenceImages.map((image, index) => <figure key={image.id}><img src={image.dataUrl} alt={`参考图 ${index + 1}`} /><figcaption>{workMode === "first_last" ? (index === 0 ? "<First Frame>" : "<Last Frame>") : `<Picture ${index + 1}>`}</figcaption><button onClick={() => setReferenceImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`移除 ${image.name}`}>×</button></figure>)}{referenceImages.length < referenceLimit && <button className="addReference" onClick={() => referenceInputRef.current?.click()}><span>＋</span><small>继续添加</small></button>}</div>
            )}
            <div className="dropHint">拖放图片到此区域 · 已添加 {referenceImages.length} / {referenceLimit}</div>
          </div>}

          {workMode === "video" && <div className="controlRow">
            <label htmlFor="frameCount"><span>分析精度</span><b>{frameCount} 帧</b></label>
            <input id="frameCount" type="range" min="6" max="24" step="2" value={frameCount} onChange={(event) => setFrameCount(Number(event.target.value))} />
            <div className="rangeLabels"><span>快速</span><span>精细</span></div>
          </div>}

          <div className="requestBlock">
            <label htmlFor="requirement"><span className="step">02</span><span><strong>告诉我你想要什么</strong><small>可指定平台、语言、风格和输出结构</small></span></label>
            <textarea id="requirement" value={requirement} onChange={(event) => setRequirement(event.target.value)} rows={5} placeholder={workMode === "video" ? "例如：分析镜头语言，写成适合 MiniMax H3 的 10 秒视频提示词……" : workMode === "text" ? "例如：10 秒电影感视频，雨夜的未来城市中，一名少女回头看向镜头……" : workMode === "image" ? "例如：让图中人物缓慢转身，镜头环绕推进，保持人物身份和服装一致……" : "例如：从起始帧自然运动到结束帧，设计连贯动作、运镜和环境变化……"} />
          </div>

          <div className="rulesBlock">
            <div className="rulesTitle"><span className="ruleBadge">规则</span><span><strong>提示词规则</strong><small>默认采用 MiniMax H3 官方 Prompting Guidance</small></span><a href="https://huggingface.co/MiniMaxAI/MiniMax-H3" target="_blank" rel="noreferrer">官方规则 ↗</a></div>
            <input ref={rulesInputRef} type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" onChange={chooseRules} hidden />
            {!rulesFileName ? (
              <button className="rulesUpload" onClick={() => rulesInputRef.current?.click()}><span>＋</span><span><b>上传自定义规则</b><small>TXT / MD / JSON · 最大 64 KB</small></span></button>
            ) : (
              <div className="rulesFile"><span className="rulesFileIcon">R</span><span><b>{rulesFileName}</b><small>已载入 {customRules.length.toLocaleString()} 个字符 · 将优先于默认规则</small></span><button onClick={clearRules} aria-label="移除自定义规则">移除</button></div>
            )}
            <div className="ruleStatus"><i className={customRules ? "custom" : ""} /><span>{customRules ? "自定义规则优先，官方 H3 规则作为基础约束" : "正在使用内置 MiniMax H3 官方规则"}</span></div>
          </div>

          <div className="providerBlock">
            <div className="providerTitle"><span className="ruleBadge">引擎</span><span><strong>分析引擎</strong><small>默认走本机 Codex，也支持多家 API、自定义地址和模型</small></span></div>
            <div className="providerChoices">
              {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => <button key={id} className={provider === id ? "active" : ""} onClick={() => selectProvider(id)}><b>{PROVIDERS[id].name}</b><small>{PROVIDERS[id].short}</small></button>)}
            </div>
            {provider !== "codex" && <div className="apiSettings">
              <div className="apiField wide"><label htmlFor="apiBaseUrl">API 地址</label><input id="apiBaseUrl" type="url" value={apiBaseUrl} onChange={(event) => { setApiBaseUrl(event.target.value); setApiValidation({ status: "idle", message: "" }); setModelOptions([]); setModelListStatus({ loading: false, message: "" }); }} placeholder="https://api.example.com/v1" spellCheck={false} /></div>
              <div className="apiField"><label htmlFor="apiProtocol">接口协议</label><select id="apiProtocol" value={apiProtocol} onChange={(event) => { setApiProtocol(event.target.value as ApiProtocol); setApiValidation({ status: "idle", message: "" }); setModelOptions([]); setModelListStatus({ loading: false, message: "" }); }}><option value="chat">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini generateContent</option></select></div>
              <div className="apiField"><label htmlFor="model">模型名称</label><div className="modelPicker"><input id="model" list="availableModels" value={model} onChange={(event) => { setModel(event.target.value); setApiValidation({ status: "idle", message: "" }); }} placeholder="输入或选择模型 ID" spellCheck={false} /><button type="button" onClick={loadModels} disabled={modelListStatus.loading || !apiKey.trim() || !apiBaseUrl.trim()}>{modelListStatus.loading ? "读取中" : "获取模型"}</button></div><datalist id="availableModels">{modelOptions.map((item) => <option key={item} value={item} />)}</datalist></div>
              <div className="apiField wide"><label htmlFor="apiKey">{providerInfo.name} API Key</label><input id="apiKey" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setApiValidation({ status: "idle", message: "" }); }} placeholder="输入你的 API Key" autoComplete="off" spellCheck={false} /></div>
              <div className="credentialMode">
                <div><button type="button" className={!saveApiLocally ? "active" : ""} onClick={() => setSaveApiLocally(false)}><b>仅本次使用</b><small>关闭页面后清除</small></button><button type="button" className={saveApiLocally ? "active" : ""} onClick={() => setSaveApiLocally(true)}><b>保存到本机</b><small>下次打开自动恢复</small></button></div>
                <p className={saveApiLocally ? "warning" : ""}>{saveApiLocally ? "API Key 将以明文保存在当前浏览器本地存储中，仅建议在个人电脑使用。切回“仅本次使用”会立即删除本地记录。" : "API Key 只保存在当前页面内存，不会写入磁盘或日志。"}</p>
              </div>
              {modelListStatus.message && <div className={`modelListMessage ${modelOptions.length ? "success" : ""}`}>{modelListStatus.message}</div>}
              <div className="apiValidateRow"><button type="button" onClick={validateApi} disabled={apiValidation.status === "checking" || !apiKey.trim() || !apiBaseUrl.trim() || !model.trim()}>{apiValidation.status === "checking" ? "正在验证…" : "验证 API 连接"}</button><small>发送一个极短文本请求，不上传视频帧或参考图</small></div>
              {apiValidation.status !== "idle" && <div className={`apiValidation ${apiValidation.status}`} role="status"><i />{apiValidation.message}</div>}
              <div className="apiNotice"><b>视觉模型必需</b><span>{providerInfo.note}</span></div>
            </div>}
          </div>

          <button className="analyzeButton" disabled={!canAnalyzeInput || isBusy || (provider !== "codex" && (!apiKey.trim() || !apiBaseUrl.trim() || !model.trim()))} onClick={analyze}>
            {status === "extracting" ? "正在逐帧读取…" : status === "analyzing" ? `${providerInfo.name} 正在生成…` : `使用 ${providerInfo.name} 生成提示词`}<span>→</span>
          </button>
          {isBusy && <div className="progress" aria-label={`分析进度 ${progress}%`}><i style={{ width: `${progress}%` }} /><span>{progress}%</span></div>}
          {error && <div className="errorBox">{error}</div>}
        </div>

        <div className="panel outputPanel">
          <div className="panelHead"><span className="step">03</span><div><h2>分析与提示词</h2><p>{workMode === "video" ? "模型会结合所有画面与时间顺序综合判断" : "模型会按所选模式设计完整视频提示词"}</p></div></div>
          {!analysis ? (
            <div className="emptyState"><div className="emptyGrid"><span /><span /><span /><span /></div><h3>{isBusy ? (workMode === "video" ? "正在理解视频…" : "正在设计视频…") : "结果会出现在这里"}</h3><p>{isBusy ? (workMode === "video" ? "先识别各帧内容，再整理镜头逻辑与最终提示词。" : "正在整理主体、动作、运镜、声音和时间结构。") : "完成左侧设置后开始生成。"}</p></div>
          ) : (
            <div className="results">
              <section><div className="resultLabel">内容概览</div><p className="summary">{analysis.summary}</p></section>
              <section><div className="resultLabel">{workMode === "video" ? "逐帧观察" : "分镜时间线"}</div><div className="timeline">{analysis.timeline.map((item, index) => <div className="timelineItem" key={`${item.time}-${index}`}><time>{item.time}</time><p>{item.observation}</p></div>)}</div></section>
              <section className="promptCard"><div className="promptHead"><div className="resultLabel">最终提示词</div><button onClick={copyPrompt}>{copied ? "已复制 ✓" : "复制"}</button></div><pre>{analysis.prompt}</pre>{analysis.negativePrompt && <div className="negative"><b>负面提示词</b><p>{analysis.negativePrompt}</p></div>}</section>
              {Array.isArray(analysis.notes) && analysis.notes.length > 0 && <section><div className="resultLabel">使用建议</div><ul>{analysis.notes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}</ul></section>}
            </div>
          )}
        </div>
      </section>

      {frames.length > 0 && <section className="frameStrip"><div className="stripHead"><div><span className="eyebrow">FRAME CONTACT SHEET</span><h2>抽帧预览</h2></div><span>{frames.length} 个时间点</span></div><div className="frames">{frames.map((frame) => <figure key={frame.time}><img src={frame.dataUrl} alt={`${formatTime(frame.time)} 的视频画面`} /><figcaption>{formatTime(frame.time)}</figcaption></figure>)}</div></section>}

      <footer><span>FramePrompt</span><p>支持 Codex 与多家视觉 API · 请勿上传无权使用的内容</p></footer>
    </main>
  );
}
