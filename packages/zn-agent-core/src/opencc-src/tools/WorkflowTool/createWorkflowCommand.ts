import { isWorkflowsDisabled } from '../../utils/envUtils.ts'
import type { Command } from '../../types/command.ts'
import { getWorkflowRegistry } from './singleton.ts'
import type { Workflow } from './types.ts'

/**
 * Convert a loaded Workflow into a `type: 'prompt'` Command object so
 * the workflow shows up as `/<name>` in the TUI autocomplete. When
 * invoked, the prompt instructs the LLM to call the WorkflowTool with
 * the workflow's name and args.
 *
 * Note: this is intentionally an inline conversion (rather than reusing
 * `workflowFileToCommand` from `src/commands/workflows/workflowCommand.ts`)
 * because that helper takes a `filePath` and derives everything from
 * basename — useful for the future "register without loading" path, but
 * not a fit here where the registry has already loaded the Workflow and
 * knows its real description (or has explicitly marked it absent).
 */
export function workflowToCommand(workflow: Workflow): Command {
  const { name, description, source, whenToUse, hasUserSpecifiedDescription, script, pluginManifest, plugin } = workflow
  const desc = description ?? `Run workflow: ${name}`

  // Upstream `source` mapping (binary-verified, Jwq.createWorkflowCommand):
  //   H.source === 'built-in' ? 'bundled' : H.source
  // i.e. `'bundled'` becomes `'bundled'`, `'plugin'` becomes `'plugin'`,
  // and `'project'`/`'user'` pass through unchanged. The OpenCC Command
  // type only allows `'builtin'` today, so we cast for forward compat.
  const commandSource: 'bundled' | 'plugin' | 'project' | 'user' =
    source === 'bundled' ? 'bundled' : source === 'plugin' ? 'plugin' : source

  // Upstream `loadedFrom` (binary-verified, same call site):
  //   H.source === 'built-in' ? 'bundled' : H.source === 'plugin' ? 'plugin' : 'skills'
  // i.e. bundled/plugin keep identity, everything else collapses to
  // `'skills'`. We port this exactly — projects/user workflows show
  // up in the slash-command table as `loadedFrom: 'skills'`.
  const commandLoadedFrom: 'bundled' | 'plugin' | 'skills' =
    source === 'bundled' ? 'bundled' : source === 'plugin' ? 'plugin' : 'skills'

  return {
    type: 'prompt',
    name,
    description: desc,
    hasUserSpecifiedDescription: hasUserSpecifiedDescription ?? true,
    ...(whenToUse ? { whenToUse } : {}),
    progressMessage: 'running dynamic workflow',
    contentLength: script?.length ?? 0,
    // `commandSource` is `'bundled' | 'plugin' | 'project' | 'user'`,
    // all of which `Command.source` accepts. The previous
    // `as 'builtin'` cast hid 'project'/'user' from downstream
    // consumers — see formatDescriptionWithSource.
    source: commandSource,
    loadedFrom: commandLoadedFrom,
    // Upstream `pluginInfo: { pluginManifest: H.pluginManifest, repository: H.plugin }`
    // — built from the Workflow's top-level `pluginManifest` and `plugin`
    // fields, NOT from a nested `workflow.pluginInfo` field.
    // `Workflow.pluginManifest` is typed as `unknown` (intentionally
    // loose to accept plugin-defined schemas), while
    // `Command.pluginInfo.pluginManifest` is typed as the strict
    // `PluginManifest` shape. `as never` widens through `unknown` at
    // the assignment boundary without a forced `any`.
    ...(source === 'plugin' && (pluginManifest !== undefined || plugin !== undefined)
      ? { pluginInfo: { pluginManifest: pluginManifest as never, repository: plugin ?? '' } }
      : {}),
    kind: 'workflow',
    isHidden: false,
    async getPromptForCommand(args: string) {
      // Mirror the upstream 2.1.185 pattern in
      // src/commands/workflows/workflowCommand.ts workflowFileToCommand:
      // keep the raw CLI string instead of splitting into an array, so
      // the LLM reads the workflow script to learn the expected arg
      // shape, then forwards the raw string to the WorkflowTool. The
      // runtime parses CLI-style strings ("--name=ethan --word=hello
      // --verbose") into an object {name: 'ethan', word: 'hello',
      // verbose: true} before injecting into the script as the
      // `args` global.
      const r = args.trim()
      const nameJson = JSON.stringify(name)
      const argsJson = r ? JSON.stringify(r) : null
      const callShape = argsJson !== null
        ? `{ workflowName: ${nameJson}, args: ${argsJson}, description: "<one-line summary of the user's intent>" }`
        : `{ workflowName: ${nameJson}, description: "<one-line summary of the user's intent>" }`
      return [
        {
          type: 'text',
          text:
            `Run the "${name}" workflow.\n\n` +
            `Workflow script: \`${workflow.path}\` (${source}-scoped)\n\n` +
            `The user typed: ${r ? `\`${r}\`` : '(no args)'}\n\n` +
            `Read the workflow script first to learn what shape of ` +
            `\`args\` object the script expects (the keys it reads — ` +
            `you cannot know them without reading the source). The ` +
            `WorkflowTool accepts the raw CLI string and parses it at ` +
            `runtime into an object before injecting into the script.\n\n` +
            `Invoke: Workflow(${callShape})\n\n` +
            `The WorkflowTool result message includes the Run ID in ` +
            `the form \`(Run ID: wf_xxx)\`. The user's mental model ` +
            `depends on this — they correlate later results to the ` +
            `launch via Run ID, so paste the Run ID verbatim ` +
            `(do NOT paraphrase it as "wf_xxx" or "the run" — ` +
            `the exact token), followed by a one-line summary of ` +
            `the workflow's stages (read the workflow's description). ` +
            `Use your own voice; do not pad with greetings or ` +
            `follow-up questions. ` +
            `\n\n` +
            `When the run finishes, a system task-notification will ` +
            `arrive carrying the result. Treat that notification as ` +
            `a user message and produce a user-facing summary in ` +
            `response. The notification is the user's only signal ` +
            `that the workflow ended — without your summary they ` +
            `won't know the outcome.`,
        },
      ]
    },
  }
}

