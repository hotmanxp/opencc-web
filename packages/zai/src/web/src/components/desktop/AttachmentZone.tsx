import { useCallback, useState } from 'react';
import { Button, message } from 'antd';
import { CloseOutlined, PaperClipOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons';
import type { FileRef } from './gatherMentions.js';

export const DND_MIME = 'application/x-zai-file';
export const DEFAULT_MAX = 16;

export function parseRefPayload(raw: string): FileRef | null {
  try {
    const o = JSON.parse(raw) as Partial<FileRef>;
    if (typeof o.path !== 'string' || typeof o.name !== 'string' || !o.path || !o.name) return null;
    const kind = o.kind === 'dir' ? 'dir' : 'file';
    return { id: `r-${o.path}`, path: o.path, name: o.name, kind };
  } catch {
    return null;
  }
}

interface AttachmentZoneProps {
  refs: FileRef[];
  onAddRef: (ref: FileRef) => void;
  onRemoveRef: (id: string) => void;
  max?: number;
}

const ZONE_BASE_CLS = 'flex flex-col items-stretch gap-[6px] py-[4px] px-[10px] border-b border-[var(--border-subtle,rgba(128,128,128,0.25))]';
const HINT_CLS = 'flex-1 text-[11px] text-[var(--text-dim-45,#888)] bg-[rgba(128,128,128,0.06)] px-2 py-[4px] rounded';
const CHIP_CLS = 'inline-flex items-center gap-[3px] max-w-full bg-[rgba(255,102,0,0.15)] rounded-md py-[1px] px-[6px]';
const CHIP_NAME_CLS = 'overflow-hidden text-ellipsis whitespace-nowrap text-xs max-w-[130px]';
const REMOVE_BTN_STYLE: React.CSSProperties = { width: 18, height: 18, minWidth: 18, padding: 0, fontSize: 10, flexShrink: 0 };

export default function AttachmentZone({ refs, onAddRef, onRemoveRef, max = DEFAULT_MAX }: AttachmentZoneProps) {
  const [hover, setHover] = useState(false);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    if (e.dataTransfer.types?.includes(DND_MIME) !== true) return; // 非资源窗拖出,忽略
    if (refs.length >= max) {
      void message.warning(`附件最多 ${max} 个,请先移除`);
      return;
    }
    const parsed = parseRefPayload(e.dataTransfer.getData(DND_MIME));
    if (parsed) onAddRef(parsed);
  }, [refs.length, max, onAddRef]);

  return (
    <div
      data-testid="attachment-zone"
      onDragOver={(e) => { if (e.dataTransfer.types?.includes(DND_MIME)) { e.preventDefault(); setHover(true); } }}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
      className={ZONE_BASE_CLS}
      style={{
        background: hover ? 'rgba(255,102,0,.08)' : 'transparent',
        minHeight: refs.length === 0 ? 28 : undefined,
      }}
    >
      {refs.length === 0 ? (
        <span
          data-testid="attachment-zone-hint"
          className={HINT_CLS}
        >
          拖拽文件到此处作为上下文
        </span>
      ) : (
        <>
          <PaperClipOutlined style={{ color: 'var(--text-dim-45, #888)', fontSize: 12 }} />
          {refs.map((r) => (
            // 自绘胶囊(不复用输入框专属 MentionChip:其 label 宽度按 U+FFFC 占位字形
            // 计算, 在附件区无该字体环境下名称会被裁得不可见)
            <span
              key={r.id}
              data-testid="attachment-chip"
              title={r.path}
              className={CHIP_CLS}
            >
              {r.kind === 'dir' ? (
                <FolderOutlined style={{ color: '#facc15', fontSize: 12, flexShrink: 0 }} />
              ) : (
                <FileOutlined style={{ color: 'var(--text-dim-45, #888)', fontSize: 12, flexShrink: 0 }} />
              )}
              <span className={CHIP_NAME_CLS}>{r.name}</span>
              <Button size="small" type="text" aria-label="移除附件" icon={<CloseOutlined />}
                onClick={() => onRemoveRef(r.id)} style={REMOVE_BTN_STYLE} />
            </span>
          ))}
        </>
      )}
    </div>
  );
}
