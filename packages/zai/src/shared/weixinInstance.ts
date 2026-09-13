/**
 * 微信专用实例(`app=weixin`)的编排常量。
 *
 * 为什么单独成文件而不是塞进 `shared/weixin.ts`:本文件**零依赖**,可以被前端
 * Web bundle 直接引用;而 `shared/weixin.ts` 顶层 `import { z } from 'zod'`,
 * 前端只需要一个默认端口号,不该为此把 zod 拖进浏览器产物。
 *
 * 服务端引用链:`channelProfile.ts` → `weixinDedicatedInstance.ts` / `routes/weixin.ts`。
 */

/**
 * 专用实例的默认端口。
 *
 * 显式 pin,而不是走 `INSTANCE_BASE_PORT`(9201)自动扫描 —— 端口是用户在面板上
 * 认得出的稳定标识,静默换端口只会让"面板显示 9199、实际跑在 9205"这种事发生
 * (参见根 AGENTS.md「端口使用」)。
 */
export const DEFAULT_WEIXIN_INSTANCE_PORT = 9199
