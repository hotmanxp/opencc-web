import { getCwd } from './utils/cwd.ts'
import { isDirEmpty } from './utils/file.ts'
import { getFsImplementation } from './utils/fsOperations.ts'
import { FALLBACK_PROJECT_INSTRUCTION_FILE, findProjectInstructionFilePathInAncestors } from './utils/projectInstructions.ts'

export type Step = {
  key: string
  text: string
  isComplete: boolean
  isCompletable: boolean
  isEnabled: boolean
}

export function getSteps(): Step[] {
  const hasRepoInstructions =
    findProjectInstructionFilePathInAncestors(
      getCwd(),
      getFsImplementation().existsSync,
    ) !== null
  const isWorkspaceDirEmpty = isDirEmpty(getCwd())

  return [
    {
      key: 'workspace',
      text: 'Ask OpenCC to create a new app or clone a repository',
      isComplete: false,
      isCompletable: true,
      isEnabled: isWorkspaceDirEmpty,
    },
    {
      key: 'claudemd',
      text: `Set up repo instructions (/init creates AGENTS.md or updates existing ${FALLBACK_PROJECT_INSTRUCTION_FILE}; either file counts)`,
      isComplete: hasRepoInstructions,
      isCompletable: true,
      isEnabled: !isWorkspaceDirEmpty,
    },
  ]
}

export function isProjectOnboardingComplete(): boolean {
  return getSteps()
    .filter(({ isCompletable, isEnabled }) => isCompletable && isEnabled)
    .every(({ isComplete }) => isComplete)
}
