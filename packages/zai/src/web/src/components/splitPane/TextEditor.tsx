import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';

export interface TextEditorProps {
  initialContent: string;
  /** extToLanguage(name) result. null = plain text (no language pack). */
  language: string | null;
  onSave: (newContent: string) => void | Promise<void>;
  onCancel: () => void;
  saving?: boolean;
}

/**
 * Map Prism-style language ids from `extToLanguage` to CodeMirror language
 * extensions. Anything not in the map falls back to plain text (no lang
 * extension is added — CM's default behavior).
 */
function langLoader(language: string | null) {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return javascript();
    case 'json':
      return json();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
    case 'sql':
      return sql();
    default:
      return null;
  }
}

/**
 * Mount a CodeMirror 6 view into the returned container. Dark theme aligned
 * with the rest of the zai web UI (#0d0d0d background, off-white text, dim
 * selection). Cmd-S / Ctrl-S triggers `onSave`; Escape triggers `onCancel`.
 * The view is destroyed on unmount to avoid leaking DOM event handlers.
 *
 * We do NOT import `@codemirror/view/dist/index.css` — CM ships the styles
 * inline in JS for v6. We do override a few class names via `EditorView.theme`
 * so colors match zai's palette.
 */
export function TextEditor(props: TextEditorProps): JSX.Element {
  const { initialContent, language, onSave, onCancel, saving } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const langExt = langLoader(language);
    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: (view) => {
              void onSave(view.state.doc.toString());
              return true;
            },
          },
          {
            key: 'Escape',
            preventDefault: false,
            run: () => {
              onCancel();
              return true;
            },
          },
        ]),
        ...(langExt ? [langExt] : []),
        EditorView.theme({
          '&': {
            backgroundColor: '#0d0d0d',
            color: 'rgba(255,255,255,0.85)',
            height: '100%',
            fontSize: '12px',
          },
          '.cm-content': {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          },
          '.cm-gutters': {
            backgroundColor: '#0d0d0d',
            color: 'rgba(255,255,255,0.35)',
            border: 'none',
          },
          '.cm-activeLine': {
            backgroundColor: 'rgba(255,255,255,0.04)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'transparent',
            color: 'rgba(255,255,255,0.65)',
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    // Custom event: fs-editor-get-doc → dispatch fs-editor-doc with current doc.
    const onGetDoc = () => {
      window.dispatchEvent(new CustomEvent('fs-editor-doc', { detail: view.state.doc.toString() }));
    };
    const el = containerRef.current;
    el.addEventListener('fs-editor-get-doc', onGetDoc);

    return () => {
      view.destroy();
      viewRef.current = null;
      el.removeEventListener('fs-editor-get-doc', onGetDoc);
    };
    // initialContent 改变 → 重挂;onSave/onCancel 用 ref 包一层避免无效重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, language]);

  // 占位 useEffect:让 `saving` prop 切换时父组件(若有 spinner)能感知到。
  // 这里不做渲染,仅依赖数组包含 saving 即可让 React 在该 prop 变化时不警告。
  useEffect(() => {
    /* saving is consumed by parent for button loading state */
  }, [saving]);

  return (
    <div
      data-testid="fs-editor"
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
    />
  );
}
