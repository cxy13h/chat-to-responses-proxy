/**
 * Cloudflare Worker — Chat Completions ↔ Responses API 协议转换代理（增强版）
 *
 * 工作原理：
 *   1. 接收客户端发来的标准 OpenAI Chat Completions 请求（/v1/chat/completions）
 *   2. 将请求体转换为 Responses API 格式，转发给目标供应商
 *   3. 将供应商返回的 Responses API 响应再转换回 Chat Completions 格式
 *   4. 客户端完全感知不到协议差异
 *
 * 参考 https://github.com/nightwhite/any-api 的转换逻辑实现
 *
 * 需要在 Cloudflare Workers「变量和机密」中配置：
 *   TARGET_URL     — 目标供应商的 Responses API 地址（含路径）
 *                    例如：https://your-provider.com/v1/responses
 *   OPENAI_API_KEY — 供应商 API 密钥（客户端未传 Authorization 时作为回退）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 通用工具函数
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

function corsPreflightResponse() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
    });
}

/**
 * 规范化消息的 content 字段，始终提取为纯文本字符串
 */
function normalizeMessageContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === 'string') { parts.push(item); continue; }
            if (item && typeof item === 'object') {
                const t = item.type;
                if (t === 'text' || t === 'input_text' || t === 'output_text') {
                    if (typeof item.text === 'string') parts.push(item.text);
                } else if (typeof item.text === 'string') {
                    parts.push(item.text);
                }
            }
        }
        return parts.join('');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text;
    }
    return String(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求体转换（Chat Completions → Responses API）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将多模态 content 数组的 type 字段映射为 Responses API 规范：
 *   "text"      → "input_text"
 *   "image_url" → "input_image"
 */
function convertContentToResponsesParts(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return normalizeMessageContent(content);

    const out = [];
    for (const part of content) {
        if (part == null) continue;
        if (typeof part === 'string') {
            out.push({ type: 'input_text', text: part });
            continue;
        }
        if (typeof part !== 'object') continue;

        const t = part.type;
        if (t === 'text' || t === 'input_text' || t === 'output_text') {
            if (typeof part.text === 'string') out.push({ type: 'input_text', text: part.text });
        } else if (t === 'image_url' || t === 'input_image') {
            // 兼容多种 image_url 格式：字符串或 { url: "..." } 对象
            const imageUrl = part.image_url;
            const url =
                typeof imageUrl === 'string'
                    ? imageUrl
                    : imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string'
                        ? imageUrl.url
                        : '';
            if (url) out.push({ type: 'input_image', image_url: url });
        } else {
            // 未知类型原样保留
            out.push(part);
        }
    }
    return out.length ? out : '';
}

/**
 * 从 Chat Completions 的 assistant 消息中提取工具调用，返回标准化列表
 */
function normalizeToolCalls(msg) {
    const out = [];
    if (!msg || typeof msg !== 'object') return out;

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : null;
        const callId = typeof tc.id === 'string' ? tc.id : `call_${crypto.randomUUID().replace(/-/g, '')}`;
        const name = fn && typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const args = fn ? (typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})) : '{}';
        out.push({ call_id: callId, name, arguments: args });
    }

    // 兼容旧的 function_call 格式
    if (msg.function_call && typeof msg.function_call === 'object') {
        const fc = msg.function_call;
        const name = typeof fc.name === 'string' ? fc.name : '';
        if (name) {
            const args = typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {});
            const callId = msg.tool_call_id || msg.id || `call_${crypto.randomUUID().replace(/-/g, '')}`;
            out.push({ call_id: callId, name, arguments: args });
        }
    }

    return out;
}

/**
 * 将 Chat Completions 的 messages 数组转换为 Responses API 的 instructions + input
 *
 * 参考 any-api: providers/openai.ts → chatMessagesToResponsesInput()
 */
