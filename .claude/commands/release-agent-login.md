---
name: release-agent-login
description: "Publish @zn-ai/agent-login to npm"
argument-hint:
  - [version]
---

## Mission: Release and Publish

Publish @zn-ai/agent-login package to internal npm registry.

## Workflow:

1. **Switch to Main branch and sync**:
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Enter agent-login directory**:
   ```bash
   cd packages/agent-login
   ```

3. **Check current version**:
   ```bash
   cat package.json | grep '"version"'
   ```

4. **Upgrade version** (use Edit tool):
   - Change `"version": "x.y.z"` to new version, e.g. `"version": "x.y.z+1"`
   - File path: `packages/agent-login/package.json`
   - Versioning policy:
     - `patch` (x.y.z+1): new model entries, bug fixes
     - `minor` (x.y+1.0): new auth platform or breaking feature
     - `major` (x+1.0.0): breaking config format / removed API

5. **Execute publish**:
   ```bash
   cd packages/agent-login
   npm publish
   ```

   This will automatically:
   - Run `prepublishOnly` hook: `npm run build && npm test`
   - Build TypeScript code to `dist/`
   - Run vitest test suite
   - Publish to internal npm registry (`maven.paic.com.cn`)

6. **Commit version bump**:
   ```bash
   cd /path/to/zn-agent-assets
   git add packages/agent-login/package.json
   git commit -m "HRMSV3-ZN-WEBSITE#668 chore(agent-login): bump version to <NEW_VERSION>"
   git push origin main
   ```

## Output Requirements:

Provide clear status updates:
1. Current branch and version
2. New version number
3. Build & test progress
4. npm publish confirmation
5. Push confirmation

## Notes:

- Use **Edit tool** to modify version number, avoid npm version stuck issue
- Requires npm account permissions
- Follow semantic versioning规范
- Internal registry: `http://maven.paic.com.cn/repository/npm/`
- Workspace package: `@zn-ai/agent-login`
- pre-publish checks: `npm run build && npm test` (auto via `prepublishOnly`)
