/**
 * 内部路径 re-export,把 weixin 子系统的持久化路径集中暴露,
 * 避免在 store / lock / media 多个文件里散落 import 长串。
 *
 * 顶层常量(WEIXIN_*)在模块加载时求值,只适合生产主流程;store / lock
 * 必须用函数版(每次重读 ZAI_DATA_DIR),否则测试的临时数据目录覆盖不生效。
 */
export {
  WEIXIN_DIR,
  WEIXIN_ACCOUNTS_DIR,
  WEIXIN_LOCKS_DIR,
  WEIXIN_SYNC_DIR,
  WEIXIN_CONTEXT_DIR,
  WEIXIN_MEDIA_DIR,
  WEIXIN_PENDING_DIR,
  weixinDataDir as weixinBaseDir,
  weixinAccountsDir,
  weixinLocksDir,
  weixinPendingDir,
  weixinSessionsFile,
  weixinPairingsFile,
  weixinOwnerFile,
  weixinOwnerLockFile,
} from '../paths.js'