function chatMessagesToResponsesInput(messages) {
    const instructionsParts = [];
    const inputItems = [];

    for (const msg of Array.isArray(messages) ? messages : []) {
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role || 'user';

        // system / developer → 顶层 instructions
        if (role === 'system' || role === 'developer') {
            const text = normalizeMessageContent(msg.content);
            if (text.trim()) instructionsParts.push(text);
            continue;
        }

        // tool → function_call_output
        if (role === 'tool') {
            const callId = msg.tool_call_id ?? msg.call_id ?? msg.id ?? '';
            const output = normalizeMessageContent(msg.content);
            if (callId) {
                inputItems.push({ type: 'function_call_output', call_id: callId, output: output ?? '' });
            }
            continue;
        }

        // assistant → 文本 + function_call items
        if (role === 'assistant') {
            const text = normalizeMessageContent(msg.content);
            if (text.trim()) {
                inputItems.push({ role: 'assistant', content: text });
            }

            // 提取工具调用
            const calls = normalizeToolCalls(msg);
            for (const c of calls) {
                inputItems.push({
                    type: 'function_call',
                    id: `fc_${c.call_id}`,
                    call_id: c.call_id,
                    name: c.name,
                    arguments: c.arguments,
                });
            }
            continue;
        }

        // user（及其他角色降级为 user）
        const contentParts = convertContentToResponsesParts(msg.content);
        if (typeof contentParts === 'string' && contentParts.trim()) {
            inputItems.push({ role: 'user', content: contentParts });
        } else if (Array.isArray(contentParts) && contentParts.length) {
            inputItems.push({ role: 'user', content: contentParts });
        }
    }

    const instructions = instructionsParts
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n');

    return { instructions: instructions || null, input: inputItems };
}

/**
 * 将 tools 数组中函数工具的定义格式从 Chat Completions 格式转为 Responses API 格式：
 *   { type: "function", function: { name, description, parameters } }
 *     → { type: "function", name, description, parameters }
 *
 * 参考 any-api: providers/openai.ts → openaiToolsToResponsesTools()
 */
function transformTools(tools) {
    if (!Array.isArray(tools)) return undefined;

    return tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return tool;
        if (tool.type !== 'function') return tool; // 非函数类型原样保留

        const fn = tool.function && typeof tool.function === 'object' ? tool.function : null;
        const name = typeof tool.name === 'string' ? tool.name : fn && typeof fn.name === 'string' ? fn.name : '';
        if (!name) return tool;

        const description = typeof tool.description === 'string'
            ? tool.description
            : fn && typeof fn.description === 'string' ? fn.description : '';
        const parameters = tool.parameters && typeof tool.parameters === 'object'
            ? tool.parameters
            : fn && fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null;

        const result = { type: 'function', name };
        if (description.trim()) result.description = description;
        if (parameters) result.parameters = parameters;
        return result;
    });
}

/**
 * 转换 tool_choice 字段
 */
function transformToolChoice(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    if (typeof toolChoice !== 'object') return undefined;

    if (toolChoice.type !== 'function') return toolChoice;

    const name = typeof toolChoice.name === 'string'
        ? toolChoice.name
        : toolChoice.function && typeof toolChoice.function === 'object' && typeof toolChoice.function.name === 'string'
            ? toolChoice.function.name
            : '';
    return name ? { type: 'function', name } : toolChoice;
}

/**
 * 转换 response_format 字段为 Responses API 的 text.format 结构
 */
function transformResponseFormat(responseFormat) {
    if (!responseFormat || typeof responseFormat !== 'object') return undefined;
    if (responseFormat.type !== 'json_schema') return undefined;

    return {
        format: {
            type: 'json_schema',
            ...responseFormat.json_schema,
        },
    };
}

/**
 * 将完整的 Chat Completions 请求体转换为单个 Responses API 请求体
 */
function buildResponsesApiRequest(originalBody) {
    const { instructions, input } = chatMessagesToResponsesInput(originalBody.messages);

    const responsesReq = {
        model: originalBody.model || '',
        input,
        stream: Boolean(originalBody.stream),
    };

    // instructions
    if (instructions) responsesReq.instructions = instructions;

    // tools
    const tools = transformTools(originalBody.tools);
    if (tools && tools.length) responsesReq.tools = tools;

    // tool_choice
    const toolChoice = transformToolChoice(originalBody.tool_choice);
    if (toolChoice !== undefined) responsesReq.tool_choice = toolChoice;

    // max_tokens → max_output_tokens
    if (originalBody.max_tokens != null) responsesReq.max_output_tokens = originalBody.max_tokens;
    if (originalBody.max_completion_tokens != null) responsesReq.max_output_tokens = originalBody.max_completion_tokens;

    // temperature / top_p
    if (originalBody.temperature != null) responsesReq.temperature = originalBody.temperature;
    if (originalBody.top_p != null) responsesReq.top_p = originalBody.top_p;

    // stop
    if (originalBody.stop != null) responsesReq.stop = originalBody.stop;

    // reasoning_effort → reasoning
    const effort = originalBody.reasoning_effort || originalBody.reasoningEffort;
    if (typeof effort === 'string' && effort.trim()) {
        responsesReq.reasoning = { effort: effort.trim() };
    }

    // response_format → text.format
    const textFormat = transformResponseFormat(originalBody.response_format);
    if (textFormat) responsesReq.text = textFormat;

    return responsesReq;
}

