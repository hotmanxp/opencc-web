import { useState } from 'react'
import { Radio, Checkbox, Tabs, Input, Button, Popconfirm, Tag, Typography } from 'antd'
import { linkifyText } from '../lib/linkify.js'

const { TextArea } = Input
const { Text } = Typography

export type QuestionCardProps = {
  questions: any[]
  answers: Record<string, string>
  annotations: Record<string, { notes?: string; otherText?: string }>
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
  onAnswer: (questionText: string, label: string) => void
  onNotesChange: (questionText: string, notes: string) => void
  // 'Other' 文本变更: 写到 annotations.otherText 而非 answers.
  // 设计动机见 useAgentStore.ts 里的 setAskOtherText 注释. 简要: answers
  // 必须始终保持 '__other__' 占位, 否则 Radio 模式下 isOtherSelected
  // 在打字瞬间变 false → Input 块卸载 → 焦点丢失并跳到附加说明 TextArea.
  onOtherChange: (questionText: string, text: string) => void
  onSubmit: () => void
  onReject: () => void
}

const PREVIEW_LIMIT = 200
const NOTES_MAX = 500
// 渲染"Other" 选项时附加的输入框 — AI 提示词里说 "Do not include an
// 'Other' option — the UI adds one automatically"。用户在该输入框里写的
// 文本会作为 answers[q.question] 的实际值(用户的真实回答),而不是
// 'Other' 这个 label。
const OTHER_OPTION_LABEL = 'Other'
const OTHER_OPTION_VALUE = '__other__'

