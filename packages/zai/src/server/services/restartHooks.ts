export type RestartHooksDeps = {
  agentActive: () => number
  backgroundActive: () => number
  abortAgent: () => void
  abortBackground: () => void
}

export type RestartHooks = {
  inFlightCount: () => number
  abortAll: () => number
}

export function createRestartHooks(deps: RestartHooksDeps): RestartHooks {
  return {
    inFlightCount: () => deps.agentActive() + deps.backgroundActive(),
    abortAll: () => {
      deps.abortAgent()
      deps.abortBackground()
      return 2
    },
  }
}
