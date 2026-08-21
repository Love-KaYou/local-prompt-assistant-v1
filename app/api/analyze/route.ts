import { NextResponse } from "next/server";

export const runtime = "edge";

type InputFrame = { time: number; dataUrl: string };

const MINIMAX_H3_RULES = `MiniMax H3 official prompting rules (condensed from the model card Prompting Guidance):
1. H3 supports 4–15 second audio-video outputs. Respect the duration and aspect ratio requested by the user. If unspecified, infer a practical duration no longer than 15 seconds.
2. Identify the task as T2VA (text only), I2VA (first frame), FL2VA (first and last frame), L2VA (last frame), or full-reference mode. For an extracted reference video, normally use full-reference mode with <Video 1> as the temporal and camera reference, and visible reusable elements as stable <Subject N> labels.
3. Standard base output uses these exact English fields: integrated_multimodal_description, overall_soundscape, non_diegetic_music. Full-reference output uses exactly: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.
4. Write the H3 prompt in English. Preserve the original language only inside dialogue or lyrics in <d>[Language] ...</d>, and for visible on-screen text. Use stable speaker IDs (S1), (S2). Preserve user-provided dialogue verbatim.
5. Describe the video in playback order. [Shot 1] has no timestamp. Later cuts use strictly increasing timestamps: [Shot N] At MM:SS.mmm, the camera cuts to... Each cut must introduce new information; otherwise prefer camera motion.
6. Write camera movement as a natural action containing motion type and, where meaningful, amplitude and speed: push or pull, pan, truck, tilt, pedestal, arc, tracking, static, shake, POV, roll, or zoom.
7. Every detail must be visible or audible: style, composition, subject identity and position, environment, lighting, actions, state changes, camera, dialogue, and synchronized sound. Keep identity, clothing, colors, props, and spatial relationships consistent.
8. overall_soundscape is 1–4 English sentences for ambience, physical sounds, and non-verbal human sounds; do not repeat dialogue. non_diegetic_music is 1–3 English sentences covering instrumentation, tempo, rhythm, and dynamics; use N/A when absent.
9. Full-reference mode keeps label meanings stable across all six sections. retention_analysis uses official markers including fully_preserved, partially_preserved, attribute_transfer, weak_reference; audio uses fully_copy, partially_copy, reference, weak_reference.
10. Produce one directly pasteable natural-language H3 prompt. Use positive, concrete descriptions. Do not output JSON inside the prompt and do not add a negative prompt unless custom rules explicitly require one.`;

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务端尚未配置 OPENAI_API_KEY。请在环境变量中添加后重试。" }, { status: 503 });

    const body = await request.json() as { frames?: InputFrame[]; requirement?: string; fileName?: string; duration?: number; customRules?: string };
    const frames = body.frames?.slice(0, 24) ?? [];
    if (frames.length < 2 || !body.requirement?.trim()) return NextResponse.json({ error: "至少需要两个视频画面和明确的生成要求。" }, { status: 400 });

    const customRules = typeof body.customRules === "string" ? body.customRules.trim().slice(0, 60000) : "";
    const rules = customRules
      ? `${MINIMAX_H3_RULES}\n\nUSER-UPLOADED RULES (higher priority for format and creative choices):\n${customRules}`
      : MINIMAX_H3_RULES;

    const inputContent = [
      {
        type: "input_text",
        text: `你是资深视频导演、分镜师和 MiniMax H3 提示词工程师。请按时间顺序分析下面从同一视频抽取的 ${frames.length} 帧。

用户要求：${body.requirement}
文件名：${body.fileName || "未命名视频"}
参考视频时长：${Number(body.duration || 0).toFixed(1)} 秒

提示词规则：
${rules}

分析说明：重点判断主体一致性、动作变化、场景、构图、景别、机位、镜头运动、光线、色彩、材质、情绪、转场、声音线索与节奏。不要声称看到了抽帧之间未提供的信息；不确定时在中文分析中明确使用“推测”。summary、timeline 和 notes 使用中文；prompt 严格遵守 H3 规则，默认输出英文的完整 H3 Context-IR 风格提示词；negativePrompt 默认返回空字符串。只返回符合所给 JSON schema 的 JSON。`,
      },
      ...frames.flatMap((frame) => [
        { type: "input_text", text: `时间点 ${formatTime(frame.time)}` },
        { type: "input_image", image_url: frame.dataUrl, detail: "low" },
      ]),
    ];

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
        input: [{ role: "user", content: inputContent }],
        reasoning: { effort: "low" },
        text: {
          verbosity: "medium",
          format: {
            type: "json_schema",
            name: "video_prompt_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string" },
                timeline: { type: "array", items: { type: "object", additionalProperties: false, properties: { time: { type: "string" }, observation: { type: "string" } }, required: ["time", "observation"] } },
                prompt: { type: "string" },
                negativePrompt: { type: "string" },
                notes: { type: "array", items: { type: "string" } },
              },
              required: ["summary", "timeline", "prompt", "negativePrompt", "notes"],
            },
          },
        },
        max_output_tokens: 4000,
      }),
    });

    const result = await response.json() as { output_text?: string; error?: { message?: string } };
    if (!response.ok) return NextResponse.json({ error: result.error?.message || "OpenAI API 调用失败" }, { status: response.status });
    if (!result.output_text) return NextResponse.json({ error: "模型没有返回可解析的分析结果" }, { status: 502 });
    return NextResponse.json(JSON.parse(result.output_text));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分析服务发生未知错误" }, { status: 500 });
  }
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
