/**
 * New auto-update command using the nova-cli inspired auto-upgrade module
 * This is the primary entry point for auto-updates
 */

import chalk from 'chalk'
import { logEvent } from 'src/services/analytics/index.js'
import { getLatestVersion } from 'src/utils/autoUpdater.js'
import { regenerateCompletionCache } from 'src/utils/completionCache.js'
import {
  getGlobalConfig,
  type InstallMethod,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getDoctorDiagnostic } from 'src/utils/doctorDiagnostic.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import {
  getLocalInstallDir,
  installOrUpdateClaudePackage,
  localInstallationExists,
} from 'src/utils/localInstaller.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from 'src/utils/nativeInstaller/index.js'
import { getPackageManager } from 'src/utils/nativeInstaller/packageManagers.js'
import { writeToStdout } from 'src/utils/process.js'
import { gte } from 'src/utils/semver.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import {
  checkForUpdates,
  type UpdateObject,
} from 'src/utils/updateCheck.js'

/**
 * Check for updates using the new updateCheck module
 */
async function checkForUpdatesNew(): Promise<UpdateObject | null> {
  const packageName = MACRO.PACKAGE_URL
  const currentVersion = MACRO.VERSION

  if (!packageName || !currentVersion) {
    return null
  }

  return checkForUpdates(packageName, currentVersion)
}

/**
 * Update command using the new nova-cli inspired auto-upgrade module
 * Falls back to the original update logic if the new module fails
 */
