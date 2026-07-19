import { useState } from 'react'
import { Radio, Checkbox, Tabs, Input, Button, Popconfirm, Tag, Typography } from 'antd'
import { linkifyText } from '../lib/linkify.js'

const { TextArea } = Input
const { Text } = Typography

export type QuestionCardProps = {
  questions: any[]
  answers: Record<string, string>
  annotations: Record<string, { notes?: string }>
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
  onAnswer: (questionText: string, label: string) => void
  onNotesChange: (questionText: string, notes: string) => void
  onSubmit: () => void
  onReject: () => void
}

const PREVIEW_LIMIT = 200
const NOTES_MAX = 500

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
 */
function QuestionPanel({
  q,
  answers,
  annotations,
  onAnswer,
  onNotesChange,
}: {
  q: any
  answers: Record<string, string>
  annotations: Record<string, { notes?: string }>
  onAnswer: (questionText: string, label: string) => void
  onNotesChange: (questionText: string, notes: string) => void
}) {
  return (
    <div>
      <Text strong style={{ color: '#1f1f1f' }}>{q.question}</Text>
      <div style={{ marginTop: 8 }}>
        {q.multiSelect ? (
          <Checkbox.Group
            value={(answers[q.question] ?? '').split(', ').filter(Boolean)}
            onChange={(vals) => onAnswer(q.question, (vals as string[]).join(', '))}
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
          </Checkbox.Group>
        ) : (
          <Radio.Group
            value={answers[q.question]}
            onChange={(e) => onAnswer(q.question, e.target.value)}
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
          </Radio.Group>
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
  annotations: Record<string, { notes?: string }>
  allAnswered: boolean
  status: 'pending' | 'submitting' | 'error'
  onSubmit: () => void
}) {
  return (
    <div>
      {questions.map((q) => (
        <div key={q.question} style={{ marginBottom: 8 }}>
          <Text strong style={{ color: '#1f1f1f' }}>{q.question}</Text>
          <div style={{ marginTop: 2 }}>
            <Text style={{ color: '#1f1f1f' }}>{answers[q.question] || <Text type="secondary" style={{ color: '#8c8c8c' }}>未回答</Text>}</Text>
          </div>
          {annotations[q.question]?.notes && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2, color: '#595959' }}>
              备注: {annotations[q.question].notes}
            </Text>
          )}
        </div>
      ))}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button type="primary" disabled={!allAnswered || status === 'submitting'} onClick={onSubmit} loading={status === 'submitting'}>
          Submit answers
        </Button>
      </div>
    </div>
  )
}

export default function QuestionCard(props: QuestionCardProps) {
  const { questions, answers, annotations, status, errorMessage, onAnswer, onNotesChange, onSubmit, onReject } = props
  const firstQuestion = questions[0]
  const [tabKey, setTabKey] = useState<string>(firstQuestion?.question ?? 'review')
  const allAnswered = questions.every((q) => answers[q.question])

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