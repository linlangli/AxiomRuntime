# 发布脚本使用说明

> 文档受众：中文发布与运维人员。AI 与维护者的发布规则以英文 `docs/CONVENTIONS.md` 为准。

## Release

交互式发布：

```bash
npm run release
```

首次发布仓库中已经设置好的当前版本（当前为 `0.0.1`）：

```bash
npm run release:current
```

`release:current` 不修改版本号或创建版本 commit；它会验证干净工作区、完整测试、npm tarball 和 Homebrew Formula，确认同名 tag 不存在后只创建当前版本 tag。

脚本会自动执行：

```text
检查 Git 工作区是否干净
选择 patch/minor/major
npm test
npm version --no-git-tag-version
npm run homebrew:update
npm run homebrew:check
npm pack --dry-run
创建版本 commit 和 tag
```

说明：

- 工作区不干净时会拒绝发布。
- 脚本只暂存 `package.json`、`package-lock.json` 和 Formula，并创建版本 commit/tag。
- 发布前会通过 `npm pack --dry-run` 展示将要发布的文件。
- 实际 npm/Homebrew 发布由 tag pipeline 完成，脚本不直接调用 `npm publish`。

## GitLab CI 自动发布

仓库包含 `.gitlab-ci.yml`，在 `main` 分支上的 commit 打 tag 后，会自动发布到 npm。

首次使用前，在 GitLab 项目里配置 CI/CD 变量：

```text
NPM_TOKEN=<你的 npm automation token>
HOMEBREW_TAP_PUSH_URL=https://gitlab-ci-token:${CI_JOB_TOKEN}@gitlab.com/linlangli/axiom.git
HOMEBREW_TAP_BRANCH=main
```

当前 GitLab 同项目 Tap 使用展开后的 `CI_JOB_TOKEN` URL 指向 `linlangli/axiom`，该变量需要启用变量引用展开，并在项目设置中启用 Job Token 仓库推送；URL 本身不保存长期秘密。若改用独立 Tap，目标仓库必须预先存在并至少包含目标分支，并使用受限、masked 的写入凭证。

发布流程会在 Linux 发布 runner 完成构建后重新生成并校验 `Formula/axiomruntime.rb` 的 URL/SHA256，将 Formula 作为 artifact 传给后续 Job；npm 发布成功后再用 registry tarball 二次验证并推送到 Tap。这样不会依赖 macOS 与 Linux 的 npm tarball 字节完全一致：

```bash
git switch main
git merge develop
npm run release:current # 首次发布已经设置好的 0.0.1
git push origin main --tags
```

后续版本将上述 `npm run release:current` 换成 `npm run release`，交互选择升级类型。

`npm run release` 会自动完成：

```text
升级 package.json 版本号
执行完整测试
更新并校验 Homebrew Formula URL/SHA256
创建版本 commit
创建 git tag，例如 v0.1.1
```

交互选择的版本类型：

```text
patch  # 0.0.1 -> 0.0.2，修复问题或小改动
minor  # 0.0.1 -> 0.1.0，新增兼容功能
major  # 0.0.1 -> 1.0.0，破坏性变更
```

规则：

- 只有 tag pipeline 会执行 npm 发布。
- tag 对应的 commit 必须在 `origin/main` 历史里。
- tag 版本必须和 `package.json` 的 `version` 一致，支持 `v0.0.1` 或 `0.0.1`。
- 发布前会执行 `npm test` 和 `npm pack --dry-run`。
- npm 发布成功后，CI 会从 registry 重新下载 tarball并验证 Formula SHA256；校验通过才推送 Homebrew Tap。

完整检查命令：

```bash
git status
git log --oneline --decorate -5
```

确认 tag 已生成：

```bash
git tag --list
```