export async function updateNew() {
  logEvent('tengu_update_check', {})
  writeToStdout(`Current version: ${MACRO.DISPLAY_VERSION}\n`)

  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
  writeToStdout(`Checking for updates to ${channel} version...\n`)

  logForDebugging('updateNew: Starting update check')

  // Run diagnostic to detect potential issues
  logForDebugging('updateNew: Running diagnostic')
  const diagnostic = await getDoctorDiagnostic()
  logForDebugging(`updateNew: Installation type: ${diagnostic.installationType}`)
  logForDebugging(
    `updateNew: Config install method: ${diagnostic.configInstallMethod}`,
  )

  // Check for multiple installations
  if (diagnostic.multipleInstallations.length > 1) {
    writeToStdout('\n')
    writeToStdout(chalk.yellow('Warning: Multiple installations found') + '\n')
    for (const install of diagnostic.multipleInstallations) {
      const current =
        diagnostic.installationType === install.type
          ? ' (currently running)'
          : ''
      writeToStdout(`- ${install.type} at ${install.path}${current}\n`)
    }
  }

  // Display warnings if any exist
  if (diagnostic.warnings.length > 0) {
    writeToStdout('\n')
    for (const warning of diagnostic.warnings) {
      logForDebugging(`updateNew: Warning detected: ${warning.issue}`)
      writeToStdout(chalk.yellow(`Warning: ${warning.issue}\n`))
      writeToStdout(chalk.bold(`Fix: ${warning.fix}\n`))
    }
  }

  // Update config if installMethod is not set (but skip for package managers)
  const config = getGlobalConfig()
  if (!config.installMethod && diagnostic.installationType !== 'package-manager') {
    writeToStdout('\n')
    writeToStdout('Updating configuration to track installation method...\n')
    let detectedMethod: 'local' | 'native' | 'global' | 'unknown' = 'unknown'

    switch (diagnostic.installationType) {
      case 'npm-local':
        detectedMethod = 'local'
        break
      case 'native':
        detectedMethod = 'native'
        break
      case 'npm-global':
        detectedMethod = 'global'
        break
      default:
        detectedMethod = 'unknown'
    }

    saveGlobalConfig(current => ({
      ...current,
      installMethod: detectedMethod,
    }))
    writeToStdout(`Installation method set to: ${detectedMethod}\n`)
  }

  // Check if running from development build
  if (diagnostic.installationType === 'development') {
    writeToStdout('\n')
    writeToStdout(
      chalk.yellow('You are running a development build — auto-update is unavailable.') + '\n',
    )
    writeToStdout('To update, pull the latest source and rebuild:\n')
    writeToStdout(chalk.bold('  git pull && bun install && bun run build') + '\n')
    writeToStdout('\n')
    writeToStdout('Or reinstall from npm:\n')
    writeToStdout(chalk.bold(`  npm install -g ${MACRO.PACKAGE_URL}@latest`) + '\n')
    await gracefulShutdown(0)
  }

  // Check if running from a package manager
  if (diagnostic.installationType === 'package-manager') {
    const packageManager = await getPackageManager()
    writeToStdout('\n')

    if (packageManager === 'homebrew') {
      writeToStdout('OpenCC is managed by Homebrew.\n')
      const latest = await getLatestVersion(channel)
      if (latest != null && !gte(MACRO.DISPLAY_VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.DISPLAY_VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        writeToStdout(chalk.bold('  brew upgrade claude-code') + '\n')
      } else {
        writeToStdout('OpenCC is up to date!\n')
      }
    } else if (packageManager === 'winget') {
      writeToStdout('OpenCC is managed by winget.\n')
      const latest = await getLatestVersion(channel)
      if (latest != null && !gte(MACRO.DISPLAY_VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.DISPLAY_VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        writeToStdout(chalk.bold('  winget upgrade Anthropic.ClaudeCode') + '\n')
      } else {
        writeToStdout('OpenCC is up to date!\n')
      }
    } else if (packageManager === 'apk') {
      writeToStdout('OpenCC is managed by apk.\n')
      const latest = await getLatestVersion(channel)
      if (latest != null && !gte(MACRO.DISPLAY_VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.DISPLAY_VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        writeToStdout(chalk.bold('  apk upgrade claude-code') + '\n')
      } else {
        writeToStdout('OpenCC is up to date!\n')
      }
    } else {
      writeToStdout('OpenCC is managed by a package manager.\n')
      writeToStdout('Please use your package manager to update.\n')
    }

    await gracefulShutdown(0)
  }

  // Handle native installation updates first
  if (diagnostic.installationType === 'native') {
    logForDebugging('updateNew: Detected native installation, using native updater')
    try {
      const result = await installLatestNative(channel, true)

      if (result.lockFailed) {
        const pidInfo = result.lockHolderPid ? ` (PID ${result.lockHolderPid})` : ''
        writeToStdout(
          chalk.yellow(
            `Another OpenCC process${pidInfo} is currently running. Please try again in a moment.`,
          ) + '\n',
        )
        await gracefulShutdown(0)
      }

      if (!result.latestVersion) {
        process.stderr.write('Failed to check for updates\n')
        await gracefulShutdown(1)
      }

      if (result.latestVersion === MACRO.DISPLAY_VERSION) {
        writeToStdout(
          chalk.green(`OpenCC is up to date (${MACRO.DISPLAY_VERSION})`) + '\n',
        )
      } else {
        writeToStdout(
          chalk.green(
            `Successfully updated from ${MACRO.DISPLAY_VERSION} to version ${result.latestVersion}`,
          ) + '\n',
        )
        await regenerateCompletionCache()
      }
      await gracefulShutdown(0)
    } catch (error) {
      process.stderr.write('Error: Failed to install native update\n')
      process.stderr.write(String(error) + '\n')
      process.stderr.write('Try running "opencc doctor" for diagnostics\n')
      await gracefulShutdown(1)
    }
  }

  // Get the latest version for comparison
  logForDebugging('updateNew: Getting latest version from npm registry')
  const latestVersion = await getLatestVersion(channel)

  if (!latestVersion) {
    logForDebugging('updateNew: Failed to get latest version from npm registry')
    process.stderr.write(chalk.red('Failed to check for updates') + '\n')
    await gracefulShutdown(1)
  }

  if (latestVersion === MACRO.DISPLAY_VERSION) {
    writeToStdout(chalk.green(`OpenCC is up to date (${MACRO.DISPLAY_VERSION})`) + '\n')
    await gracefulShutdown(0)
  }

  writeToStdout(`New version available: ${latestVersion} (current: ${MACRO.DISPLAY_VERSION})\n`)
  writeToStdout('Installing update...\n')

  // Remove native installer symlink if not using native installation
  if (config.installMethod !== 'native') {
    await removeInstalledSymlink()
  }

  // Determine update method
  let useLocalUpdate = false
  let updateMethodName = ''

  switch (diagnostic.installationType) {
    case 'npm-local':
      useLocalUpdate = true
      updateMethodName = 'local'
      break
    case 'npm-global':
    case 'pnpm-global':
      useLocalUpdate = false
      updateMethodName = 'global'
      break
    case 'unknown': {
      const isLocal = await localInstallationExists()
      useLocalUpdate = isLocal
      updateMethodName = isLocal ? 'local' : 'global'
      writeToStdout(chalk.yellow('Warning: Could not determine installation type') + '\n')
      writeToStdout(`Attempting ${updateMethodName} update based on file detection...\n`)
      break
    }
    default:
      process.stderr.write(`Error: Cannot update ${diagnostic.installationType} installation\n`)
      await gracefulShutdown(1)
  }

  writeToStdout(`Using ${updateMethodName} installation update method...\n`)

  let status

  if (useLocalUpdate) {
    logForDebugging('updateNew: Calling installOrUpdateClaudePackage() for local update')
    status = await installOrUpdateClaudePackage(channel)
  } else {
    logForDebugging('updateNew: Calling installGlobalPackage() for global update')
    // Import the original installGlobalPackage as fallback
    const { installGlobalPackage } = await import('src/utils/autoUpdater.js')
    status = await installGlobalPackage(latestVersion)
  }

  switch (status) {
    case 'success':
      writeToStdout(
        chalk.green(
          `Successfully updated from ${MACRO.DISPLAY_VERSION} to version ${latestVersion}`,
        ) + '\n',
      )
      await regenerateCompletionCache()
      break
    case 'no_permissions':
      process.stderr.write('Error: Insufficient permissions to install update\n')
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(`  cd ${getLocalInstallDir()} && npm update ${MACRO.PACKAGE_URL}\n`)
      } else {
        process.stderr.write('Try running with sudo or fix npm permissions\n')
        process.stderr.write('Or consider using native installation with: opencc install\n')
      }
      await gracefulShutdown(1)
      break
    case 'install_failed':
      process.stderr.write('Error: Failed to install update\n')
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(`  cd ${getLocalInstallDir()} && npm update ${MACRO.PACKAGE_URL}\n`)
      } else {
        process.stderr.write('Or consider using native installation with: opencc install\n')
      }
      await gracefulShutdown(1)
      break
    case 'in_progress':
      process.stderr.write('Error: Another instance is currently performing an update\n')
      process.stderr.write('Please wait and try again later\n')
      await gracefulShutdown(1)
      break
  }

  await gracefulShutdown(0)
}
