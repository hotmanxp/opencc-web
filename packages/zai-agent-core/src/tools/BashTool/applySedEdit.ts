/**
 * sed -i 编辑模拟 (对标 opencc `tools/BashTool/BashTool.tsx:466-526`)。
 *
 * 权限弹窗批准后, 直接写入 newContent 到 filePath, 跳过真跑 sed —
 * 保证用户预览的 diff 与实际写入完全一致。
 */
import { stat as fsStat } from 'node:fs/promises'

export type SimulatedSedEditInput = {
  filePath: string
  newContent: string
}

export type SimulatedSedEditResult = {
  stdout: string
  stderr: string
  interrupted: boolean
}

export class SedEditFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`sed: ${filePath}: No such file or directory`)
    this.name = 'SedEditFileNotFoundError'
  }
}

export async function applySedEdit(input: SimulatedSedEditInput): Promise<SimulatedSedEditResult> {
  const { filePath, newContent } = input

  try {
    await fsStat(filePath)
  } catch {
    throw new SedEditFileNotFoundError(filePath)
  }

  const fs = await import('node:fs/promises')
  await fs.writeFile(filePath, newContent, 'utf8')

  return {
    stdout: '',
    stderr: '',
    interrupted: false,
  }
}