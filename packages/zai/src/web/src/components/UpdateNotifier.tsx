import { useEffect, useRef } from 'react'
import { Modal, notification } from 'antd'
import { useAppStore } from '../store/useAppStore'

/**
 * zai 自升级通道的前端可视化层。挂在 Layout + MobileAgent 顶层,订阅
 * `useAppStore.appUpdate` 状态变化:
 *
 *   - 'checking'   → 顶部 notification(info, 持续显示直到下一阶段)
 *   - 'installing' → 同上 notification 更新文案 + from/to 版本号
 *   - 'complete'   → Modal.info「升级到 vX.Y.Z 完成,请重启 zai 以生效」
 *   - 'failed'     → Modal.error「升级失败:<err>」
 *
 * 去重:appUpdate.dismissedKey 记录用户已 dismiss 的 from+to 组合,
 * 同 key 的 complete/failed 不再弹(避免用户按掉后又被新一轮 install
 * 同一个版本重新弹起)。新 installing 会清掉 dismissedKey(允许再次弹)。
 *
 * Modal/notification 都通过 AntD 默认 portal 到 document.body — DOM 位置
 * 不影响渲染,挂在任意父组件下都行。Layout/MobileAgent 都挂一份,
 * 单 process 内 useAppStore 是单例,两份订阅会重复触发 — 用 shownKeyRef
 * 抑制。
 */
export function UpdateNotifier() {
  const appUpdate = useAppStore((s) => s.appUpdate)
  const dismissAppUpdate = useAppStore((s) => s.dismissAppUpdate)

  // 已经触发过弹窗的状态 + key 组合,避免 Modal/notification 重复出现。
  // ref 不入 render,只在 effect 里读。
  const shownKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const { status, from, to, error, dismissedKey } = appUpdate
    const currentKey =
      from || to
        ? `${from ?? '?'}->${to ?? '?'}`
        : error
          ? `err:${error}`
          : status

    // 检查中 / 安装中 → 顶部轻量通知(只有从 idle 切换到 checking/installing
    // 才发,不会因 status 反复重发)。duration: 0 表示不自动关闭,
    // 下一阶段(complete/failed)会主动 destroy。
    if (status === 'checking' || status === 'installing') {
      if (shownKeyRef.current !== currentKey) {
        shownKeyRef.current = currentKey
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
      }
      return
    }

    // complete / failed → 弹 Modal,仅在 (status, key) 变化时触发,且 key
    // 没被用户 dismiss 过。
    if (status === 'complete' || status === 'failed') {
      if (shownKeyRef.current === currentKey) return
      if (dismissedKey === currentKey) return
      shownKeyRef.current = currentKey

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