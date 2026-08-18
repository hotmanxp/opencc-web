/**
 * 内部路径 re-export,把 weixin 子系统的持久化路径集中暴露,
 * 避免在 store / lock / media 多个文件里散落 import 长串。
 */
export {
  WEIXIN_DIR,
  WEIXIN_ACCOUNTS_DIR,
  WEIXIN_LOCKS_DIR,
  WEIXIN_SYNC_DIR,
  WEIXIN_CONTEXT_DIR,
  WEIXIN_MEDIA_DIR,
} from '../paths.js'
