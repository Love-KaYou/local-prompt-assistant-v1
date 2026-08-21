# FramePrompt 本地版

这是一个完全在本地启动的 Web 应用。视频原文件只在浏览器中解码，压缩后的抽帧画面交给本机已经登录的 Codex 分析。默认不需要 `OPENAI_API_KEY`。

## Windows 快速启动

1. 安装 Node.js 22 或更高版本。
2. 打开 Codex 并完成登录。
3. 双击 `启动FramePrompt.cmd`。
4. 程序会自动打开浏览器，无需输入命令。
5. 关闭时回到标题为“FramePrompt 本地视频提示词助手”的窗口按 `Ctrl+C`。

## 手动启动

```powershell
npm install
npm run codex-bridge  # 单独终端运行
npm run dev
```

## 功能

- 四种模式：视频逐帧拆解、文生视频、图生视频、首尾帧生成
- 文生视频无需上传任何素材；图生视频只需参考图；首尾帧模式固定使用两张图片
- 上传 MP4、MOV、WebM 视频并在浏览器本地抽帧
- 按时间顺序分析人物、场景、构图、运镜、动作、光线和声音线索
- 内置 MiniMax H3 官方 Prompting Guidance
- 上传 TXT、Markdown、JSON 自定义提示词规则（最大 64 KB）
- 视频与图片均支持点击选择或直接拖入
- 最多上传 9 张角色参考图，用同一人物多角度或多个角色替换视频人物，同时保留原视频动作、镜头和场景
- 默认使用本机 Codex；也可切换到 OpenAI、MiniMax、DeepSeek、Claude、Gemini、OpenRouter、硅基流动或自定义 API
- 用户可修改 API 地址、接口协议和模型 ID；支持 Responses、Chat Completions、Anthropic Messages 和 Gemini generateContent
- API Key 默认只保存在当前页面内存中，不写入磁盘或日志
- 用户可选择 API 仅本次使用，或把不同提供商的地址、模型和 Key 保存到当前浏览器本地；切回仅本次会清除本地记录
- 可在上传视频前验证 API 地址、Key、协议和模型是否能够正常响应
- 可使用当前 Key 自动读取服务商允许访问的模型列表，避免手填错误模型 ID
- 支持白天/黑夜模式切换，并在本机保存主题偏好
- 页面中会随机出现一个“彩蛋”按钮
- 输出 H3 完整参考模式提示词、逐帧观察和使用建议

## API 使用说明

逐帧分析会向所选 API 发送压缩后的画面，因此模型必须支持图片输入。Claude、Gemini、OpenRouter 视觉模型和硅基流动视觉模型可以直接用于此流程。MiniMax 和 DeepSeek 的部分官方对话模型仅支持文本；若返回“不支持 image”之类的错误，请在模型栏改成该平台可用的视觉模型，或选择其他视觉提供商。

“自定义 API”可填写 API 根地址或完整接口地址。OpenAI 兼容协议的根地址会自动补充 `/v1/chat/completions` 或 `/v1/responses`；已经包含接口路径时不会重复添加。请只连接可信服务，因为 Key 与抽帧图片会发送到该地址。

## 可选配置

```env
CODEX_MODEL=
```

不设置 `CODEX_MODEL` 时，会使用当前 Codex 的默认模型和登录状态。网页默认仍然选择本机 Codex。
