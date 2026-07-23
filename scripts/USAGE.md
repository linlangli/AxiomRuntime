# 发布脚本使用说明

> 文档受众：中文发布与运维人员。AI 与维护者的发布规则以英文 `docs/CONVENTIONS.md` 为准。

## Release

交互式发布：

```bash
npm run release
```

脚本会自动执行：

```text
检查 Git 工作区是否干净
选择 patch/minor/major
npm test
npm version
npm pack --dry-run
确认后 npm publish --access public
```

说明：

- 工作区不干净时会拒绝发布。
- `npm version` 会创建版本提交和 tag。
- 发布前会通过 `npm pack --dry-run` 展示将要发布的文件。
- 真正发布前会再次确认。

## GitLab CI 自动发布

仓库包含 `.gitlab-ci.yml`，在 `main` 分支上的 commit 打 tag 后，会自动发布到 npm。

首次使用前，在 GitLab 项目里配置 CI/CD 变量：

```text
NPM_TOKEN=<你的 npm automation token>
```

发布流程：

```bash
git switch main
git merge develop
npm version patch
git push origin main --tags
```

这是一种推荐发版方法。`npm version patch` 会自动完成：

```text
升级 package.json 版本号
创建版本 commit
创建 git tag，例如 v0.1.1
```

所以不需要再手动执行 `git tag`。

版本类型：

```bash
npm version patch  # 0.1.0 -> 0.1.1，修复问题或小改动
npm version minor  # 0.1.0 -> 0.2.0，新增兼容功能
npm version major  # 0.1.0 -> 1.0.0，破坏性变更
```

规则：

- 只有 tag pipeline 会执行 npm 发布。
- tag 对应的 commit 必须在 `origin/main` 历史里。
- tag 版本必须和 `package.json` 的 `version` 一致，支持 `v0.1.1` 或 `0.1.1`。
- 发布前会执行 `npm test` 和 `npm pack --dry-run`。

完整检查命令：

```bash
git status
git log --oneline --decorate -5
```

确认 tag 已生成：

```bash
git tag --list
```
