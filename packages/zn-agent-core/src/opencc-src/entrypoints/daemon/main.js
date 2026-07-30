/**
 * Entrypoint for `opencc daemon <sub>`. Routes to:
 * - install/uninstall/start/stop/restart → daemon-install.ts (launchd plist)
 * - run → daemon.ts (the supervisor itself)
 * - status → daemonStatus() (4-state detection)
 *
 * Called by src/entrypoints/cli.tsx:268 after `enableConfigs()` + `initSinks()`.
 * Stub (throw-noop) form was injected by scripts/build.ts:171 when the file
 * did not exist; this is the real implementation for the open build.
 */
import {
  installPlist,
  uninstallPlist,
  startPlist,
  stopPlist,
  restartPlist,
} from '../../cli/handlers/daemon-install.js'
import {
  runSupervisor,
} from '../../cli/handlers/daemon.js'
import {
  getBgDaemonStatus,
  formatBgDaemonStatus,
} from '../../cli/handlers/daemonStatus.js'

const USAGE = `Usage: opencc daemon <sub>

Subcommands:
  install     Write launchd plist and bootstrap the agent
  uninstall   Bootout the agent and remove the plist
  start       kickstart -k (restart if running)
  stop        SIGTERM the running supervisor
  restart     stop + start
  run         Run the supervisor in the foreground (for debugging)
  status      Show 4-state daemon status (running / not running / installed-but-down / not installed)
  --json      (status only) emit JSON instead of human-readable text
  --help      Show this usage

macOS only — on Linux/Windows these subcommands return an error
explaining that the daemon runs on demand instead.
`

export async function daemonMain(args) {
  const sub = args[0]
  const rest = args.slice(1)

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(USAGE)
    return
  }

  switch (sub) {
    case 'install':
      return runOrExit(installPlist, 'install')
    case 'uninstall':
      return runOrExit(uninstallPlist, 'uninstall')
    case 'start':
      return runOrExit(startPlist, 'start')
    case 'stop':
      return runOrExit(stopPlist, 'stop')
    case 'restart':
      return runOrExit(restartPlist, 'restart')
    case 'run':
      return runSupervisor({})
    case 'status': {
      const json = rest.includes('--json')
      const status = await getBgDaemonStatus()
      if (json) {
        console.log(JSON.stringify(status, null, 2))
      } else {
        console.log(formatBgDaemonStatus(status))
      }
      return
    }
    default:
      console.error(`opencc daemon: unknown subcommand '${sub}'`)
      console.error(USAGE)
      process.exit(1)
  }
}

async function runOrExit(fn, name) {
  try {
    const result = await fn()
    if (result && result.ok === false) {
      console.error(`opencc daemon ${name}: ${result.error ?? 'failed'}`)
      process.exit(1)
    }
    // Successful daemon operation: print nothing extra
  } catch (err) {
    console.error(`opencc daemon ${name}: ${err.message}`)
    process.exit(1)
  }
}
