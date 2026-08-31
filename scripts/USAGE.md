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

- 检查 Node.js、Git、npm、GitLab CLI、GitLab 登录和 `NPM_TOKEN`
- 检查当前工作区是否干净
- 在临时目录读取远端 `main` 并合入当前提交，不切换用户工作区分支
- 以合并后的 `package.json` 为版本基准，提供 patch / minor / major 中文选项
- 运行 `npm ci`、完整测试和 `npm pack --dry-run`
- 创建中文 release commit 和 `v<version>` tag
- 二次确认后原子推送 `main` 与 tag
- 等待 GitLab tag pipeline 返回 npm 发布成功或失败

如果缺少 GitLab CLI，macOS 且已安装 Homebrew 时，助手可直接安装；如果没有登录，会启动登录向导。如果缺少 `NPM_TOKEN`，助手会打开 npm Token 页面和 GitLab CI 变量页面，并说明需要创建的变量名。

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

## 安全规则

- npm 发布 commit 必须进入远端 `main`，tag 版本必须等于 `package.json.version`。
- npm 发布由 GitLab CI 使用 masked `NPM_TOKEN` 执行，本地脚本不读取或打印 Token。
- Homebrew Formula 只使用 npm Registry 的公开 tarball，SHA256 从实际下载内容计算。
- 所有临时发布目录在流程结束后清理；用户工作区不会自动切换分支。
