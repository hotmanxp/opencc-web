import { Empty } from 'antd';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const ADD_BG = 'rgba(46,160,67,0.18)';
const ADD_FG = '#3fb950';
const DEL_BG = 'rgba(248,81,73,0.18)';
const DEL_FG = '#f85149';
const CTX_FG = 'rgba(255,255,255,0.72)';
const GUTTER_FG = 'rgba(255,255,255,0.30)';
const HUNK_FG = 'rgba(167,139,250,0.85)';

type Row =
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ctx'; text: string }
  | { kind: 'hunk'; text: string };

function classify(line: string): Row {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
  return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
}

function rowStyle(kind: Row['kind']): React.CSSProperties {
  switch (kind) {
    case 'add': return { background: ADD_BG, color: ADD_FG };
    case 'del': return { background: DEL_BG, color: DEL_FG };
    case 'hunk': return { color: HUNK_FG, fontWeight: 600 };
    default: return { color: CTX_FG };
  }
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return <Empty description="没有差异" />;
  }
  const lines = diff.split('\n');
  return (
    <div
      data-testid="diff-view"
      style={{
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.55,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        padding: '6px 0',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      {lines.map((line, idx) => {
        const row = classify(line);
        return (
          <div
            key={idx}
            style={{ display: 'flex', minWidth: 'max-content', ...rowStyle(row.kind) }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 16,
                textAlign: 'center',
                color: GUTTER_FG,
                userSelect: 'none',
              }}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
            <span style={{ whiteSpace: 'pre', paddingRight: 12 }}>
              {row.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}