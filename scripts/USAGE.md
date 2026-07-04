# Scripts Usage

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
