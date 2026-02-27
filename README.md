# Chat Completions → Responses API 协议转换代理

一个运行在 Cloudflare Workers 上的轻量级 API 协议转换代理。它接收标准的 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat) 格式请求，自动转换为 [Responses API](https://platform.openai.com/docs/api-reference/responses) 格式发送给供应商，再将结果转换回 Chat Completions 格式返回——客户端完全感知不到协议差异。

## 适用场景

你的供应商**只支持 Responses API**，但你使用的客户端/工具**只支持 Chat Completions API**。本项目在两者之间架起桥梁。

```
客户端 (Chat Completions) → [Worker 转换] → 供应商 (Responses API)
客户端 (Chat Completions) ← [Worker 转换] ← 供应商 (Responses API)
```

## 功能特性

- ✅ **文本对话**：支持 system / user / assistant 多轮对话
- ✅ **多模态**：支持图片（image_url）等多模态内容
- ✅ **工具调用（Function Calling）**：完整支持 tool_calls 和 tool 角色消息的转换
- ✅ **流式响应（SSE）**：实时转换 Responses API 的 SSE 事件为 Chat Completions chunk 格式
- ✅ **多变体重试**：自动生成多种请求格式变体，兼容不同上游实现
- ✅ **response_format**：支持 `json_schema` 格式转换
- ✅ **reasoning_effort**：透传推理强度参数

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/cxy13h/chat-to-responses-proxy
cd chat-to-responses-proxy
npm install
```

### 2. 配置环境变量

创建 `.dev.vars` 文件用于本地开发：

```ini
# 供应商 Responses API 的完整地址
TARGET_URL=https://your-provider.com/v1/responses
```

> **说明**：API Key 由客户端请求时通过 `Authorization: Bearer xxx` 头部携带，Worker 会原样透传给供应商，无需在环境变量中配置。

### 3. 本地开发

```bash
npm run dev
```

默认监听 `http://localhost:8787`。

### 4. 测试

```bash
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "system", "content": "你是一个助手"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

流式请求：

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 5. 部署到 Cloudflare Workers

```bash
npm run deploy
```

部署后在 **Cloudflare Dashboard → Workers → Settings → Variables and Secrets** 中添加 `TARGET_URL` 环境变量。
注意 `TARGET_URL` 即你的供应商的完整的 Responses API 地址。

## 在客户端中使用

部署完成后，你可以在任何兼容 OpenAI API 的客户端中使用，只需将 BASE_URL 设置为你的 Worker 地址：

```
https://<your-worker-name>.<your-subdomain>.workers.dev/v1/chat/completions
```

API Key 填写你供应商的密钥即可。

## 协议转换对照表

### 请求转换（Chat Completions → Responses API）

| Chat Completions | Responses API |
|---|---|
| `messages` (system) | `instructions` |
| `messages` (user/assistant) | `input[]` |
| `messages` (tool) | `input[]` → `function_call_output` |
| `tool_calls` | `function_call` items |
| `tools[].function.{name,params}` | `tools[].{name,params}` (平铺) |
| `max_tokens` | `max_output_tokens` |
| `response_format.json_schema` | `text.format` |

### 响应转换（Responses API → Chat Completions）

| Responses API | Chat Completions |
|---|---|
| `output[].content[].output_text` | `choices[].message.content` |
| `output[]` → `function_call` | `choices[].message.tool_calls` |
| `usage.input_tokens` | `usage.prompt_tokens` |
| `usage.output_tokens` | `usage.completion_tokens` |

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat Completions 请求入口 |
| `GET` | `/health` | 健康检查 |

## 致谢

协议转换逻辑参考了 [any-api](https://github.com/nightwhite/any-api) 项目。

## License

MIT
