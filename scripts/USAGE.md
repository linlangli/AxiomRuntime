# 发布助手使用说明

> 文档受众：中文发布与运维人员。AI 与维护者的工程规则以英文 `AGENTS.md` 为准。

## 使用入口

macOS 直接双击仓库根目录的 `发布.command`。无需切换分支，也无需记住发布命令。

助手提供三个操作：

1. **发布新版本到 npm**
2. **把 npm 最新版本发布到 Homebrew Tap**
3. **检查 npm / Homebrew 发布条件和当前状态**

`npm run release` 仍可打开同一个菜单，供无法双击 `.command` 文件的平台使用。

## 发布 npm

助手会自动：

- 检查 Node.js、Git、npm、GitHub CLI `gh`、GitHub 登录和发布 workflow
- 检查当前工作区是否干净
- 在临时目录读取远端 `main` 并合入当前提交，不切换用户工作区分支
- 以合并后的 `package.json` 为版本基准，提供 patch / minor / major 中文选项
- 安装根目录与 `web` 依赖，运行完整测试、前端类型检查和 `npm pack --dry-run`
- 创建中文 release commit 和 `v<version>` tag
- 二次确认后原子推送 `main` 与 tag
- 等待当前 tag/commit 的 GitHub Actions `publish.yml` 返回 npm 发布成功或失败

如果缺少 GitHub CLI，macOS 且已安装 Homebrew 时，助手可直接安装；如果没有登录，会启动登录向导。`origin` 必须指向 `git@github.com:linlangli/AxiomRuntime.git`（也支持 HTTPS）。GitHub npm 发版使用 OIDC Trusted Publisher，无需 `NPM_TOKEN`：在 npm 包 Settings 绑定 `linlangli/AxiomRuntime`、`publish.yml`、`npm-production`，仅启用 `Allow npm publish`。workflow 使用 `npm@11.11.0` 和 `id-token: write` 获取短期发布凭证，并生成 provenance；助手只能检查 GitHub workflow，不能读取 npm 端信任状态。

npm 新连接若显示 `Pending validation`，须在 npm 页面指定截止时间前完成一次获准的新版本发布；保存连接和本地测试不能代替实际发布认证验证。

工作区不干净或合并 `main` 发生冲突时，助手不会自动覆盖内容，而是停止并提示先处理提交或冲突。

## 发布 Homebrew

Homebrew 只能发布 npm Registry 中已经存在的版本。助手会自动：

- 读取 `@offerpilot/axiomruntime` 的 npm `latest` 版本
- 下载 Registry tarball 并计算真实 SHA256
- 读取远端 `main` 中的 `Formula/axiomruntime.rb`
- 若 Formula 已同步则直接报告，无需重复发布
- 若未同步，则只更新 `homepage`、`url` 和 `sha256`，保留安装逻辑
- 运行 Ruby 语法检查（本机有 Ruby 时）
- 展示 diff 并二次确认后提交、推送 Homebrew Formula

Homebrew 发布不会创建 npm tag，也不会调用 `npm publish`。

Tap 安装入口为 `brew tap linlangli/axiom https://github.com/linlangli/AxiomRuntime.git`，然后执行 `brew install linlangli/axiom/axiomruntime`。

## CI 与门户部署

`.github/workflows/ci.yml` 使用 GitHub 托管 runner 测试 branch push 和 PR；默认分支测试成功后构建并部署门户。`.github/workflows/publish.yml` 只处理 `v*` tag。原 `.gitlab-ci.yml` 保留。当前不需要在服务器安装 Actions runner，也不自动部署 Runtime Docker 服务。

`portal-production` Environment 只允许 `main` branch；Variables/Secrets 的完整清单和迁移步骤见 [使用指南](../docs/usage.md#维护者发布与-ci-配置)。`npm-production` 只允许 `v*` tag。GitLab variables 不会随 Git push 迁移；门户使用专用部署 SSH key，禁止复用 root 私钥，保留严格主机公钥检查与健康检查失败回滚。

## 安全规则

- npm 发布 commit 必须进入远端 `main`，tag 版本必须等于 `package.json.version`。
- npm 发布由 GitHub Actions 使用 OIDC 短期凭证执行，不保存或读取长期 npm Token；原 GitLab CI 保留既有 `NPM_TOKEN` 机制。
- Homebrew Formula 只使用 npm Registry 的公开 tarball，SHA256 从实际下载内容计算。
- 所有临时发布目录在流程结束后清理；用户工作区不会自动切换分支。
