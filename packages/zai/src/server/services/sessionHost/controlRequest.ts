/**
 * ControlRequestRegistry —— 关联子进程 stdout 的 `control_request`
 * (子进程 → SDK 宿主,如 can_use_tool)与 zai 侧写回 stdin 的
 * `control_response`。
 *
 * 协议:vendor StructuredIO 在 stdout 上发
 *   {"type":"control_request","request_id":"r-N","request":{"subtype":"can_use_tool",...}}
 * 宿主(本进程)对同一 request_id 写 stdin
 *   {"type":"control_response","response":{"subtype":"success","request_id":"r-N","response":{...}}}
 * 后,子进程 resolve 对应的 pending promise 并继续 turn。
 *
 * Phase A 只建立注册表雏形(register/respond/pending 计数);Phase B 的
 * bridgeToolYield 用 register() 持有 stdout 请求并转成 zai `prompt.*` SSE,
 * 用户回答经 ask/permission/approve registry 走 respond() 落 stdin。
 */

type Resolver<T> = (value: T | PromiseLike<T>) => void

export interface RegisteredControlRequest {
  /** vendor acked subtype(can_use_tool / set_permission_mode / …)。 */
  subtype: string
  /** 原始 stdout 数据(含 tool_name / input 等 bridge 需要透传的字段)。 */
  payload: unknown
}

export class ControlRequestRegistry {
  private entries = new Map<
    string,
    { resolve: Resolver<unknown>; reject: (err: Error) => void; record: RegisteredControlRequest }
  >()

  /**
   * 登记一个来自子进程 stdout 的 control_request,返回一个在
   * respond() 时 resolve 的 promise。同一 request_id 重复 register
   * 直接 reject 新调用(协议上不应发生)。
   */
  register(
    requestId: string,
    subtype: string,
    payload: unknown,
  ): Promise<unknown> {
    const existing = this.entries.get(requestId)
    if (existing) {
      existing.reject(new Error(`dup control_request register: ${requestId}`))
    }
    return new Promise<unknown>((resolve, reject) => {
      this.entries.set(requestId, { resolve, reject, record: { subtype, payload } })
    })
  }

  /** 写回结果,resolve 对应 request(幂等:未知/已 resolve 的 reqId 忽略)。 */
  respond(requestId: string, response: unknown): void {
    const entry = this.entries.get(requestId)
    if (!entry) {
      console.warn(
        `[sessionHost:control] respond 到未知 request_id=${requestId},忽略`,
      )
      return
    }
    this.entries.delete(requestId)
    entry.resolve(response)
  }

  /** 读取已登记请求(Phase B bridge 用)。 */
  get(requestId: string): RegisteredControlRequest | undefined {
    return this.entries.get(requestId)?.record
  }

  /** 当前 in-flight(未 resolve)的 control_request 数。 */
  get pending(): number {
    return this.entries.size
  }

  /** 会话退出 / 宿主 kill 时清场:所有 pending 请求返回拒绝,避免悬挂 await。 */
  rejectAll(reason: string): void {
    for (const [, entry] of this.entries) {
      entry.reject(new Error(reason))
    }
    this.entries.clear()
  }
}