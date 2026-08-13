# AxiomRuntime 视频脚本 · 素材清单与脱敏检查

两版视频共用同一批录屏素材。录制顺序无所谓，按编号对应到脚本里的位置。

---

## 素材清单

| 编号 | 内容 | 用在 | 时长 | 谁录 |
|---|---|---|---|---|
| A | Telegram 发消息 → 进度消息实时变化 → 出 diff | 小红书开场、B站 7:30 | 25s+ | 你 |
| B | `ai status` 三 provider，含 level 1 的 502 | 两版都用 | 12s | 已录 |
| C | `ai use claude` 降级过程 | 两版核心 | 15s | 你 |
| D | 两套配置文件分屏对照（`~/.claude/settings.json` vs `config.toml`） | B站 0:35 | 15s | 你 |
| E | `npm install` + `ai setup` | B站 2:10 | 20s | 你 |
| F | `ai provider list` | B站 3:20 | 10s | 已录 |
| G | Telegram `/usage`、`/pin` | B站 8:30 | 15s | 你 |

**B 和 F 已经录好**，在仓库 `demo/out/` 下（沙箱真实输出，无泄露），直接用或自己重录都行。录制方式见 `demo/README.md`。

---

## 脱敏检查清单

Telegram 素材（A、G）没有沙箱保护，**录完必须肉眼过一遍**：

- [ ] bot 用户名
- [ ] 你的 Telegram 昵称和头像
- [ ] 群组名
- [ ] 消息里出现的项目绝对路径
- [ ] Bot 回复里可能带出的服务器路径

终端素材（C、D、E）注意：

- [ ] shell 提示符里的用户名（把 `PS1` 改成 `$ `）
- [ ] 真实中转站域名、provider 名
- [ ] `providers.json` / 日志里的 API Key 指纹
- [ ] 生产服务器 IP（仓库 `README.md` 里有一个真实 IP，别录到）
- [ ] 终端标题栏的绝对路径

推荐用沙箱环境录制，一次性解决大部分风险：

```bash
./demo/setup-demo-env.sh          # 建沙箱 + 起本地 mock 上游
# 录制...
./demo/setup-demo-env.sh stop     # 停掉 mock
```