/**
 * 生成多个请求变体，提高上游兼容性
 *
 * 参考 any-api: providers/openai.ts → responsesReqVariants()
 * 当上游返回 400/422 时，自动尝试下一种变体格式
 */
function buildRequestVariants(responsesReq) {
    const variants = [];
    const base = { ...responsesReq };
    variants.push(base);

    // 变体1：max_output_tokens → max_tokens（部分供应商使用旧字段名）
    if (base.max_output_tokens != null) {
        const v = { ...base };
        delete v.max_output_tokens;
        v.max_tokens = base.max_output_tokens;
        variants.push(v);
    }

    // 变体2：instructions 内联到 input 中作为 developer 消息
    if (typeof base.instructions === 'string' && base.instructions.trim() && Array.isArray(base.input)) {
        const v = { ...base };
        delete v.instructions;
        v.input = [{ role: 'developer', content: [{ type: 'input_text', text: base.instructions }] }, ...base.input];
        variants.push(v);

        // 组合变体：内联 instructions + max_tokens
        if (base.max_output_tokens != null) {
            const v2 = { ...v };
            delete v2.max_output_tokens;
            v2.max_tokens = base.max_output_tokens;
            variants.push(v2);
        }
    }

    // 变体3：reasoning 字段格式差异（reasoning.effort vs reasoning_effort）
    if (base.reasoning && typeof base.reasoning === 'object' && base.reasoning.effort) {
        const effort = base.reasoning.effort;

        // reasoning_effort 顶层字符串
        const v1 = { ...base, reasoning_effort: effort };
        delete v1.reasoning;
        variants.push(v1);

        // 无 reasoning 参数
        const v2 = { ...base };
        delete v2.reasoning;
        delete v2.reasoning_effort;
        variants.push(v2);
    }

    // 去重
    const seen = new Set();
    return variants.filter((v) => {
        const key = JSON.stringify(v);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 响应体转换（Responses API → Chat Completions）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 Responses API 的 output 数组中提取文本内容
 */
function extractTextContent(upstreamJson) {
    // 快捷字段
    if (typeof upstreamJson.output_text === 'string') return upstreamJson.output_text;

    // 标准结构：output[n].content[m].text
    if (Array.isArray(upstreamJson.output)) {
        const parts = [];
        for (const item of upstreamJson.output) {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const c of item.content) {
                    if (c && c.type === 'output_text' && typeof c.text === 'string') {
                        parts.push(c.text);
                    }
                }
            }
        }
        if (parts.length) return parts.join('');
        return JSON.stringify(upstreamJson.output);
    }

    return JSON.stringify(upstreamJson);
}

/**
 * 从 Responses API 的 output 数组中提取工具调用
 *
 * 参考 any-api: providers/openai.ts → extractToolCallsFromResponsesResponse()
 */
function extractToolCalls(upstreamJson) {
    const out = [];
    if (!upstreamJson || typeof upstreamJson !== 'object') return out;
    if (!Array.isArray(upstreamJson.output)) return out;

    const seen = new Set();
    for (const item of upstreamJson.output) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call') {
            const callId = item.call_id ?? item.id ?? '';
            if (!callId || seen.has(callId)) continue;
            seen.add(callId);
            out.push({
                id: callId,
                type: 'function',
                function: {
                    name: item.name || '',
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                },
            });
        }
    }
    return out;
}

/**
 * 将 Responses API 的 usage 字段映射为 Chat Completions 规范
 */
function mapUsageFields(rawUsage = {}) {
    return {
        prompt_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0,
        completion_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0,
        total_tokens: rawUsage.total_tokens ?? 0,
    };
}

/**
 * 将 Responses API 的完整响应 JSON 转换为标准 Chat Completions 响应体
 */
