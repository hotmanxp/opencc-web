import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';

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
  /** 显式指定新文件的权限(微信凭据那种)。不给则沿用目标文件现有 mode。 */
  mode?: number;
}

/**
 * 原子写文件:先写同目录下的唯一 tmp,再 `rename` 覆盖目标。
 *
 * 为什么:裸 `writeFile(path, data)` 用默认 flag `'w'`
 * (`O_WRONLY|O_CREAT|O_TRUNC`) —— **fd 打开的瞬间原文件就被截断为 0 字节**,
 * 内容才开始写。open 之后任何失败(SIGKILL / ENOSPC / EIO)都会留下 0 字节或
 * 半截文件,原内容不可恢复,而调用方只收到一个干净的错误。
 *
 * tmp+rename 把「写内容」和「替换目标」拆成两步:rename 在同一文件系统内
 * 是原子的,所以目标路径要么是完整旧内容,要么是完整新内容,不存在中间态。
 * 同目录保证 rename 不跨设备(EXDEV)。
 *
 * **范围要说准**:保证的是「可见性原子」—— 读者永远看不到中间态。没有
 * `fsync(tmpFd)` + `fsync(dirfd)`,机器掉电时仍可能丢数据(丢的是 rename
 * 之后的新内容,不是「半截文件」)。要抗断电得再补 fsync,这里没做。
 *
 * 失败时删 tmp 再抛,避免 `.tmp` 残留在磁盘上。
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // rename 换的是**新 inode**,目标文件原有的 mode / owner 不会跟过来
  // (writeFile 打开已存在文件是保留 mode 的,这里是行为差异)。不显式带上
  // 的话,新 tmp 是 0644 & ~umask → `chmod 600 .env` 存一次就变世界可读,
  // `chmod +x` 的脚本掉执行位。/api/fs/file PUT 写的是任意用户文件,
  // 所以这里从 stat 把现有 mode 捞回来。调用方显式给了 mode 则以其为准。
  let mode = options.mode;
  let existing: Stats | null = null;
  try {
    existing = await stat(path);
    if (mode === undefined) mode = existing.mode & 0o7777;
  } catch {
    // 目标不存在(首次创建)→ 用调用方给的 mode,或缺省 utf-8 的 0666 & ~umask。
    existing = null;
  }

  const tmpPath = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmpPath, data, mode !== undefined ? { mode } : 'utf-8');
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const code = (err as NodeJS.ErrnoException).code;
    // 「文件可写但所在目录不可写」时建不了 tmp —— 别人 root 所有的目录、
    // sticky /tmp 里你拥有的文件等。这种情况下原地写是唯一可行路径,
    // 而拒绝它等于把原本能成功的保存变成 500。仅在 EACCES/EPERM 且目标
    // 确实存在时回退,其余错误照抛。
    if (existing && (code === 'EACCES' || code === 'EPERM')) {
      await writeFile(path, data, 'utf-8');
      return;
    }
    throw err;
  }
}
