// 混合 fixture: 期望审计仅报最后一行违规
import { Button } from 'antd'

export function MixedExample() {
  return (
    <>
      <Button>已合规</Button>
      <Button icon={<span>X</span>} />
    </>
  )
}