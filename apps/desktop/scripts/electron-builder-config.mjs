import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT, REPO_ROOT, desktopTargetPaths, resolveDesktopTarget } from './target.mjs'

/**
 * Create the electron-builder configuration for one target.
 *
 * The zai runtime is shipped through `extraResources`, not through the
 * application's `node_modules`: it is a separate process tree with its own
 * dependency graph, and keeping it outside `app.asar` leaves its native
 * modules (`sharp`, `node-pty`, vendored ripgrep) as ordinary loadable files
 * with no `asarUnpack` step.
 * @param {NodeJS.ProcessEnv} env - packaging environment; `ZAI_DESKTOP_TARGET` selects the target.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(env = process.env) {
  const target = resolveDesktopTarget(env.ZAI_DESKTOP_TARGET)
  const paths = desktopTargetPaths(target)
  const signingIdentity = env.ZAI_DESKTOP_MAC_SIGNING_IDENTITY
  const signedMac = target.platform === 'darwin' && signingIdentity !== undefined && signingIdentity !== ''
  if (target.platform !== 'darwin' && (signingIdentity !== undefined && signingIdentity !== '')) {
    throw new Error('desktop package: ZAI_DESKTOP_MAC_SIGNING_IDENTITY is only valid for macOS targets')
  }
  const bundledVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'zai', 'package.json'), 'utf8')).version
  // Whether the build host is the target platform. Cross-host packaging is
  // supported for Windows targets (electron-builder fetches the Windows
  // distribution and its own makensis), but every step that patches an
  // existing executable in place — fuse flipping, rcedit resource editing —
  // only works on the running platform and is therefore skipped off-host.
  const nativeHost = target.platform === process.platform

  return {
    appId: env.ZAI_DESKTOP_APP_ID ?? 'com.zn-ai.zai',
    productName: env.ZAI_DESKTOP_PRODUCT_NAME ?? 'zai',
    // The shell version tracks the zai release it bundles: a mismatched pair
    // would report a version whose web assets and runtime disagree.
    extraMetadata: { version: bundledVersion },
    artifactName: `zai-\${version}-\${os}-\${arch}.\${ext}`,
    directories: { output: paths.artifacts },
    // Reuse the distribution the `electron` devDependency already unpacked:
    // it is the same version the shell runs in development, and `@electron/get`
    // caches it under a checksum-named directory that electron-builder does not
    // read, so letting electron-builder fetch its own copy would download the
    // same ~130 MB archive a second time.
    // Native-host builds only. On a macOS host packaging `win-x64` that
    // directory holds the darwin build, and pointing electron-builder at it
    // would ship a macOS application inside a Windows installer; a cross build
    // must let electron-builder fetch the target's own distribution.
    //
    // `ZAI_DESKTOP_ELECTRON_DIST` overrides either way. A build host that
    // cannot reach electron's release CDN can unpack the target archive
    // elsewhere (or pre-seed the `@electron/get` cache) and point this at it,
    // keeping the download out of the packaging run entirely.
    electronDist:
      env.ZAI_DESKTOP_ELECTRON_DIST ??
      (nativeHost ? join(APP_ROOT, 'node_modules', 'electron', 'dist') : undefined),
    asar: true,
    // The child process runs zai through the Electron binary with
    // ELECTRON_RUN_AS_NODE=1. The fuse is enabled by default, but this design
    // depends on it, so it is pinned rather than inherited.
    electronFuses: nativeHost ? { runAsNode: true } : undefined,
    // The shell has no production dependencies of its own; everything zai needs
    // is deployed into `zai-runtime` and copied as a resource.
    npmRebuild: false,
    files: [
      'lib/main.js',
      'renderer/**/*',
      'package.json',
    ],
    extraResources: [
      { from: paths.runtime, to: 'zai-runtime', filter: ['**/*'] },
      // electron-builder drops a copied source directory's root node_modules,
      // so the dependency tree needs its own mapping.
      { from: join(paths.runtime, 'node_modules'), to: 'zai-runtime/node_modules', filter: ['**/*'] },
    ],
    mac: {
      icon: join(APP_ROOT, 'resources', 'icon.png'),
      category: 'public.app-category.developer-tools',
      target: ['dmg', 'zip'],
      // `null` disables signing. Development and internal builds rely on this;
      // a real release sets ZAI_DESKTOP_MAC_SIGNING_IDENTITY.
      identity: signedMac ? signingIdentity : null,
      forceCodeSigning: signedMac,
      hardenedRuntime: signedMac,
      notarize: signedMac && env.ZAI_DESKTOP_NOTARIZE === '1',
    },
    dmg: { sign: signedMac, writeUpdateInfo: false },
    win: {
      icon: join(APP_ROOT, 'resources', 'icon.ico'),
      // `portable` is the 绿色版: a single self-extracting exe that needs no
      // installer, no admin rights and writes nothing outside its own folder.
      // `nsis` stays for users who want an entry in the Start menu / uninstaller.
      target: ['nsis', 'portable'],
      forceCodeSigning: false,
      // Icon and version stamping run `rcedit`, a Windows binary that only
      // executes under Wine. A macOS host has no Wine, so the rewrite is
      // skipped there and the shipped exe keeps Electron's default icon and
      // version resource. Everything else — the app payload, the NSIS and
      // portable wrappers — is produced by native macOS tooling and is
      // unaffected.
      ...(nativeHost ? {} : { signAndEditExecutable: false }),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      // No update feed exists yet, so no differential package is produced.
      differentialPackage: false,
    },
    portable: {
      // 绿色版 by definition: unpack next to the exe, never into a temp dir
      // that the OS may clear, and never write an uninstaller.
      requestExecutionLevel: 'user',
      unpackDirName: 'zai',
      artifactName: `zai-\${version}-\${os}-\${arch}-portable.\${ext}`,
    },
    // No auto-update feed in this version; publishing stays disabled so a
    // packaging run never writes update metadata it cannot serve.
    publish: null,
    detectUpdateChannel: false,
  }
}
