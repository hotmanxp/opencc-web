import { useEffect, useState } from 'react';
import { Button, Empty, Spin, Tree } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { FileIcon, DirIcon } from './fileIcon.js';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { DataNode } from 'antd/es/tree';
import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { extToLanguage } from './extToLang.js';
import { MarkdownText } from '../markdown/MarkdownText.js';
import { FsContextMenu } from './FsContextMenu.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// We track loaded children in a map keyed by parent path.
type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null };
type LoadedMap = Record<string, Entry[]>;

/**
 * Render the file content with Prism syntax highlighting when the
 * extension maps to a known code language; fall back to a plain
 * <pre> for prose-like files (.md / .json / .txt / unknown).
 *
 * The outer container (`fs-preview`) is the column-flex scroller; the
 * inner <pre> / SyntaxHighlighter only needs `flex: 1, min-height: 0`
 * to inherit that scroll behavior and grow with the panel height.
 */
function renderPreview(file: import('../../../../shared/fs.js').FsFile): JSX.Element {
  const { name } = file;
  const content = file.content ?? '';

  // Image kind: the server returned a base64 dataUrl for binary image
  // formats (png/jpg/gif/webp/bmp/ico/avif). Render with a plain <img>
  // — auto-fit, transparent background, checker pattern helps spot
  // transparency vs. solid images.
  if (file.kind === 'image' && file.dataUrl) {
    const containerStyle: React.CSSProperties = {
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: 12,
      backgroundImage:
        'linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.05) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.05) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.05) 75%)',
      backgroundSize: '16px 16px',
      backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
    };
    return (
      <div data-testid="fs-preview-image" style={containerStyle}>
        <img
          src={file.dataUrl}
          alt={name ?? ''}
          style={{
            maxWidth: '100%',
            height: 'auto',
            display: 'block',
          }}
        />
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    borderRadius: 6,
  };

  // MD 分支: 在 lang 检查之前,先识别 .md / .markdown,走 MarkdownText。
  // 用 regex 而非 extToLanguage, 因为 extToLanguage 不把 MD 视为 code,
  // 返回 null, 会让 MD 落到 plain text 分支(就是现状的 bug)。
  if (name && /\.(md|markdown)$/i.test(name)) {
    return (
      <div data-testid="fs-preview-md" style={containerStyle}>
        <MarkdownText text={content} />
      </div>
    );
  }

  const lang = name ? extToLanguage(name) : null;
  if (lang) {
    return (
      <div data-testid="fs-preview-code" style={containerStyle}>
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: 12,
            background: 'transparent',
            fontSize: 12,
            lineHeight: 1.55,
          }}
          codeTagProps={{ style: { fontFamily: MONO } }}
          wrapLongLines={false}
          showLineNumbers={false}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    );
  }
  return (
    <div data-testid="fs-preview-text" style={containerStyle}>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: 'rgba(255,255,255,0.04)',
          color: 'rgba(255,255,255,0.85)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content}
      </pre>
    </div>
  );
}

