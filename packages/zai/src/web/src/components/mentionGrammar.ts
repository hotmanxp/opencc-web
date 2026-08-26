/**
 * Pure grammar for `@path` / `@"path with spaces"` 提及补全。
 *
 * 移植自 deepseek-harness `packages/context/file-reference/src/grammar.ts`:
 * - activeAtToken: 提取光标所在 `@` token,要求 `@` 紧贴行首或空白之后
 *   (邮箱 `foo@bar.com` 的 `@` 不算补全触发,因为前面是普通字符);
 *   引号变体 `@"..."` 允许路径含空格 / 特殊字符。
 * - formatFileMention: 把候选格式化成 `@path` 或 `@"path"`;目录自动追加 `/`
 *   以便继续补全下一层。
 *
 * 这两份都是纯函数,无 React / DOM 依赖;AgentInputBox / MobileAgent 都直接调用。
 */

/** Mention 候选(来自 /api/fs/search 的 FsSearchEntry) */
export interface FileMentionCandidate {
  /** 相对 cwd 的 POSIX 路径 */
  path: string;
  /** 类型:目录 / 文件 */
  kind: "file" | "dir";
}

/** 光标位置 active 的 `@` token */
export interface ActiveAtToken {
  /** 完整可替换片段(`@foo` / `@"foo bar"` / `@` 三种之一) */
  prefix: string;
  /** `@` 之后(或 `@"` 之后)的实际 query 内容 */
  query: string;
  /** 是否由 `@"` 显式开起的引号 token(用于 formatFileMention 决定是否保留引号) */
  quoted: boolean;
  /**
   * prefix 在 `input` 中结束的 offset (exclusive)。
   * 注意:cursor 可能在 prefix 之后(用户已"完成" token,@ 后面接了空格),
   * 所以 `cursor - prefix.length` 不一定等于 prefix 的起始 offset ——
   * 用 `end - prefix.length` 算 start 更准。
   */
  end: number;
}

/**
 * 在 `input` 文本的 `cursorCol` 处探测 active `@` token。
 *
 * 边界:`@` 必须紧贴行首或空白之后 ——
 * - `@foo`:匹配
 * - ` @foo` / `\n@foo`:匹配(行首或空白)
 * - `foo@bar.com`:不匹配(`@` 前是普通字符,避免邮箱误触)
 * - `@"foo bar"`:匹配引号变体(query = `foo bar`,quoted = true)
 *
 * 末尾规则:query 不允许包含空白,带引号变体则允许。光标右侧可以接空白
 * (用户已"完成" token,例如 `@src/ ` 用于目录继续展开下一层),但
 * query 内部不允许空白。`prefix` 总长度 = quoted ? 2 + query.length : 1 + query.length。
 *
 * 实现细节:从光标向左去掉末尾连续空白,再匹配 `(?:^|\s)(@...)$`。这
 * 是为了支持 `selectAtEntry` 选目录后插入 `@src/ ` + 末尾空格时,cursor
 * 落在空格右侧;旧的"严格对齐"语义会把这种情况误判为非 active,但
 * 实际 UX 上用户希望继续敲下一段(目录内文件)或继续选下一条候选。
 *
 * @returns ActiveAtToken,或 input 不在 `@` token 内时返回 undefined
 */
export function activeAtToken(
  input: string,
  cursorCol: number,
): ActiveAtToken | undefined {
  const beforeCursor = input.slice(0, cursorCol);
  // 去掉末尾连续空白:让 `@src/ `(cursor 在空格后)仍能匹配 `@src/`。
  // 不动 query 本身的语义 —— 纯展示性的"用户已离开 token 末尾"信号。
  const searchStr = beforeCursor.replace(/\s+$/u, "");
  // searchStr 末尾在 input 里的 offset = searchStr.length
  const end = searchStr.length;
  // 引号变体优先:引号内的 query 可以含空白
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(searchStr);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true, end };
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(searchStr);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false, end };
}

/**
 * 把选中的 mention 候选格式化为插入字符串。
 *
 * - 目录 → 自动追加 `/`(便于继续补全下一层)
 * - 路径含空白或控制字符 → 加引号 `@"..."`(控制字符直接拒绝,返回 undefined 让调用方决定怎么处理)
 * - `preserveQuote = true` 时即便不需要也保留显式开起的引号(用户在 `@"foo` 后选中时,即使路径无空格也输出 `@"foo"` 让用户能继续手动敲空白)
 *
 * @returns 插入字符串,或路径不安全(控制字符、未配对引号)时返回 undefined
 */
export function formatFileMention(
  candidate: FileMentionCandidate,
  preserveQuote: boolean,
): string | undefined {
  const path =
    candidate.kind === "dir" ? `${candidate.path}/` : candidate.path;
  // 控制字符 (C0/C1) + 双引号会破坏 token grammar,直接拒
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const quoted = preserveQuote || /\s/u.test(path);
  if (!quoted) return `@${path}`;
  // 目录追加 / 后引号仍保持开放,让用户继续敲下一段;文件闭合。
  if (candidate.kind === "dir") return `@"${path}`;
  return `@"${path}"`;
}