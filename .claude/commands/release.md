---
name: release-opencc
description: "Release opencc-web packages to npm: bump version, build, publish, commit and tag"
argument-hint:
  - <version_type>
---

# Release opencc-web

## Version Bump

**Type**: `{version_type=patch}`

升级类型(`scripts/release.mjs` 接管所有 bump/build/publish/commit+tag 工作,**禁止手写调用 `npm version` 或 `npm publish`**):

- `patch` (默认): 0.2.12 → 0.2.13
- `minor`: 0.2.12 → 0.3.0
- `major`: 0.2.12 → 1.0.0

发布入口(委托给 pnpm scripts,内部走 `node scripts/release.mjs <type>`):
```bash
pnpm release:{version_type}
```

## What the script does

`scripts/release.mjs <type>` 严格按以下顺序执行 6 步,**任一步失败立即 abort**:

1. **Working tree sanity check** — 拒绝任何 uncommitted 改动(untracked 文件除外),避免在脏树上发布。
2. **Bump** — 取两个 workspace(`@zn-ai/zn-agent-core`、`@zn-ai/zai`)当前版本的最大值作为基准,lockstep 升到目标版本,保证两包同步。
3. **Pre-flight dry-run** — 对每个包执行 `pnpm publish --dry-run`,提前暴露 auth/网络/registry 问题。
4. **Build** — `pnpm build`(按依赖顺序:zn-agent-core 先,zai 后)。
5. **Publish** — 按依赖顺序发布每个包。详见下方"已知坑点"。
6. **Commit + tag** — `chore(release): vX.Y.Z` 提交,打 `vX.Y.Z` 注释 tag。**tag 不会自动推送**。

## Known Pitfalls(脚本已内置处理,这里只是说明)

- **`pnpm publish` 在 workspace 下 auth 转发**:第二个包可能报 `ENEEDAUTH`,即使 `npm whoami` 正常。脚本捕获到该 marker 后自动降级到 `cd <pkg> && npm publish --no-git-checks`。
- **`workspace:*` 协议不被 `npm publish` 识别**:脚本在 publish 前把 `workspace:*` 临时替换为具体版本号,publish 后(无论成败)再 `finally` 还原为 `workspace:*`,保证 git 工作区不被污染。
- **Tag 不会自动推送**:发布成功只是 commit + 本地 tag,推送需要手动:
  ```bash
  git push && git push --tags
  ```
  推送前请确认远端保护分支设置(尤其 `main`)。

## Env overrides

- `RELEASE_TICKET_ID` — 自定义提交信息前缀,默认 `HRMSV3-ZN-WEBSITE#668`
  ```bash
  RELEASE_TICKET_ID=MY-TEAM#123 pnpm release:patch
  ```

## Post-release Checklist

1. 查看脚本输出的 `commit` / `tag` 行,确认是预期的 `vX.Y.Z`
2. 验证两个包已上线:
   ```bash
   npm view @zn-ai/zn-agent-core version
   npm view @zn-ai/zai version
   ```
3. 远端推送(在确认无误后):
   ```bash
   git push && git push --tags
   ```
