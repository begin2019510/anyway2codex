# anyway2codex

本地模型代理 + Web 管理面板：让 Codex CLI / Desktop 不改客户端就接入国内大模型（千问、MiMo、DeepSeek、智谱、Kimi 等），
同时**保留 Codex 原有的 ChatGPT 官方登录**，随时一键切回正版 OpenAI。

面板地址：http://127.0.0.1:8800/admin

## 它解决什么

- Codex 只说 Responses API，国产模型只说 Chat Completions：代理做双向翻译，覆盖流式 SSE、工具调用、思考内容回传。
- 模型 ID、端点、思考参数极易触发 400：provider 适配层按官方文档与实测固化，千问清单见 docs/qwen-models.md。
- 换模型要重启 Codex：开启“代理控制主模型”后面板改主模型 / fallback 立即生效，Codex 的 model 字段只是占位符。
- 想切回官方 GPT 却丢登录：切到 OpenAI 直连只改 config.toml，**完全不写 auth.json**，OAuth 登录原样保留。

## 功能

- 协议翻译：Responses 与 Chat Completions 互转，流式实时转换、SSE 心跳保活、自动上下文压缩、混合模式思考补齐。
- Provider 适配：MiMo / 千问 / DeepSeek / 智谱 / Kimi 内置，另支持任意 OpenAI 兼容端点（providers.json）。
- 主模型 + fallback：上游首包前失败自动切换备用模型；流已开始则明确报流错误，绝不伪造成功响应。
- 多模态：按模型标注视觉能力；不支持图片的模型触发视觉回退，图片数据不被静默丢弃。
- 凭据管理：Key 在 SQLite 内 AES-256 加密，历史 Base URL / Key 可查、可一键回切（例如千问 Token Plan 与按量付费）。
- 观测：按对话归组的请求日志、完整推理与工具调用过程、Token 精细化统计，便于核对上游账单。
- 安全切换：任何 Codex 配置写入前自动备份，面板可一键恢复。

## 快速开始

~~~ bash
npm install
npm run build
node dist/cli.js --port 8800 --verbose
~~~

或者直接双击 scripts/reload-proxy.vbs（拷到桌面就是「重启anyway2codex代理.vbs」）：
先构建，**构建失败就退出、绝不碰正在运行的 8800**；成功后只停监听 8800 的那个进程，
再以分离进程拉起（不随 Codex 关闭而死），最后轮询 /health 并弹窗汇报结果。

打开面板，在「模式切换」点「切换到国产模型」，代理写入 Codex 配置：

~~~ toml
model = "anyway2codex-auto"
model_provider = "anyway2codex-proxy"

[model_providers.anyway2codex-proxy]
name = "anyway2codex (local proxy)"
base_url = "http://127.0.0.1:8800/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 1
~~~

重启 Codex 或新建会话生效。之后换主模型只在面板里操作，不需要再动这个文件。
点「切换到 OpenAI 直连」会改回 model_provider = "openai" 并沿用现有 ChatGPT 登录，请求不再经过代理。

## 目录

~~~ text
src/translate/   Responses 与 Chat 的翻译层（部分模块复用 sidecar 预编译产物并在构建时打补丁）
src/providers/   provider 适配与模型清单（千问清单见 docs/qwen-models.md）
src/codex/       config.toml / auth.json 读写与模式切换
src/backup/      切换前自动备份与恢复
src/web/         管理面板 API 与单页前端
src/db/          SQLite：请求日志、统计、设置、加密凭据
~~~

数据目录默认在 ~/.anyway2codex/（SQLite 与配置备份），可用 --data-dir 覆盖。

## 开发

~~~ bash
npm test           # vitest
npx tsc -p . --noEmit
npm run build      # tsc + postbuild
~~~

## 说明

- OpenAI 直连模式不经过代理，保证官方通道的原始兼容性。
- 面板与代理 API 只监听 127.0.0.1，不对外暴露。
- 本项目最初参照 mimo2codex 的翻译层实现，流式与请求翻译等模块复用其预编译产物，构建时按本仓库需要打补丁。
