// Filesystem types for the directory picker.
//
// 与 src/shared/fs.ts 的区别:
// - FsList 是 workspace-relative(基于 instance cwd,通过 resolveSafePath 限根),
//   配套 /fs/list 用于文件浏览/搜索;
// - FsPickerList 是 filesystem-absolute(基于用户 home dir,不限制根),
//   配套 /fs/picker 用于"选择实例工作目录"对话框,用户可能想指到任意位置
//   (例如 ~/projects/demo、/tmp、D:\code\app),不局限于 instance 启动目录。
//
// 路径格式:服务端返回 OS-native 字符串(Windows: C:\Users\foo, macOS/Linux:
// /Users/foo),客户端原样回显并作为下一次请求的 path 参数。`path` 字段已
// 经 path.resolve + path.normalize,客户端可直接 POST 回去而无需再处理。

export interface FsPickerEntry {
  /** Basename of the entry. */
  name: string;
  /** Absolute path of the entry in OS-native format. */
  path: string;
  type: 'dir' | 'file';
}

export interface FsPickerList {
  ok: boolean;
  error?: string;
  /** Absolute path of the currently listed directory (OS-native). */
  path?: string;
  /** Absolute path of the parent directory, or null if at filesystem root. */
  parent?: string | null;
  /** Absolute path of the current user's home directory (for the "home" button). */
  home?: string;
  /** Direct children of `path`. */
  entries?: FsPickerEntry[];
}