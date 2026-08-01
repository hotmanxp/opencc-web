import { isManagedChild, sendToSupervisor } from '../../../src/cli/managedChild.js'

if (isManagedChild()) {
  sendToSupervisor({ type: 'ready', pid: process.pid, port: 0 })
  process.on('message', (msg: { type?: string }) => {
    if (msg?.type === 'restart') {
      sendToSupervisor({ type: 'restarted' })
      process.exit(0)
    }
  })
} else {
  process.exit(1)
}