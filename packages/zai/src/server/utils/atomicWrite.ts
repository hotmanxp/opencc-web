import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * 进程内单调递增的 tmp 计数器。
 *
 * 为什么不能只用 `${path}.${process.pid}.tmp`:同进程内可能有多个写者
 * 指向同一个目标文件(fileStore 的 `zai` / `opencc` 两个 tab 与
 * zaiSettingsStore 的 read-merge-write 都写 `~/.zai/settings.json`),
 * pid 相同仍会撞名 —— 先完成的 rename 消费掉 tmp,后完成的 rename 拿到
 * ENOENT,写者以为成功或直接 500。带计数器后同一进程内不重名。
 */
let tmpCounter = 0;

export interface AtomicWriteOptions {
  /** 直接透传给 `fs.writeFile` 的选项 —— 微信凭据那类需要 `mode: 0o600`。 */
  mode?: number;
}

/**
 * 原子写文件:先写同目录下的唯一 tmp,再 `rename` 覆盖目标。
 *
 * 为什么:裸 `writeFile(path, data)` 用默认 flag `'w'`
 * (`O_WRONLY|O_CREAT|O_TRUNC`) —— **fd 打开的瞬间原文件就被截断为 0 字节**,
 * 内容才开始写。open 之后任何失败(SIGKILL / ENOSPC / EIO / 断电)都会留下
 * 0 字节或半截文件,原内容不可恢复,而调用方只收到一个干净的错误。
 *
 * tmp+rename 把「写内容」和「替换目标」拆成两步:rename 在同一文件系统内
 * 是原子的,所以目标路径要么是完整旧内容,要么是完整新内容,不存在中间态。
 * 同目录保证 rename 不跨设备(EINVAL/EXDEV)。
 *
 * 失败时删 tmp 再抛,避免 `.tmp` 残留在磁盘上。
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmpPath, data, options.mode !== undefined ? { mode: options.mode } : 'utf-8');
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
