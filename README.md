# FramePrompt 本地提示词助手

一个可在 Windows 本地运行的提示词生成与视频分析工具。支持自定义提示词规则、接入多种 AI API，并能根据视频、图片或文字需求生成结构化的视频提示词。

## 主要功能

- 自定义提示词规则：支持上传 TXT、Markdown、JSON 规则文件，最大 64 KB
- 多种工作模式：视频逐帧拆解、文生视频、图生视频、首尾帧生成
- 本地视频抽帧：支持 MP4、MOV、WebM，原视频只在浏览器本地解码
- 画面分析：按时间顺序分析人物、场景、构图、运镜、动作、光线和声音线索
- 角色参考图：最多上传 9 张图片，可用于同一人物多角度或多角色参考
- 内置 MiniMax H3 Prompting Guidance，输出完整参考模式提示词、逐帧观察和使用建议
- 支持 API 连通性验证和模型列表读取，减少地址、协议或模型 ID 配置错误
- 支持明暗主题切换，并在本地保存主题偏好

## 支持的模型与 API

默认使用本机已登录的 Codex，无需配置 `OPENAI_API_KEY`。也可以切换到：

- OpenAI
- MiniMax
- DeepSeek
- Claude
- Gemini
- OpenRouter
- 硅基流动
- 自定义 API

可自定义 API 地址、接口协议和模型 ID，支持：

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages
- Gemini `generateContent`

使用自定义 API 时，请只连接可信服务。视频分析会把压缩后的抽帧图片发送到所选 API，因此所用模型必须支持图片输入。

## Windows 快速启动

1. 安装 Node.js 22 或更高版本。
2. 打开 Codex 并完成登录。
3. 双击 `启动FramePrompt.cmd`。
4. 程序会自动打开浏览器。
5. 关闭时，回到标题为“FramePrompt 本地视频提示词助手”的窗口并按 `Ctrl+C`。

## 手动启动

```powershell
npm install
npm run codex-bridge
npm run dev
```

`npm run codex-bridge` 和 `npm run dev` 需要分别在两个终端中运行。

## 可选配置

复制 `.env.example`，并根据需要设置：

```env
OPENAI_API_KEY=
OPENAI_MODEL=
CODEX_MODEL=
```

不设置 `CODEX_MODEL` 时，将使用当前 Codex 的默认模型和登录状态。

## 隐私说明

- 原视频文件仅在浏览器中解码，不会直接上传
- API Key 默认只保存在当前页面内存中，不写入磁盘或日志
- 如选择在浏览器中保存 API 配置，数据只保存在当前浏览器本地
- 切换回“仅本次使用”会清除本地保存的 API 配置
