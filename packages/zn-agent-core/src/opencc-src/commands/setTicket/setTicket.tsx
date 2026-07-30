// @ts-nocheck
import { Box, Text } from '../../ink.js'
import React, { useState } from 'react'
import {
  Select,
  type OptionWithDescription,
} from '../../components/CustomSelect/select.js'
import {
  clearTicketId,
  setTicketId,
} from '../../state/setTicketStore.js'
import {
  pushTicketEntry,
  readTicketList,
} from '../../utils/tickets/persistence.js'
import { logForDebugging } from '../../utils/debug.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

const ID_RE = /^[\w-]+#\d+$/
const NEW_VALUE = '__new__'

async function finalize(
  onDone: LocalJSXCommandOnDone,
  id: string,
): Promise<void> {
  setTicketId(id)
  try {
    await pushTicketEntry(id)
  } catch (err) {
    logForDebugging(`set-ticket: persist failed: ${(err as Error)?.message ?? String(err)}`, { level: 'warn' })
  }
  onDone(`✓ Ticket ID: ${id}（mid-conv 切换需 /clear 后生效）`, {
    metaMessages: [
      `<system-reminder>Session ticket id is \`${id}\`. Prefix all git commits with it (e.g. \`${id} feat(login): xxx\`). Use \`/set-ticket clear\` to unbind.</system-reminder>`,
    ],
  })
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = (args ?? '').trim()

  if (trimmed === 'clear') {
    clearTicketId()
    onDone('✓ Ticket ID 已清除', {
      metaMessages: [
        '<system-reminder>Session ticket id cleared. No commit prefix required.</system-reminder>',
      ],
    })
    return null
  }

  if (trimmed !== '') {
    if (!ID_RE.test(trimmed)) {
      onDone('✗ 无效的 ticket id，正例：HRMSV3-ZN-WEBSITE#668')
      return null
    }
    await finalize(onDone, trimmed)
    return null
  }

  // 无参：TTY 路径渲染交互式选择器（REPL 通过 setToolJSX 挂载，提交后
  // 自动 unmount，processSlashCommand.tsx:612-639）。非 TTY 走文本提示。
  // 不要在 TTY 路径同步调 onDone —— 同步调用会立刻 unmount JSX。
  const list = await readTicketList()
  if (!process.stdout.isTTY) {
    const recent = list.slice(0, 4).join('\n  ') || '(无)'
    onDone(
      `最近使用过的 ID：\n  ${recent}\n\n请重新调用 /set-ticket <id>`,
    )
    return null
  }
  return (
    <TicketSelector
      recent={list.slice(0, 4)}
      onPicked={(picked) => finalize(onDone, picked)}
      onCancelled={() => onDone('✗ 已取消 ticket 选择')}
    />
  )
}

function TicketSelector({
  recent,
  onPicked,
  onCancelled,
}: {
  recent: string[]
  onPicked: (id: string) => Promise<void>
  onCancelled: () => void
}) {
  const [entered, setEntered] = useState('')

  const options: Array<OptionWithDescription<string>> = [
    ...recent.map(id => ({ label: id, value: id })),
    {
      label: '输入新 ID…',
      value: NEW_VALUE,
      type: 'input',
      onChange: (val: string) => setEntered(val),
      placeholder: '如 HRMSV3-ZN-WEBSITE#668',
    },
  ]

  const handleSelect = async (val: string) => {
    if (val === NEW_VALUE) {
      const candidate = entered.trim()
      if (!ID_RE.test(candidate)) {
        // 输入空或非法 ID：必须调 onDone 才能让 JSX 卸载（不能 silent return），
        // 并把无效原因传到 user bubble，给用户明确反馈。
        onDone(`✗ 无效的 ticket id（输入为空或格式不符），正例：HRMSV3-ZN-WEBSITE#668`)
        return
      }
      await onPicked(candidate)
      return
    }
    await onPicked(val)
  }

  return (
    <Box flexDirection="column">
      <Text>选择 Ticket ID（上下键移动，回车确认，Tab 切换到输入框，Esc 取消）：</Text>
      <Select<string> options={options} onChange={handleSelect} onCancel={onCancelled} />
    </Box>
  )
}
