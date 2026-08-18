import { useEffect } from 'react'
import { Modal, notification } from 'antd'
import { useAppStore } from '../store/useAppStore'

// Module-level:跨实例共享的「最终弹窗」key 集合,key 与 store 的
// dismissedKey 同构(from->to / err:<error> / status)。
//
// 为什么不用组件内 ref:Layout 与 MobileAgent 各挂一份 UpdateNotifier,
// 路由切换瞬间可能双挂;React StrictMode dev 下 effect 还会双执行。
// 组件私有 ref 只能抑制本实例,挡不住跨实例重复 — 共享 Set 保证同一
// key 的 complete/failed 弹窗全局只出现一次。
//
// Set 的清理跟随「新一轮升级」信号,而不是用户按钮:升级流程总是以
// app.update.checking 开始,那时清空 Set,允许新一轮 complete/failed
// 弹窗;期间同一 key 的 complete 重放(SSE 重连历史重发 / 双实例)都被
// Set 挡掉。store.dismissedKey 仅记录「用户已点过知道了」,作为第二道
// 防线(complete reducer 会清 dismissedKey,真实防重放靠 Set)。
const shownFinalModals = new Set<string>()

/**
 * zai 自升级通道的前端可视化层。挂在 Layout + MobileAgent 顶层,订阅
 * `useAppStore.appUpdate` 状态变化:
 *
 *   - 'checking'   → 顶部 notification(info, 持续显示直到下一阶段)
 *   - 'installing' → 同上 notification 更新文案 + from/to 版本号
 *   - 'complete'   → Modal.info「升级到 vX.Y.Z 完成,请重启 zai 以生效」
 *   - 'failed'     → Modal.error「升级失败:<err>」
 *
 * 去重:complete/failed 由 store.dismissedKey 记录用户已 dismiss 的
 * from+to 组合,同 key 不再弹(用户已按掉);shownFinalModals Set 防
 * 双挂载 / StrictMode 双执行导致的重复 Modal。新一轮升级以 checking
 * 开始,会清掉 dismissedKey 与 Set(允许再次弹)。
 *
 * Modal/notification 都通过 AntD 默认 portal 到 document.body — DOM 位置
 * 不影响渲染,挂在任意父组件下都行。progress notification 固定 key
 * 'app-update-progress',antd 同 key 幂等 — checking → installing
 * 双实例 / 双 effect 调用也只是原地更新,不会堆叠。
 */
export function UpdateNotifier() {
  const appUpdate = useAppStore((s) => s.appUpdate)
  const dismissAppUpdate = useAppStore((s) => s.dismissAppUpdate)

  useEffect(() => {
    const { status, from, to, error, dismissedKey } = appUpdate
    const currentKey =
      from || to
        ? `${from ?? '?'}->${to ?? '?'}`
        : error
          ? `err:${error}`
          : status

    // 检查中 / 安装中 → 顶部轻量通知。duration: 0 表示不自动关闭,
    // 下一阶段(complete/failed)会主动 destroy。同 key 调用幂等更新。
    if (status === 'checking' || status === 'installing') {
      // 新一轮升级流程的开始 — 清空最终弹窗去重,允许 fresh 流程的
      // complete/failed 弹出(上一轮相同 key 的弹窗记录不再适用)。
      if (status === 'checking') shownFinalModals.clear()
      notification.info({
        key: 'app-update-progress',
        message: status === 'checking' ? '正在检查 zai 更新…' : '正在后台升级 zai…',
        description:
          status === 'installing' && from && to
            ? `${from} → ${to}。新版本安装到全局 npm prefix,完成后会弹窗提示。`
            : '首次启动检测可能需要数秒,请稍候。',
        duration: 0,
        placement: 'topRight',
      })
      return
    }

    // complete / failed → 弹 Modal,仅当 key 没被用户 dismiss 过、且本
    // 进程还没弹过(跨实例 / StrictMode 双执行抑制)时触发。
    // 注意:不能用 installing 阶段的状态当去重依据 — 之前用组件内 ref
    // 记录 installing 的 currentKey,complete 时 key 相同被短路,升级完成
    // 的 Modal 永远不会弹出(用户只见"正在后台升级"的顶部通知)。
    if (status === 'complete' || status === 'failed') {
      if (dismissedKey === currentKey) return
      if (shownFinalModals.has(currentKey)) return
      shownFinalModals.add(currentKey)

      // 关闭之前的 checking/installing notification
      notification.destroy('app-update-progress')

      if (status === 'complete') {
        Modal.info({
          title: 'zai 已升级',
          content: (
            <div>
              <p>
                已成功从 <strong>{from}</strong> 升级到 <strong>{to}</strong>。
              </p>
              <p style={{ marginBottom: 0 }}>
                当前运行中的进程仍加载旧代码,请手动重启 zai 以应用新版本(关闭终端后再执行 <code>zai start</code> 或 <code>zai dev</code>)。
              </p>
            </div>
          ),
          okText: '知道了',
          onOk: dismissAppUpdate,
        })
      } else {
        Modal.error({
          title: 'zai 升级失败',
          content: (
            <div>
              <p>
                {from && to ? (
                  <>
                    尝试从 <strong>{from}</strong> 升级到 <strong>{to}</strong> 失败。
                  </>
                ) : (
                  <>升级过程中发生异常。</>
                )}
              </p>
              <p style={{ marginBottom: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>
                {error ?? '未知错误'}
              </p>
              <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>
                可手动执行 <code>npm install -g @zn-ai/zai@latest</code> 重试,或在设置中关闭自动升级。
              </p>
            </div>
          ),
          okText: '知道了',
          onOk: dismissAppUpdate,
        })
      }
    }
  }, [appUpdate, dismissAppUpdate])

  // 卸载时清理正在显示的 progress notification,避免组件销毁后残留。
  useEffect(() => {
    return () => {
      notification.destroy('app-update-progress')
    }
  }, [])

  return null
}