import { spawn } from 'node:child_process';

/**
 * 调系统默认应用打开本地文件。spawn 不用 shell —— 路径原样作参数, 无注入面;
 * stdio:'ignore' 不污染服务端日志;不等待子进程退出('spawn' 后 unref 算成功,
 * 'error' 事件 reject)。platform 可注入以便单测各平台分支。
 */
export async function openWithSystem(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let child: ReturnType<typeof spawn>;
  if (platform === 'darwin') {
    child = spawn('open', ['--', target], { stdio: 'ignore' });       // `--` 防路径以 - 开头被当选项
  } else if (platform === 'win32') {
    child = spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore' }); // 空格 title + 路径
  } else if (platform === 'linux') {
    child = spawn('xdg-open', [target], { stdio: 'ignore' });
  } else {
    throw new Error(`平台 ${platform} 暂不支持系统打开`);
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', (err: Error) => reject(new Error(`系统打开失败: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
