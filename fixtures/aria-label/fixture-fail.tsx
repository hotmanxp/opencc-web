// 违规 fixture: 期望审计报错
import { Button, Modal, Switch, Select } from 'antd'

export function FailExample() {
  return (
    <>
      {/* 违规: 纯图标 Button 无 aria-label */}
      <Button icon={<span>X</span>} />
      {/* 违规: 裸 input */}
      <input type="text" />
      {/* 违规: 裸 Switch */}
      <Switch />
      {/* 违规: 裸 Select */}
      <Select />
      {/* 违规: Modal 无 title 也无 aria-label */}
      <Modal open={false} />
    </>
  )
}