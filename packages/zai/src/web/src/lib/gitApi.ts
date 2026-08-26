import { api } from './api.js';
import type { SseEvent } from '../../../shared/types.js';
import type {
  GitBranchesResult,
  GitBranch,
  GitRevertResult,
  GitSwitchResult,
} from '../../../shared/git.js';

/**
 * /exec 走 SSE 协议: 每个 event 是 `data: {...}\n\n`. 这里提取所有 stdout
 * 行(返回时拼成单字符串)并跟踪 exit code. 与 Dashboard.tsx 的
 * runNpmConfigSet 模式一致 — 把那个示例搬过来扩成可复用 helper.
 *
 * 该函数不消费网络层以外的依赖, 既给 gitApi.listBranches / switchBranch
 * 用, 也可被其他 /exec 调用复用 (e.g. npm run、yarn install).
 */
async function runExecAndCollect(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  timeout?: number;
}): Promise<{ code: number; stdout: string; stderr: string; errorMessage?: string }> {
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let code = -1;
  let errorMessage: string | undefined;

  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice(6)) as SseEvent;
        if (ev.type === 'stdout' && ev.line !== undefined) stdoutLines.push(ev.line);
        else if (ev.type === 'stderr' && ev.line !== undefined) stderrLines.push(ev.line);
        else if (ev.type === 'exit') code = ev.code ?? -1;
        else if (ev.type === 'error' && ev.message) errorMessage = ev.message;
        else if (ev.type === 'start') {
          /* 忽略命令起始事件; 诊断 UI 不需要 */
        }
      } catch {
        /* 中途解析失败忽略, 已收集的内容继续 */
      }
    }
  }

  return {
    code,
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

/**
 * 解析 `git for-each-ref` 输出.
 *
 * 命令格式:
 *   git for-each-ref --format='%(HEAD)%00%(refname:short)%00%(objecttype)' refs/heads refs/remotes
 *
 * 每行三列 (tab 分隔), 由 %00 注入避免 refname 中的特殊字符干扰:
 *   - "*" 表示当前 HEAD 所在分支
 *   - " " 表示其他
 *   - 第三列 objecttype 用于本地/远程区分 ("commit" 表示本地 branch;
 *     远程 ref 我们用 refs/remotes 路径, 自行推断 isRemote)
 */
function parseBranchLines(stdout: string): GitBranch[] {
  const lines = stdout.split('\n').filter(Boolean);
  const out: GitBranch[] = [];
  for (const line of lines) {
    const [head, refname, _type] = line.split('\0');
    if (!refname) continue;
    // refs/remotes/origin/main -> name "origin/main", isRemote:true
    // refs/heads/main          -> name "main",         isRemote:false
    if (refname.startsWith('refs/remotes/')) {
      out.push({
        name: refname.slice('refs/remotes/'.length),
        isCurrent: head === '*',
        isRemote: true,
      });
    } else if (refname.startsWith('refs/heads/')) {
      out.push({
        name: refname.slice('refs/heads/'.length),
        isCurrent: head === '*',
        isRemote: false,
      });
    }
  }
  return out;
}

export const gitApi = {
  revertFile: (path: string): Promise<GitRevertResult> =>
    api.post<GitRevertResult>('/git/revert', { path }),

  /**
   * 列当前 cwd 下的所有分支 (本地 + 远程).
   * 调用通用 /exec (`git` 已在白名单), 不走 git.ts 专属 endpoint —
   * 保持"通用命令执行接口"原则, 分支列表只是其中一个用例.
   */
  listBranches: async (cwd: string): Promise<GitBranchesResult> => {
    try {
      const { code, stdout, stderr, errorMessage } = await runExecAndCollect({
        cmd: 'git',
        args: [
          'for-each-ref',
          // %00 = NUL, 作为 %HEAD / refname:short / 占位列分隔符.
          '--format=%(HEAD)%00%(refname)%00%(objecttype)',
          'refs/heads',
          'refs/remotes',
        ],
        cwd,
        timeout: 5000,
      });
      // exit 128 + "fatal: not a git repository" — cwd 不在仓库内.
      if (code !== 0) {
        const errText =
          (stderr.trim().split('\n')[0] ?? '').trim() ||
          errorMessage ||
          `git exit ${code}`;
        return { ok: false, error: errText };
      }
      const branches = parseBranchLines(stdout);
      // 当前 HEAD 可能在 detached state (e.g. 用户检出 commit).
      // 此时 refname 会出现 "HEAD" 条目, 过滤掉避免 UI 显示噪音.
      const filtered = branches.filter((b) => b.name !== 'HEAD');
      return { ok: true, branches: filtered };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * 切换分支. 走 /exec 跑 `git checkout <name>`. 服务端不需要额外 endpoint —
   * 切换成功后, 已有的 startBranchChecker (10s 间隔) 会检测到新分支并 emit
   * `branch.changed` 事件, 前端 store 自动更新. 用户想立刻看到新分支名
   * 的话, 切完后 refetch `/api/system` / 等下一次 SSE 推送.
   */
  switchBranch: async (cwd: string, name: string): Promise<GitSwitchResult> => {
    try {
      const { code, stdout, stderr } = await runExecAndCollect({
        cmd: 'git',
        args: ['checkout', name],
        cwd,
        timeout: 10_000,
      });
      if (code === 0) {
        // `git checkout` 成功时 stdout 形如 "Switched to branch 'main'" 或
        // "Switched to a new branch 'feature/x'" / "Your branch is up to
        // date...". 取引号里的分支名作为回执 — 跨分支名含特殊字符时
        // 仍稳定.
        const match = stdout.match(/Switched to (?:a new )?branch ['"]([^'"]+)['"]/);
        return {
          ok: true,
          branch: match?.[1] ?? name,
        };
      }
      const errLine = stderr.trim().split('\n').find((l) => l.trim()) ?? '';
      return {
        ok: false,
        error: errLine || `git checkout exit ${code}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};