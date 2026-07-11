import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MergeOptions {
  /** 覆盖已存在的目标文件，默认 false（保留目标） */
  overwrite?: boolean;
}

/**
 * Local re-implementation of publisher's DirectoryMerger.
 *
 * We can't import @zn-ai/plugin internals here (publisher only publishes
 * bin/ + dist/, not src/fs/), so zai carries its own copy. Logic mirrors
 * packages/publisher/src/fs/DirectoryMerger.ts:15-82. Keep them in sync.
 */
export class DirectoryMerger {
  /**
   * 合并源目录到目标目录，保留目标中已存在的文件
   * 断链 symlink 会被自动清理后再创建
   */
  merge(source: string, target: string, options?: MergeOptions): void {
    if (!fs.existsSync(source)) return;

    const { overwrite = false } = options ?? {};
    const items = fs.readdirSync(source);

    for (const item of items) {
      const sourceItem = path.join(source, item);
      const targetItem = path.join(target, item);
      const stats = fs.statSync(sourceItem);

      if (stats.isDirectory()) {
        this.removeBrokenSymlink(targetItem);
        if (!fs.existsSync(targetItem)) {
          fs.mkdirSync(targetItem, { recursive: true });
        }
        this.merge(sourceItem, targetItem, options);
      } else {
        this.removeBrokenSymlink(targetItem);
        if (!fs.existsSync(targetItem) || overwrite) {
          fs.copyFileSync(sourceItem, targetItem);
        }
      }
    }
  }

  /**
   * 递归拷贝文件或目录到目标
   */
  copyRecursive(source: string, target: string): void {
    const stats = fs.statSync(source);
    const isDirectory = stats.isDirectory();

    if (isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      fs.readdirSync(source).forEach((child) => {
        this.copyRecursive(
          path.join(source, child),
          path.join(target, child),
        );
      });
    } else {
      fs.copyFileSync(source, target);
    }
  }

  /**
   * Remove a broken symlink if one exists at targetPath
   */
  removeBrokenSymlink(targetPath: string): void {
    try {
      const lstat = fs.lstatSync(targetPath);
      if (lstat.isSymbolicLink()) {
        try {
          fs.statSync(targetPath); // Will throw if broken
        } catch {
          fs.unlinkSync(targetPath);
        }
      }
    } catch {
      // Path doesn't exist, nothing to do
    }
  }
}