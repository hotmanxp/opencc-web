#!/usr/bin/env node
/**
 * Release script for the zai monorepo.
 *
 * Flow:
 *   1. Working tree must be clean (excluding the package.json files we are
 *      about to bump).
 *   2. Bump version in each workspace package.json (lockstep — patch/minor/
 *      major applied to both @zn-ai/zn-agent-core and @zn-ai/zai).
 *   3. Dry-run pre-flight: pack each package against the registry using the
 *      bumped version, fail fast on auth/network/registry errors.
 *   4. Build all packages in dependency order (agent-core first, then zai).
 *   5. Publish each package in the same order.
 *   6. Commit the version bump with `chore(release): vX.Y.Z` and create an
 *      annotated `vX.Y.Z` tag. Tag is NOT pushed — left to the user.
 *
 * Usage:
 *   pnpm release:patch
 *   pnpm release:minor
 *   pnpm release:major
 *
 * Env overrides:
 *   RELEASE_TICKET_ID  — ticket prefix for the commit message
 *                        (default: HRMSV3-ZN-WEBSITE#668)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const bumpType = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/release.mjs <patch|minor|major>');
  process.exit(1);
}

const TICKET = process.env.RELEASE_TICKET_ID || 'HRMSV3-ZN-WEBSITE#668';

// Dependency order matters: @zn-ai/zai depends on @zn-ai/zn-agent-core,
// so agent-core must build/publish first so npm can resolve the dep.
const packages = [
  { name: '@zn-ai/zn-agent-core', path: 'packages/zn-agent-core' },
  { name: '@zn-ai/zai', path: 'packages/zai' },
];

const run = (cmd, label) => {
  console.log(`\n>>> ${label ?? cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

/**
 * Publish a package with pnpm, falling back to npm if pnpm fails with
 * ENEEDAUTH (known workspace auth issue — see AGENTS.md).
 *
 * Rationale: pnpm publish in a workspace context sometimes fails to
 * pass auth credentials for the second package, even though `npm whoami`
 * returns a valid user. `npm publish` in the package directory works
 * reliably. This fallback avoids blocking the release pipeline.
 */
const publish = (pkg) => {
  const label = `[publish] ${pkg.name}@${newVersion}`;
  const pnpmCmd = `pnpm --filter ${pkg.name} publish --no-git-checks`;
  console.log(`\n>>> ${label}`);
  try {
    execSync(pnpmCmd, { stdio: 'inherit' });
  } catch (e) {
    const stderr = (e.stderr ?? '').toString();
    const msg = (e.message ?? '').toString();
    if (stderr.includes('ENEEDAUTH') || msg.includes('ENEEDAUTH')) {
      console.log(`  pnpm publish failed with ENEEDAUTH — falling back to npm publish in ${pkg.path}`);
      // pnpm replaces `workspace:*` with the actual version on publish, but
      // npm does not. Without this replacement, the published package has a
      // broken `workspace:*` dependency that npm cannot resolve at install.
      const pkgJsonPath = resolve(pkg.path, 'package.json');
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const origDeps = {};
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        if (!pkgJson[section]) continue;
        origDeps[section] = { ...pkgJson[section] };
        for (const [name, ver] of Object.entries(pkgJson[section])) {
          if (ver === 'workspace:*' || ver.startsWith('workspace:')) {
            // Resolve the workspace version from the target package's package.json
            const targetPkg = packages.find(p => p.name === name);
            const targetVer = targetPkg
              ? JSON.parse(readFileSync(resolve(targetPkg.path, 'package.json'), 'utf-8')).version
              : newVersion;
            pkgJson[section][name] = targetVer;
            console.log(`  workspace:* -> ${targetVer} for ${name}`);
          }
        }
      }
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
      execSync(`cd ${resolve(pkg.path)} && npm publish --no-git-checks`, { stdio: 'inherit' });
      // Restore original package.json (workspace:* references)
      for (const [section, deps] of Object.entries(origDeps)) {
        pkgJson[section] = deps;
      }
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    } else {
      throw e;
    }
  }
};

const step = (n, label) => console.log(`\n=== [${n}/6] ${label} ===`);

// --- [1/6] working tree sanity check ---------------------------------------
step(1, 'working tree sanity check');
const status = execSync('git status --porcelain').toString();
// Allow only untracked entries; no modifications or staged changes.
const dirty = status
  .split('\n')
  .filter(Boolean)
  .filter((line) => !line.startsWith('??'));
if (dirty.length) {
  console.error('Working tree has uncommitted changes. Aborting:');
  console.error(dirty.join('\n'));
  process.exit(1);
}

// --- [2/6] bump versions (lockstep from max current version) --------------
// Read all current versions, take the max as the bump base, and rewrite every
// package.json to that single bumped value. This guarantees the two packages
// stay in lockstep even if they were desynced at the start.
step(2, `bump ${bumpType} on ${packages.length} packages`);
const currentVersions = packages.map((pkg) => {
  const pkgPath = resolve(pkg.path, 'package.json');
  const data = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return { name: pkg.name, path: pkg.path, data };
});

const cmp = (a, b) => {
  const av = a.split('.').map(Number);
  const bv = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
};
const baseVersion = currentVersions
  .map((p) => p.data.version)
  .reduce((max, v) => (cmp(v, max) > 0 ? v : max));

const [maj, min, pat] = baseVersion.split('.').map(Number);
let newVersion;
if (bumpType === 'patch') newVersion = `${maj}.${min}.${pat + 1}`;
else if (bumpType === 'minor') newVersion = `${maj}.${min + 1}.0`;
else newVersion = `${maj + 1}.0.0`;

console.log(`  base versions: ${currentVersions.map((p) => `${p.name}@${p.data.version}`).join(', ')}`);
console.log(`  max base:      ${baseVersion}`);
console.log(`  target:        ${newVersion}`);

for (const { path, data, name } of currentVersions) {
  data.version = newVersion;
  writeFileSync(resolve(path, 'package.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`  ${name} -> ${newVersion}`);
}

// --- [3/6] pre-flight dry-run ---------------------------------------------
step(3, 'pre-flight dry-run');
for (const pkg of packages) {
  run(
    `pnpm --filter ${pkg.name} publish --dry-run --no-git-checks`,
    `[dry-run] ${pkg.name}@${newVersion}`,
  );
}

// --- [4/6] build ----------------------------------------------------------
step(4, 'build all packages');
run('pnpm build', 'pnpm build');

// --- [5/6] publish --------------------------------------------------------
step(5, 'publish to registry');
for (const pkg of packages) {
  publish(pkg);
}

// --- [6/6] commit + tag ---------------------------------------------------
step(6, 'commit + tag');
const commitMsg = `${TICKET} chore(release): v${newVersion}`;
run('git add packages/zn-agent-core/package.json packages/zai/package.json', 'git add');
run(`git commit -m ${JSON.stringify(commitMsg)}`, 'git commit');
run(`git tag -a v${newVersion} -m ${JSON.stringify(`release v${newVersion}`)}`, 'git tag');

console.log(`\nDONE. release v${newVersion} published.`);
console.log(`  commit: ${commitMsg}`);
console.log(`  tag:    v${newVersion} (not pushed — run \`git push && git push --tags\` when ready)`);