import { useState } from 'react';
import { Input } from 'antd';
import { PlusOutlined, CloseOutlined } from '@ant-design/icons';
import type { TodoItem } from './desktopStore.js';

export interface TodoPanelProps {
  todos: TodoItem[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const PANEL_CLS = 'absolute top-[44px] right-[16px] w-[260px] z-[80] flex flex-col gap-2 p-[10px] rounded-[12px] border border-[var(--border-subtle,rgba(128,128,128,0.3))] shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-[10px] text-xs text-[var(--text-primary,#eaeaea)] bg-[var(--bg-elevated-92,rgba(28,28,38,0.92))]';
const HEADER_ROW_CLS = 'flex items-center justify-between';
const TITLE_CLS = 'font-bold text-[13px]';
const CLOSE_BTN_CLS = 'border-0 bg-transparent cursor-pointer p-[2px] text-inherit';
const INPUT_ROW_CLS = 'flex gap-[6px]';
const ADD_BTN_CLS = 'border border-[var(--border-subtle,rgba(128,128,128,0.4))] rounded-md bg-transparent cursor-pointer text-inherit px-[10px]';
const EMPTY_CLS = 'text-[var(--text-secondary,#aaa)] text-center py-2';
const LIST_CLS = 'list-none m-0 p-0 flex flex-col gap-1 max-h-[320px] overflow-y-auto';
const ITEM_ROW_CLS = 'flex items-center gap-[6px]';
const ITEM_CHECKBOX_CLS = 'cursor-pointer flex-shrink-0';
const ITEM_TEXT_CLS = 'flex-1 break-all';
const ITEM_TEXT_DONE_CLS = 'line-through text-[var(--text-secondary,#aaa)]';
const ITEM_DELETE_BTN_CLS = 'border-0 bg-transparent cursor-pointer p-[2px] flex-shrink-0 text-[var(--text-secondary,#aaa)]';

/** 任务待办:Dock「待办」开合的右侧浮出面板(顶栏之下、Dock 之上,zIndex 80 介于窗口层 2 与顶栏 100 之间) */
export default function TodoPanel({ todos, onAdd, onToggle, onDelete, onClose }: TodoPanelProps) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText('');
  };
  return (
    <div
      role="dialog"
      aria-label="任务待办"
      className={PANEL_CLS}
    >
      <div className={HEADER_ROW_CLS}>
        <span className={TITLE_CLS}>任务待办</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭待办"
          className={CLOSE_BTN_CLS}
        >
          <CloseOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
      <div className={INPUT_ROW_CLS}>
        <Input
          value={text}
          placeholder="添加待办…"
          onChange={(e) => setText(e.target.value)}
          onPressEnter={submit}
          autoFocus
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={submit}
          aria-label="添加待办"
          className={ADD_BTN_CLS}
        >
          <PlusOutlined />
        </button>
      </div>
      {todos.length === 0 ? (
        <div className={EMPTY_CLS}>暂无待办</div>
      ) : (
        <ul className={LIST_CLS}>
          {todos.map((t) => (
            <li key={t.id} className={ITEM_ROW_CLS}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => onToggle(t.id)}
                className={ITEM_CHECKBOX_CLS}
              />
              <span className={`${ITEM_TEXT_CLS} ${t.done ? ITEM_TEXT_DONE_CLS : ''}`}>
                {t.text}
              </span>
              <button
                type="button"
                onClick={() => onDelete(t.id)}
                aria-label="删除待办"
                className={ITEM_DELETE_BTN_CLS}
              >
                <CloseOutlined style={{ fontSize: 11 }} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