function buildChatCompletionsResponse(upstreamJson, originalBody) {
    const text = extractTextContent(upstreamJson);
    const toolCalls = extractToolCalls(upstreamJson);

    const message = {
        role: 'assistant',
        content: text || null,
    };
    if (toolCalls.length) {
        message.tool_calls = toolCalls;
    }

    // 判断结束原因
    let finishReason = 'stop';
    if (toolCalls.length) finishReason = 'tool_calls';

    return {
        id: upstreamJson.id ?? 'chatcmpl-' + crypto.randomUUID(),
        object: 'chat.completion',
        created: upstreamJson.created_at ?? upstreamJson.created ?? Math.floor(Date.now() / 1000),
        model: originalBody.model ?? upstreamJson.model ?? 'unknown',
        choices: [
            {
                index: 0,
                message,
                logprobs: null,
                finish_reason: finishReason,
            },
        ],
        usage: mapUsageFields(upstreamJson.usage),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 流式（SSE）响应处理 — Responses API SSE → Chat Completions SSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 SSE 文本中的事件帧
 */
function parseSseLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let event = '';
    let dataLines = [];

    const flush = () => {
        if (!event && !dataLines.length) return;
        out.push({ event: event || 'message', data: dataLines.join('\n') });
        event = '';
        dataLines = [];
    };

    for (const line of lines) {
        if (line === '') { flush(); continue; }
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue; }
    }
    flush();
    return out;
}

/**
 * 将上游 Responses API 的 SSE 流实时转换为 Chat Completions chunk 格式
 *
 * 参考 any-api: protocols/stream.ts 的事件解析逻辑
 *
 * 支持的 Responses API 事件类型：
 *   - response.output_text.delta  → 文本增量
 *   - response.function_call_arguments.delta → 工具调用参数增量
 *   - response.completed → 结束事件
 *   - response.created → 开始事件（提取 response ID）
 */
function responseSseToChunkStream(upstreamBody, model) {
    if (!upstreamBody) return null;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '';
    const chatId = 'chatcmpl-' + crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);

    // 用于追踪工具调用流式状态
    const toolCallIndexMap = new Map(); // call_id → index
    let toolCallIdx = 0;

    return new ReadableStream({
        async start(controller) {
            const reader = upstreamBody.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const idx = buffer.lastIndexOf('\n\n');
                    if (idx < 0) continue;

                    const chunkText = buffer.slice(0, idx + 2);
                    buffer = buffer.slice(idx + 2);

                    for (const evt of parseSseLines(chunkText)) {
                        const data = evt.data;
                        if (data === '[DONE]') continue;

                        let payload;
                        try { payload = JSON.parse(data); } catch { continue; }

                        const evtType = payload?.type;

                        // ── 文本增量 ──
                        if (evtType === 'response.output_text.delta' && typeof payload.delta === 'string') {
                            const chunk = {
                                id: chatId,
                                object: 'chat.completion.chunk',
                                created,
                                model: model || 'unknown',
                                choices: [{
                                    index: 0,
                                    delta: { content: payload.delta },
                                    finish_reason: null,
                                }],
                            };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            continue;
                        }

                        // ── 工具调用参数增量 ──
                        if (evtType === 'response.function_call_arguments.delta') {
                            const callId = payload.call_id ?? payload.id ?? '';
                            const name = payload.name ?? '';
                            const argsDelta = typeof payload.delta === 'string' ? payload.delta : '';

                            if (callId) {
                                let idx;
                                if (toolCallIndexMap.has(callId)) {
                                    idx = toolCallIndexMap.get(callId);
                                } else {
                                    idx = toolCallIdx++;
                                    toolCallIndexMap.set(callId, idx);
                                }

                                const delta = {
                                    tool_calls: [{
                                        index: idx,
                                        ...(name ? { id: callId, type: 'function', function: { name, arguments: argsDelta } } : { function: { arguments: argsDelta } }),
                                    }],
                                };

                                const chunk = {
                                    id: chatId,
                                    object: 'chat.completion.chunk',
                                    created,
                                    model: model || 'unknown',
                                    choices: [{
                                        index: 0,
                                        delta,
                                        finish_reason: null,
                                    }],
                                };
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            }
                            continue;
                        }

                        // ── 完成事件：发送 finish_reason ──
                        if (evtType === 'response.completed') {
                            const hasToolCalls = toolCallIndexMap.size > 0;
                            const finishChunk = {
                                id: chatId,
                                object: 'chat.completion.chunk',
                                created,
                                model: model || 'unknown',
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                                }],
                            };

                            // 如果响应中有 usage，附加上去
                            if (payload.response && payload.response.usage) {
                                finishChunk.usage = mapUsageFields(payload.response.usage);
                            }

                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
                            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            continue;
                        }

                        // ── 文本完成事件（降级）──
                        if (evtType === 'response.output_text.done' && typeof payload.text === 'string') {
                            // 已通过 delta 事件处理过了，一般不需要额外写入
                            continue;
                        }
                    }
                }

                // 如果流正常结束但没有收到 response.completed，手动发送 [DONE]
                const finalChunk = {
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model: model || 'unknown',
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: toolCallIndexMap.size > 0 ? 'tool_calls' : 'stop',
                    }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (err) {
                console.error('[Worker] SSE 转换出错:', err);
            } finally {
                reader.releaseLock();
                controller.close();
            }
        },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 上游请求发送与多变体重试
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 向上游发送请求，支持多变体重试
 * 当上游返回 400/422 时，自动尝试下一个变体
 *
 * 参考 any-api: providers/openai.ts → selectUpstreamResponse()
 */
