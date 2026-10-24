# 千问（阿里）网关模型清单与传参规则

千问网关把自家 Qwen 与三方 DeepSeek / GLM / Kimi / MiniMax 模型挂在**同一个 Chat Completions 端点**上，
调用方式完全一致，但**每个模型族的思考参数名与档位不同**。传错参数会直接 400，传错模型 ID 会 404 或
AccessDenied.Unpurchased。本文件是 anyway2codex 内置千问 provider 的事实来源，全部结论来自官方文档 + 实测。

## 两种计费模式

| 模式 | Base URL | Key 形态 | 说明 |
|------|----------|----------|------|
| Token Plan（个人版订阅） | https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1 | sk-sp-… | 订阅内含固定模型集，含 auto 路由 |
| 按量付费 PAYG | https://maas.qianwenaiapi.com/compatible-mode/v1 | sk-ws-… | /models 有 176 个，面板只暴露已核实的常用模型 |

代理用 baseUrl 是否含 token-plan、Key 前缀是 sk-sp 还是 sk-ws 推断当前模式（detectQwenAccess），
面板的模型下拉会**按模式过滤**；在「Provider 凭据」里点历史记录的「用这一条」即可一键回切，无需重启。

## 模型清单（已核实）

| 模型 ID | 面板调用名 | Token Plan | 按量付费 | 视觉 | 思考模式 | reasoning_effort 档位 | 上下文 / 最大输入 / 最大输出 |
|---------|-----------|-----------|---------|------|---------|----------------------|------------------------------|
| qwen3.8-max | qwen3.8-max | 是 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K |
| qwen3.8-flash | qwen3.8-flash | 是 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K（思考预算上限 256K） |
| qwen3.7-max | qwen3.7-max | 是 | 是 | **不支持** | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K |
| qwen3.7-plus | qwen3.7-plus | 是 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K |
| qwen3.7-flash | qwen3.7-flash | 否 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K |
| qwen3.6-flash | qwen3.6-flash | 是 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 65K（思考预算上限 128K） |
| qwen3.8-omni-flash | qwen3.8-omni-flash | 否 | 是 | 支持 | 可开关 | low/medium/high/xhigh | 1M / 991K / 131K（全模态：视觉+音频+视频） |
| glm-5.3 | glm-5.3 / qwen/glm-5.3 | 是 | 是 | 不支持 | **仅思考** | low/high/max（默认 max） | 1M / 1M / 131K |
| glm-5.2 | glm-5.2 / qwen/glm-5.2 | 是 | 是 | 不支持 | 可开关 | high/max | 1M / 1M / 131K |
| deepseek-v4-pro | deepseek-v4-pro / qwen/deepseek-v4-pro | 是 | 是 | 不支持 | 可开关 | high/max | 1M / 1M / 393K |
| deepseek-v4-pro-0813 | 同上 + -0813 | 是 | 是 | 不支持 | 可开关 | low/high/max | 1M / 1M / 393K（快照版，不出现在 /models 但可调用） |
| deepseek-v4-flash-0731 | qwen/deepseek-v4-flash-0731 | 是 | 是 | 不支持 | 可开关 | low/high/max | 1M / 1M / 393K |
| deepseek-v4.1-flash | qwen/deepseek-v4.1-flash | 是 | 是 | **支持** | 可开关 | low/high/max | 1M / 1M / 393K |
| kimi-k3 | kimi-k3 / qwen/kimi-k3 | 否 | 是 | 支持 | 可开关 | low/high/max（不支持 thinking_budget） | 1M / 1M / 1M |
| kimi-k2.7-code | qwen/kimi-k2.7-code | 团队版 | 是 | 支持 | **仅思考** | 不传 | 262K / 229K / 16K |
| MiniMax-M2.5 | qwen/MiniMax-M2.5 | 团队版 | 是 | 不支持 | **仅思考** | 不传 enable_thinking / reasoning_effort | 204K / 196K / 32K |
| auto | qwen/auto（面板隐藏） | 是 | 否 | 视所选 | 不保证 | 不传 | 平台自动选路，思考参数与结果模型不保证生效 |

团队版 Token Plan 额外包含 qwen3.6-plus、kimi-k2.7-code、kimi-k2.6、kimi-k2.5、glm-5.1、glm-5、MiniMax-M2.5。

## 三方模型的归属规则

同一个 glm-5.3 既能走智谱官方、也能走千问网关。代理按**原生 provider 优先**路由：

- Codex 里写 glm-5.3 → 走智谱 provider（有智谱 Key 时）；没有智谱 Key 才落到千问。
- 想强制走千问网关，用带前缀的调用名：qwen/glm-5.3、qwen/deepseek-v4.1-flash、qwen/kimi-k3。
- 面板里千问卡片上的三方模型会标成 hosted 标签，并显示真实的 routeName。

## 思考参数怎么写才不 400

| 模型族 | 开关 | 档位字段 | 坑 |
|--------|------|---------|----|
| Qwen（qwen3.x） | enable_thinking: true/false | reasoning_effort: low/medium/high/xhigh | 传 max / ultra 直接 400；reasoning_effort 与 thinking_budget 不能同时传 |
| GLM | glm-5.2 可开关；glm-5.3 **只能 true** | high/max（5.3 另有 low） | glm-5.3 传 enable_thinking=false 会 400 |
| DeepSeek | enable_thinking: true/false | pro 用 high/max；快照版用 low/high/max | — |
| Kimi | k3 可开关；k2.7-code 只能 true | k3 用 low/high/max | k3 不支持 thinking_budget |
| MiniMax-M2.5 | 无开关 | 无 | 两个字段都别传 |

另外两条全局规则：

- **tool_choice: "required" 或绑定具体函数的对象，在思考模式下会 400**。代理自动降级为省略该字段（等价网关默认 auto）并写日志。
- 流式请求必须同时带 stream_options.include_usage，否则 400；代理只在 stream: true 时才补。

Codex 的 model_reasoning_effort 是 GPT 语义（minimal/low/medium/high/xhigh/max/ultra），代理按上表把每个档位
映射到该模型真正接受的写法，所以面板改主模型不需要改 Codex 配置。

## 图片与多模态

- 支持视觉的模型（见上表「视觉」列）直接收 image_url，代理不会做 OCR。
- 不支持视觉的模型收到图片时，代理按「视觉回退」策略临时改用同族支持图片的模型处理这一轮，下一轮再回到原模型，
  保证图片不被静默丢弃；回退事件在请求日志里可见。

## 已验证与未验证

- 已实测：Token Plan 清单 17 条、按量付费清单 176 条与上表 access 标记逐条一致；qwen3.8-flash / glm-5.2 /
  qwen3.7-plus / deepseek-v4.1-flash 的工具调用、思考回传、识图（1px 红图答 Red）全部通过。
- 未实测：按量付费 Key 当前对该账号所有模型返回 403 AccessDenied.Unpurchased（未开通），所以 PAYG 行是按官方
  /models 清单 + 文档标注，而不是真实调用验证。开通后无需改代码，面板切凭据即可。

## 资料来源

- https://platform.qianwenai.com/docs/api-reference/chat/openai-chat
- https://platform.qianwenai.com/docs/guides/text-generation/thinking
- https://platform.qianwenai.com/docs/token-plan/overview 、/token-plan/personal
- https://www.qianwenai.com/models/<model-id>
- 抓取原文留档：D:/anyway2codex/.tmp/qwen-docs/，两份 /models 清单留档 .tmp/models-token_plan.json、.tmp/models-payg.json
