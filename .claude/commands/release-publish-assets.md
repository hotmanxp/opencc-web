---
name: release-publish-assets
description: "Publish @zn-ai/plugin to npm"
argument-hint:
  - [version]
---

## Mission: Release and Publish

Publish @zn-ai/plugin package to npm registry.

## Workflow:

1. **Switch to Main branch and sync**:
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Enter Publisher directory**:
   ```bash
   cd packages/publisher
   ```

3. **Check current version**:
   ```bash
   cat package.json | grep '"version"'
   ```

4. **Upgrade version** (use Edit tool):
   - Change `"version": "x.y.z"` to new version, e.g. `"version": "x.y.z+1"`
   - File path: `packages/publisher/package.json`

5. **Execute publish**:
   ```bash
   npm publish --workspace=@zn-ai/plugin
   ```

   This will automatically:
   - Build TypeScript code
   - Package assets
   - Publish to npm registry

## Output Requirements:

Provide clear status updates:
1. Current branch and version
2. New version number
3. Build progress
4. npm publish confirmation

## Notes:

- Use **Edit tool** to modify version number, avoid npm version stuck issue
- Requires npm account permissions
- Follow semantic versioning规范
- Use --workspace parameter to specify @zn-ai/plugin subpackage