async function sendWithRetry(upstreamUrl, headers, variants) {
    let lastStatus = 502;
    let lastError = null;

    for (let i = 0; i < variants.length; i++) {
        const body = JSON.stringify(variants[i]);

        let resp;
        try {
            resp = await fetch(upstreamUrl, {
                method: 'POST',
                headers,
                body,
            });
        } catch (err) {
            return { ok: false, status: 502, error: `上游请求失败: ${err.message}` };
        }

        // 成功
        if (resp.ok) return { ok: true, resp };

        // 记录错误
        lastStatus = resp.status;
        lastError = await resp.text().catch(() => '');

        // 400/422 可能是格式不兼容，尝试下一个变体
        if ((resp.status === 400 || resp.status === 422) && i + 1 < variants.length) {
            console.log(`[Worker] 变体 ${i} 返回 ${resp.status}，尝试变体 ${i + 1}`);
            continue;
        }

        // 其他错误或最后一个变体，直接返回
        break;
    }

    return { ok: false, status: lastStatus, error: lastError };
}

// ─────────────────────────────────────────────────────────────────────────────
// 非流式模式下从 SSE 流中缓冲收集完整响应
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 某些供应商即使非流式请求也返回 SSE 流。
 * 此函数从 SSE 流中收集所有文本增量和工具调用，组装为完整的 Responses API JSON。
 *
 * 参考 any-api: providers/openai.ts → extractFromResponsesSseText()
 */
