# 演示素材录制

用真实 CLI 输出录制发布视频素材。不生成画面，不使用假造输出：每一帧都是 `ai` 在隔离沙箱里的真实运行结果。

## 依赖

```bash
brew install vhs      # 声明式终端录制，输出 mp4/gif
```

## 录制

```bash
./demo/setup-demo-env.sh                 # 建沙箱 + 起本地 mock 上游
vhs demo/tapes/01-status.tape            # 竖屏 1080x1120，小红书
vhs demo/tapes/02-fallback.tape          # 横屏 1440x1000，B站/YouTube
vhs demo/tapes/03-doctor.tape            # 横屏 1440x700
./demo/setup-demo-env.sh stop            # 停掉 mock 上游
```

产物在 `demo/out/`，每条 tape 同时输出 `.mp4` 和末帧 `.png`（截图可直接当封面）。

## 沙箱如何保证不泄露

`setup-demo-env.sh` 把一切限制在 `/tmp/axiom-demo`：

| 风险 | 处理 |
|---|---|
| 真实 provider 域名 / API Key | 三个 provider 指向 `127.0.0.1` 上的 `mock-upstream.mjs`，Key 是 `sk-demo-*` 占位值 |
| 真实用量与会话历史 | `usage.json` 用构造数据，`sessions.json` 为空 |
| 家目录路径出现在 `ai doctor` | `PATH` 指向 `/tmp/axiom-demo/bin` 下的 stub CLI，输出显示 `/tmp/...` 而非 `/Users/<name>/...` |
| shell 提示符带用户名 | tape 在 `Hide` 段内把 `PS1` 改成 `$ ` |
| 生产服务器 IP、真实中转站名 | 沙箱与仓库配置完全无关，录制前用 grep 扫过 |

录制前后都不会读写你真实的 `~/.ai-gateway/`。

## provider 分级设计

| provider | level | mock 行为 | 用途 |
|---|---|---|---|
| `demo-fast` | 1 | 固定返回 502 | 演示默认 provider 挂掉 |
| `demo-main` | 2 | 正常返回模型目录 | 降级后的承接者 |
| `demo-backup` | 3 | 正常，`mode: ask` | 展示 ask 模式与第二层降级 |

`ai status` 会真的发 HTTP 请求刷新健康度，所以画面里的 `health:error` 和 `502 Bad Gateway` 是真实的网络结果。

## 已知限制

**`ai use claude` 不能用于无人值守录制。** 它会 spawn 真实的 Claude Code TUI，接管终端并卡在自己的 API key 确认页，录不到 fallback 输出。`02-fallback.tape` 因此改用 `ai provider list` + `ai status` 讲同一件事。

如果要拍运行时 fallback 的文字链（`Provider demo-main unavailable, fallback to demo-backup`），需要人工录屏，或在非交互模式下驱动：

```bash
AI_GATEWAY_HOME=/tmp/axiom-demo perl -e 'alarm 12; exec @ARGV' ai use claude </dev/null
```

注意这条链条里 `demo-fast` 是被健康检查**提前跳过**的，`demo-main` 是执行期失败后才降级到 `demo-backup` —— 讲解时是两层不同机制，别说成一层。

**Telegram Bot 需要真机录屏。** 进度消息在同一条消息里实时更新（`ProgressReporter` 默认 1500ms 节流）是最有观赏性的部分，VHS 覆盖不到。录制时需人工核对：bot 用户名、你的 Telegram 昵称与头像、群组名、消息里出现的绝对路径、Bot 回复中可能带出的服务器路径。