export function FsTab({ cwd }: { cwd: string | null }) {
  const root = useFsList(cwd, '');
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loaded, setLoaded] = useState<LoadedMap>({});
  const file = useFsFile(cwd, selected);
  const [contextMenu, setContextMenu] = useState<{ path: string; absPath: string; x: number; y: number } | null>(null);

  // Reset on cwd change.
  useEffect(() => {
    setSelected(null);
    setExpandedKeys([]);
    setLoaded({});
    setContextMenu(null);
  }, [cwd]);

  if (!cwd) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  const handleLoadData = (treeNode: DataNode): Promise<void> =>
    new Promise((resolve) => {
      const key = String(treeNode.key);
      if (loaded[key]) {
        resolve();
        return;
      }
      void fetch(`/api/fs/list?dir=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.ok && Array.isArray(j.entries)) {
            setLoaded((cur) => ({ ...cur, [key]: j.entries }));
          } else {
            setLoaded((cur) => ({ ...cur, [key]: [] }));
          }
          resolve();
        })
        .catch(() => {
          setLoaded((cur) => ({ ...cur, [key]: [] }));
          resolve();
        });
    });

  const renderTree = (entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }>): DataNode[] =>
    entries.map((e) => {
      const children = loaded[e.path];
      // For directory nodes:
      //   - children loaded → render real children (may be [] = empty dir)
      //   - children not yet loaded → leave `children` undefined so antd Tree
      //     fires `loadData` on expand (the previous version injected a
      //     `[ { __ph } ]` placeholder which made Tree think the node was
      //     already loaded and skip the fetch — that's why drill-down was
      //     stuck at every level).
      // Files are always leaves.
      const isLoaded = Object.prototype.hasOwnProperty.call(loaded, e.path);
      return {
        key: e.path,
        title: <span style={{ fontFamily: MONO, fontSize: 12 }}>{e.name}</span>,
        icon:
          e.type === 'dir' ? (
            <DirIcon name={e.name} open={expandedKeys.includes(e.path)} />
          ) : (
            <FileIcon name={e.name} />
          ),
        isLeaf: e.type === 'file',
        children:
          e.type === 'dir'
            ? isLoaded
              ? renderTree(children ?? [])
              : undefined
            : undefined,
      } as DataNode;
    });

  const refreshBtn = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={root.loading}
      onClick={() => root.refetch()}
      title="刷新目录"
    >
      刷新
    </Button>
  );

  const treeData = root.data?.ok && root.data.entries ? renderTree(root.data.entries) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          Files <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.35)' }}>(按需加载)</span>
        </span>
        {refreshBtn}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          data-testid="fs-tree"
          style={{
            flex: '0 0 40%',
            // 显式高度 (calc(100vh - 140px)) 让 fs-tree 在 flex 行里
            // 有确定的高度, antd Tree 自然渲染的内容超出时被父容器
            // overflow:auto 截断并显示原生滚动条; minHeight:0 防止
            // Tree 自然高度反向撑爆 calc.
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            overflow: 'auto',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 8px',
          }}
        >
          {root.error && !root.data?.ok ? (
            <Empty description={root.error} />
          ) : root.loading && treeData.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : treeData.length === 0 ? (
            <div style={{ padding: 16, color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              目录为空
            </div>
          ) : (
            <Tree
              treeData={treeData}
              showIcon
              loadData={handleLoadData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              onSelect={(_keys, info) => {
                // Files: preview their content.
                // Directories: toggle expand on click. Loading is lazy —
                // adding an unloaded dir to expandedKeys triggers loadData
                // since renderTree leaves `children` undefined until loaded.
                const key = String(info.node.key);
                if (info.node.isLeaf) {
                  setSelected(key);
                } else {
                  setExpandedKeys((cur) =>
                    cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
                  );
                }
              }}
              onRightClick={({ node, event }) => {
                const relPath = String(node.key);
                const abs = cwd ? `${cwd.replace(/\/$/, '')}/${relPath}` : relPath;
                setContextMenu({ path: relPath, absPath: abs, x: event.clientX, y: event.clientY });
                event.preventDefault();
              }}
            />
          )}
        </div>
        <div
          data-testid="fs-preview"
          style={{
            // 与 fs-tree 对齐的 calc 高度; minHeight:0 防止内层
            // SyntaxHighlighter / <pre> 自然高度撑爆 flex 行.
            flex: '0 0 60%',
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 12,
            overflow: 'hidden',
            fontFamily: MONO,
            fontSize: 12,
          }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看内容" />
          ) : file.loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : file.error ? (
            <Empty description={file.error} />
          ) : file.data && (file.data.content !== undefined || file.data.kind === 'image') ? (
            renderPreview(file.data)
          ) : (
            <Empty description="没有内容" />
          )}
        </div>
      </div>
      {contextMenu && cwd && (
        <FsContextMenu
          path={contextMenu.path}
          absPath={contextMenu.absPath}
          cwd={cwd}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}