async function collectSseToJson(response) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();

    // 如果是标准 JSON 响应，直接解析
    if (ct.includes('application/json')) {
        return await response.json();
    }

    // SSE 流响应，需要缓冲收集
    const body = response.body;
    if (!body) return null;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let raw = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
    }

    // 尝试直接解析为 JSON（非 SSE 情况）
    try {
        return JSON.parse(raw);
    } catch {
        // 继续按 SSE 解析
    }

    // 从 SSE 事件中提取内容
    let text = '';
    let responseId = null;
    let model = null;
    let createdAt = null;
    let usage = null;
    const toolCalls = [];
    let sawDelta = false;

    const lines = raw.split('\n');
    for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        const evt = payload?.type;

        if (evt === 'response.created' && payload?.response) {
            responseId = payload.response.id || responseId;
            model = payload.response.model || model;
            createdAt = payload.response.created_at || createdAt;
            continue;
        }

        if (evt === 'response.output_text.delta' && typeof payload.delta === 'string') {
            sawDelta = true;
            text += payload.delta;
            continue;
        }

        if (!sawDelta && evt === 'response.output_text.done' && typeof payload.text === 'string') {
            text += payload.text;
            continue;
        }

        if (evt === 'response.function_call_arguments.delta') {
            const callId = payload.call_id ?? payload.id ?? '';
            const name = payload.name ?? '';
            const argDelta = typeof payload.delta === 'string' ? payload.delta : '';
            if (callId) {
                // 追加到已有的工具调用或创建新的
                const existing = toolCalls.find((tc) => tc.call_id === callId);
                if (existing) {
                    existing.arguments += argDelta;
                } else {
                    toolCalls.push({ call_id: callId, name, arguments: argDelta });
                }
            }
            continue;
        }

        if (evt === 'response.completed' && payload?.response) {
            responseId = payload.response.id || responseId;
            usage = payload.response.usage || usage;

            // 如果没通过 delta 收到文本，从 completed 事件中提取
            if (!text) {
                text = extractTextContent(payload.response);
            }
            continue;
        }
    }

    // 组装为类 Responses API 的 JSON 结构
    const output = [];
    if (text) {
        output.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
        });
    }
    for (const tc of toolCalls) {
        output.push({
            type: 'function_call',
            call_id: tc.call_id,
            name: tc.name,
            arguments: tc.arguments,
        });
    }

    return {
        id: responseId || `resp_${Date.now().toString(36)}`,
        object: 'response',
        created_at: createdAt || Math.floor(Date.now() / 1000),
        model: model || '',
        output,
        usage: usage || undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker 入口
// ─────────────────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        // ── CORS 预检 ──
        if (request.method === 'OPTIONS') {
            return corsPreflightResponse();
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // ── 健康检查 ──
        if (request.method === 'GET' && (path === '/health' || path === '/v1/health' || path === '/')) {
            return jsonResponse({ ok: true, time: Math.floor(Date.now() / 1000) });
        }

        // ── GET /v1/models 透传 ──
        if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            const base = (env.TARGET_URL || 'https://api.openai.com/v1/responses')
                .replace(/\/v1\/responses.*$/, '')  // 去掉 /v1/responses 及之后的部分
                .replace(/\/responses.*$/, '');      // 兼容其他路径结尾
            const modelsUrl = `${base}/v1/models`;
            const authHeader = request.headers.get('Authorization') || '';
            let resp;
            try {
                resp = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { 'Authorization': authHeader },
                });
            } catch (err) {
                return jsonResponse({ error: { message: `上游请求失败: ${err.message}` } }, 502);
            }
            return new Response(resp.body, {
                status: resp.status,
                headers: {
                    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ── 仅接受 POST ──
        if (request.method !== 'POST') {
            return new Response('Only POST requests are supported', { status: 405 });
        }

        // ── Responses API 直接透传 ──
        if (path === '/v1/responses' || path === '/openai/v1/responses') {
            const upstreamUrl = env.TARGET_URL || 'https://api.openai.com/v1/responses';
            const authHeader = request.headers.get('Authorization') || '';
            let resp;
            try {
                resp = await fetch(upstreamUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': authHeader,
                    },
                    body: request.body,
                });
            } catch (err) {
                return jsonResponse({ error: { message: `上游请求失败: ${err.message}` } }, 502);
            }
            // 透传原始响应（含流式 SSE）
            return new Response(resp.body, {
                status: resp.status,
                headers: {
                    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ── 路径检查（Chat Completions）──
        if (path !== '/v1/chat/completions' && path !== '/chat/completions') {
            return jsonResponse({ error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
        }

        try {
            // ── 1. 解析客户端请求体 ──
            const originalBody = await request.json();

            // ── 2. 转换请求体 Chat Completions → Responses API ──
            const responsesReq = buildResponsesApiRequest(originalBody);
            const isStream = Boolean(originalBody.stream);

            // ── 3. 构建多变体请求 ──
            const variants = buildRequestVariants(responsesReq);

            // ── 4. 确定上游地址与鉴权 ──
            const upstreamUrl = env.TARGET_URL || 'https://api.openai.com/v1/responses';
            const authHeader = request.headers.get('Authorization') || '';

            const headers = {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
            };

            // ── 5. 发送请求（含多变体重试） ──
            const result = await sendWithRetry(upstreamUrl, headers, variants);

            if (!result.ok) {
                // 尝试解析错误为 JSON
                let errorBody;
                try { errorBody = JSON.parse(result.error); } catch { errorBody = { error: { message: result.error } }; }
                return jsonResponse(errorBody, result.status);
            }

            const upstreamResponse = result.resp;

            // ── 6a. 流式响应 ──
            if (isStream) {
                const stream = responseSseToChunkStream(upstreamResponse.body, originalBody.model);
                return new Response(stream, {
                    headers: {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }

            // ── 6b. 非流式响应 ──
            const upstreamJson = await collectSseToJson(upstreamResponse);
            if (!upstreamJson) {
                return jsonResponse({ error: { message: '上游返回空响应' } }, 502);
            }

            const chatResponse = buildChatCompletionsResponse(upstreamJson, originalBody);
            return jsonResponse(chatResponse);

        } catch (err) {
            console.error('[Worker] 未捕获异常:', err);
            return jsonResponse({ error: { message: err.message || '内部错误', type: 'server_error' } }, 500);
        }
    },
};
