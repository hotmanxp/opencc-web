import { basename } from 'path'
import type { Command } from '../../types/command.js'

export type WorkflowSource = 'project' | 'user'

/**
 * Convert a workflow .js file path into a Command object so workflows show
 * up as `/<name>` slash commands.
 *
 * The `args` parameter to getPromptForCommand is the user's
 * natural-language description (the string after `/<name> ` in the
 * slash command, e.g. "对, 帮我 check 这个项目的所有 bug"). It is
 * NOT the CLI-format args that the workflow script receives.
 *
 * Per bbfbab56 (2026-06-22), the workflow runtime expects `args`
 * as a CLI-format string (e.g. `--name=ethan --verbose`). The
 * runtime CLI parser silently DROPS any positional/non-flag text
 * — so passing the raw user description through as `args` would
 * result in an empty parsed object (`{}`), and the script would
 * receive no parameters. (The exact contract is also in the
 * WorkflowTool tool schema description, so the prompt does not
 * duplicate the implementation path here.)
 *
 * Per `user-says-llm-decide-dont-pre-process-2026-06-21`, we do NOT
 * pre-construct the CLI args server-side. Instead we give the LLM:
 *   1. The user's natural-language description (what they want)
 *   2. The script path (so the LLM can read it to figure out
 *      which `--key` flags the script accepts)
 * and let the LLM construct the CLI-format string from #1 + #2.
 *
 * The callShape shows the FORMAT of args (CLI string), not the
 * user's description — so the LLM pattern-matches on the correct
 * shape instead of copy-pasting raw prose (which the parser would
 * silently drop).
 *
 * History: the previous version of this function (commits e4c404ba
 * through dcdaf6ef) mirrored upstream 2.1.185 verbatim and passed
 * the raw user input as `args`. That worked for upstream's
 * Anthropic-SDK model but failed for OpenCC's default MiniMax-M3
 * path: the LLM would copy-paste the raw prose as args, and the
 * CLI parser dropped everything → workflow scripts got `args = {}`.
 * This version fixes that by clearly separating the user's
 * description (informational) from the CLI args (constructed by
 * the LLM from the script's needs).
 */
export function workflowFileToCommand(
  filePath: string,
  source: WorkflowSource,
): Command {
  const name = basename(filePath, '.js')
  return {
    type: 'prompt',
    name,
    description: `Run workflow: ${name} from ${source}`,
    isHidden: false,
    source: 'builtin',
    progressMessage: `running workflow ${name}`,
    contentLength: 0,
    async getPromptForCommand(args: string) {
      // `r` is the user's natural-language description (the string
      // after `/<name> ` in the slash command). It is NOT the
      // CLI-format args that the workflow script receives — see the
      // header comment above.
      const r = args.trim()
      const nameJson = JSON.stringify(name)

      // Format example for the callShape — concrete enough that the
      // LLM pattern-matches on the shape, generic enough that it
      // cannot be copy-pasted literally as the final args. The LLM
      // is expected to substitute real `--key=value` pairs derived
      // from the script + the user's description.
      //
      // The callShape is identical regardless of whether the user
      // typed anything after `/<name> `: whether the script needs
      // args is determined by the SCRIPT (its meta + body), not by
      // user input. The LLM decides what to put in args based on
      // the script's actual needs — pass `""` if the script takes
      // no args, real `--key=value` pairs if it does. Showing two
      // different shapes based on `r` would mis-train the LLM to
      // treat user input as the signal for "does this script need
      // args?", which is backwards.
      const argsFormatExample = '"--<key>=<value> --<flag>"'
      const descriptionExample = '"<one-line summary of the user intent>"'
      const callShape = `{ workflowName: ${nameJson}, args: ${argsFormatExample}, description: ${descriptionExample} }`

      const descriptionSection = r
        ? `User's description (natural language — this is what the user typed after \`/${name} \`, NOT the args):\n\n\`\`\`\n${r}\n\`\`\`\n\n`
        : `(no description provided — the user invoked \`/${name}\` with no extra input)\n\n`

      return [
        {
          type: 'text',
          text:
            `Run the "${name}" workflow.\n\n` +
            `Workflow script: \`${filePath}\` (${source}-scoped)\n\n` +
            descriptionSection +
            `STEP 1 (REQUIRED — DO THIS FIRST): Read the workflow script at \`${filePath}\` ` +
            `BEFORE constructing \`args\`. The script's \`meta\` and top-level code define ` +
            `which \`--key\` flags it accepts — without reading it you are guessing, ` +
            `and the runtime parser will silently drop any non-\`--key=value\` text, ` +
            `so the script will receive \`args = {}\` and silently fail.\n\n` +
            `STEP 2: Construct \`args\` from the user's description above using CLI format ` +
            `(\`--key=value\` for string values, bare \`--flag\` for booleans). The runtime ` +
            `parser extracts only \`--key=value\` tokens and boolean flags; positional or ` +
            `non-flag text is silently dropped.\n\n` +
            `STEP 3: Invoke the workflow with the constructed args.\n\n` +
            `Invoke: Workflow(${callShape})`,
        },
      ]
    },
  }
}