function PreviewText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  if (text.length <= PREVIEW_LIMIT) {
    return (
      <pre style={{ fontSize: 11, margin: '4px 0 0 0', padding: '6px 8px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
        {text}
      </pre>
    )
  }
  return (
    <div>
      <pre style={{ fontSize: 11, margin: '4px 0 0 0', padding: '6px 8px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
        {expanded ? text : text.slice(0, PREVIEW_LIMIT) + '…'}
      </pre>
      <Button type="link" size="small" style={{ padding: 0, fontSize: 11 }} onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Show less' : 'Show more'}
      </Button>
    </div>
  )
}

/**
 * 单个问题面板的内容 (Radio / Checkbox + 附加说明).
 * 单问题直出 与 多问题 tab 共用同一份 UI.
 *
 * UI 在选项列表末尾自动追加一个 "Other" 选项 (per AskUserQuestion tool
 * prompt: "Do not include an 'Other' option — the UI adds one
 * automatically")。当选中 Other 时下方显示文本输入框,用户输入的文本直接
 * 成为 answers[q.question] 的最终值(代替 'Other' 这个 label)。
 *
 * Radio 模式下 Other 文本用组件本地 state `otherText` 维护 — 父组件只
 * 拿到"用户最终答案文本",不参与中间 Input 状态。父组件拿到的 answers
 * 值在没打字前是 OTHER_OPTION_VALUE(表示"已选 Other 但待输入"),打过
 * 字后被替换成实际文本。
 */
function QuestionPanel({
  q,
  answers,
  annotations,
  onAnswer,
  onNotesChange,
  onOtherChange,
}: {
  q: any
  answers: Record<string, string>
  annotations: Record<string, { notes?: string; otherText?: string }>
  onAnswer: (questionText: string, label: string) => void
  onNotesChange: (questionText: string, notes: string) => void
  onOtherChange: (questionText: string, text: string) => void
}) {
  const currentAnswer = answers[q.question]
  // 'Other' 选项的固定逻辑: answers 中始终保持 '__other__' 占位, 文本
  // 走 annotations.otherText。这样设计的原因是 — Radio 模式下, 如果把
  // 用户输入直接写进 answers, store 每次按键都更新, 父级 useAgentStore
  // 重新渲染 QuestionPanel, currentAnswer 立刻变成用户文本 (例如 'h'),
  // isOtherSelected (= currentAnswer === '__other__') 变 false, {isOtherSelected && ...}
  // 这块 Input 从 DOM 卸载, 焦点丢失并跳到下面 TextArea。
  // 修复后, 即使用户输入字符, answers 仍保持 '__other__', Input 块始终
  // 挂载, 焦点保留在 Other 文本框里。
  const isOtherSelected = currentAnswer === OTHER_OPTION_VALUE
  // Other 文本完全由父组件 store 维护 (单一数据源), 不再用 useState —
  // 之前 useState 的设计是让父组件不参与中间 Input 状态, 但这恰好是
  // 触发 bug 的根因 (父级重渲染 + isOtherSelected 变 false)。改成由
  // annotations.otherText 完全控制, React 重新挂载/卸载 Input 时永远
  // 拿到最新值, 不会再"丢失焦点"或在父级重渲染时丢失输入字符。
  const otherText = annotations[q.question]?.otherText ?? ''

  const handleRadioChange = (e: any) => {
    if (e.target.value === OTHER_OPTION_VALUE) {
      // 切到 Other: answers 设占位符 (永久保持); 清空 otherText (用户
      // 重新输入), 通知父组件 (经 onOtherChange 写 annotations.otherText)。
      onOtherChange(q.question, '')
      onAnswer(q.question, OTHER_OPTION_VALUE)
    } else {
      // 切走 Other: 清理 otherText (防止切回去时残留), 设真实答案。
      onOtherChange(q.question, '')
      onAnswer(q.question, e.target.value)
    }
  }

  // Checkbox 模式: answers 是 "label1, label2, __other__" 形式 (Other 永远在首项)。
  // 选中 Other 时右侧出 Input; 文本真实值就是 annotations.otherText。
  const selectedList = (currentAnswer ?? '').split(', ').filter(Boolean)
  const checkboxOtherActive = selectedList.includes(OTHER_OPTION_VALUE)

  return (
    <div>
      <Text strong style={{ color: '#1f1f1f' }}>{q.question}</Text>
      <div style={{ marginTop: 8 }}>
        {q.multiSelect ? (
          <>
            <Checkbox.Group
              value={selectedList}
              onChange={(vals) => {
                const list = vals as string[]
                onAnswer(q.question, list.join(', '))
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {q.options.map((opt: any) => (
                <Checkbox key={opt.label} value={opt.label}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{opt.label}</div>
                    {opt.description && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {linkifyText(opt.description)}
                      </Text>
                    )}
                    {opt.preview && <PreviewText text={opt.preview} />}
                  </div>
                </Checkbox>
              ))}
              <Checkbox key={OTHER_OPTION_VALUE} value={OTHER_OPTION_VALUE}>
                <div style={{ fontWeight: 500 }}>{OTHER_OPTION_LABEL}</div>
              </Checkbox>
            </Checkbox.Group>
            {checkboxOtherActive && (
              <div style={{ marginTop: 6, marginLeft: 24 }}>
                <Input
                  autoFocus
                  placeholder="请输入..."
                  value={otherText}
                  onChange={(e) => onOtherChange(q.question, e.target.value)}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <Radio.Group
              value={currentAnswer}
              onChange={handleRadioChange}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {q.options.map((opt: any) => (
                <Radio key={opt.label} value={opt.label}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{opt.label}</div>
                    {opt.description && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {linkifyText(opt.description)}
                      </Text>
                    )}
                    {opt.preview && <PreviewText text={opt.preview} />}
                  </div>
                </Radio>
              ))}
              <Radio key={OTHER_OPTION_VALUE} value={OTHER_OPTION_VALUE}>
                <div style={{ fontWeight: 500 }>{OTHER_OPTION_LABEL}</div>
              </Radio>
            </Radio.Group>
            {isOtherSelected && (
              <div style={{ marginTop: 6, marginLeft: 24 }}>
                <Input
                  autoFocus
                  placeholder="请输入..."
                  value={otherText}
                  onChange={(e) => onOtherChange(q.question, e.target.value)}
                />
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12, color: '#595959' }}>附加说明 (可选)</Text>
        <TextArea
          rows={2}
          maxLength={NOTES_MAX}
          value={annotations[q.question]?.notes ?? ''}
          onChange={(e) => onNotesChange(q.question, e.target.value)}
          placeholder="补充任何额外信息..."
          style={{ marginTop: 4 }}
        />
      </div>
    </div>
  )
}

/**
 * Answer 是否算"已答完"。Radio 模式下选了 Other 但还没在文本框里写字
 * 的话,答案值仍是 OTHER_OPTION_VALUE 占位符 — 这种情况视作未答完, 必须
 * 看 annotations[q.question].otherText 才知道是否输入了真实文本 (since
 * 2026-07-20: answers 不再携带 Other 文本, 改存 annotations.otherText).
 * 单选 `__other__` 占位 + otherText 空 = 未答; 复选 `__other__, ...` =
 * 看 otherText 是否为空。
 */
function isAnswered(
  answer: string | undefined,
  annotations: Record<string, { notes?: string; otherText?: string }>,
  questionText: string,
): boolean {
  if (!answer) return false
  if (answer === OTHER_OPTION_VALUE) {
    // Radio 选 Other + 已输入文本 → 已答。
    return (annotations[questionText]?.otherText ?? '').trim().length > 0
  }
  // 复选: "__other__, userText" — 同样以 otherText 是否填了为标准
  // (answers 里不再嵌入文本)。其他真实选项 (A, B, ...) 直接算已答。
  if (answer.includes(OTHER_OPTION_VALUE)) {
    return (annotations[questionText]?.otherText ?? '').trim().length > 0
  }
  return true
}

/**
 * Review 面板 (只在多问题时通过 Tabs 展示)
 */
function ReviewPanel({
  questions,
  answers,
  annotations,
  allAnswered,
  status,
  onSubmit,
}: {
  questions: any[]
  answers: Record<string, string>
  annotations: Record<string, { notes?: string; otherText?: string }>
  allAnswered: boolean
  status: 'pending' | 'submitting' | 'error'
  onSubmit: () => void
}) {
  return (
    <div>
      {questions.map((q) => {
        const ans = answers[q.question]
        const otherText = annotations[q.question]?.otherText ?? ''
        let display: string
        if (!ans) {
          display = ''
        } else if (ans === OTHER_OPTION_VALUE || ans.includes(OTHER_OPTION_VALUE)) {
          // 显示 Other 文本(若有),用 "Other: xxx" 形式标记是自填项
          display = otherText ? `Other: ${otherText}` : 'Other(待填写)'
        } else {
          display = ans
        }
        return (
          <div key={q.question} style={{ marginBottom: 8 }}>
            <Text strong style={{ color: '#1f1f1f' }}>{q.question}</Text>
            <div style={{ marginTop: 2 }}>
              <Text style={{ color: '#1f1f1f' }}>{display || <Text type="secondary" style={{ color: '#8c8c8c' }}>未回答</Text>}</Text>
            </div>
            {annotations[q.question]?.notes && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2, color: '#595959' }}>
                备注: {annotations[q.question].notes}
              </Text>
            )}
          </div>
        )
      })}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button type="primary" disabled={!allAnswered || status === 'submitting'} onClick={onSubmit} loading={status === 'submitting'}>
          Submit answers
        </Button>
      </div>
    </div>
  )
}

export default function QuestionCard(props: QuestionCardProps) {
  const { questions, answers, annotations, status, errorMessage, onAnswer, onNotesChange, onOtherChange, onSubmit, onReject } = props
  const firstQuestion = questions[0]
  const [tabKey, setTabKey] = useState<string>(firstQuestion?.question ?? 'review')
  const allAnswered = questions.every((q) => isAnswered(answers[q.question], annotations, q.question))

  if (!firstQuestion) return null

  // 单问题: 不走 Tabs, 直接在最下面渲染 Submit
  if (questions.length === 1) {
    const q = firstQuestion
    return (
      <div
        className="question-card-scope"
        style={{
          margin: '12px 24px',
          padding: '12px 14px',
          background: '#fff0e2',
          borderLeft: '3px solid #ff6600',
          borderRadius: 6,
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <Text strong style={{ color: '#1f1f1f' }}>请回答以下问题</Text>
        </div>

        {status === 'error' && errorMessage && (
          <div style={{ marginBottom: 10, padding: '6px 10px', background: '#fff2f0', border: '1px solid #ff4d4f', borderRadius: 4 }}>
            <Text type="danger" style={{ fontSize: 12 }}>{errorMessage}</Text>
          </div>
        )}

        <div style={{ marginBottom: 6 }}>
          <Tag color="purple" style={{ marginRight: 4 }}>{q.header}</Tag>
          <span style={{ color: '#595959', marginLeft: 4 }}>
            {q.multiSelect ? '多选' : '单选'}
          </span>
        </div>

        <QuestionPanel
          q={q}
          answers={answers}
          annotations={annotations}
          onAnswer={onAnswer}
          onNotesChange={onNotesChange}
          onOtherChange={onOtherChange}
        />

        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Popconfirm title="确认取消?" onConfirm={onReject} okText="是" cancelText="否">
            <Button type="text" style={{ color: '#595959' }}>取消</Button>
          </Popconfirm>
          <Button type="primary" disabled={!allAnswered || status === 'submitting'} onClick={onSubmit} loading={status === 'submitting'}>
            Submit answers
          </Button>
        </div>
      </div>
    )
  }

  // 多问题: 走 Tabs + Review 流程
  return (
    <div
      className="question-card-scope"
      style={{
        margin: '12px 24px',
        padding: '12px 14px',
        background: '#fff0e2',
        borderLeft: '3px solid #ff6600',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text strong style={{ color: '#1f1f1f' }}>请回答以下问题</Text>
        <Popconfirm title="确认取消?" onConfirm={onReject} okText="是" cancelText="否">
          <Button size="small">取消</Button>
        </Popconfirm>
      </div>

      {status === 'error' && errorMessage && (
        <div style={{ marginBottom: 10, padding: '6px 10px', background: '#fff2f0', border: '1px solid #ff4d4f', borderRadius: 4 }}>
          <Text type="danger" style={{ fontSize: 12 }}>{errorMessage}</Text>
        </div>
      )}

      <Tabs
        activeKey={tabKey}
        onChange={setTabKey}
        items={[
          ...questions.map((q) => ({
            key: q.question,
            label: (
              <span>
                <Tag color="purple" style={{ marginRight: 4 }}>{q.header}</Tag>
                <span style={{ color: '#595959', marginLeft: 4 }}>
                  {q.multiSelect ? '多选' : '单选'}
                </span>
              </span>
            ),
            children: (
              <QuestionPanel
                q={q}
                answers={answers}
                annotations={annotations}
                onAnswer={onAnswer}
                onNotesChange={onNotesChange}
              />
            ),
          })),
          {
            key: 'review',
            label: 'Review',
            children: (
              <ReviewPanel
                questions={questions}
                answers={answers}
                annotations={annotations}
                allAnswered={allAnswered}
                status={status}
                onSubmit={onSubmit}
              />
            ),
          },
        ]}
      />
    </div>
  )
}