/**
 * Returns the user-workflow slash commands available in this build.
 *
 * Asks the WorkflowRegistry for the workflows visible in `cwd` and
 * converts each non-bundled one into a `type: 'prompt'` Command so it
 * shows up in the TUI's `/` autocomplete. The builtin `/workflows`
 * command (list/manage runs in this session) is NOT returned here —
 * it's a separate `local-jsx` command registered through the standard
 * src/commands/ scan path.
 *
 * Bundled workflows (e.g. /deep-research) are filtered out because
 * they have their own registration path via `registerBundled()` and
 * are surfaced through the WorkflowTool itself, not as slash commands.
 *
 * Kept in WorkflowTool/ (not commands/workflows/) so commands.ts can lazy-load
 * it the same way it lazy-loads other plugin/built-in command groups —
 * this lets the rest of the command resolution path stay synchronous while
 * the workflow runtime (worker threads, scheduler) is loaded on demand.
 */
export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  // Gate at the registry surface so OPENCC_DISABLE_WORKFLOWS / settings.workflows.disabled
  // hide user- and project-scoped workflows from the `/` autocomplete. The WorkflowTool
  // execution path has its own gate (WorkflowTool.ts) — this one stops them from
  // being listed AND triggered at all. Bundled workflows are filtered separately
  // (see the `source !== 'bundled'` check below) and are not affected here.
  if (isWorkflowsDisabled()) {
    return []
  }
  const registry = getWorkflowRegistry(cwd)
  // Force a fresh scan: the registry's cold-scan only fires when its
  // internal map is empty, but bundled workflows are registered at
  // construction time, so the map is never empty and user workflows
  // would otherwise be invisible. getWorkflowCommands runs once per
  // session (loadAllCommands is memoized by cwd), so the extra scan
  // cost is paid at most once.
  await registry.reload()
  const all = await registry.list()
  const userCommands = all
    .filter(w => w.source !== 'bundled')
    .map(workflowToCommand)
  return userCommands
}
