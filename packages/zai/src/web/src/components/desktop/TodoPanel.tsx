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
      style={{
        position: 'absolute',
        top: 44,
        right: 16,
        width: 260,
        zIndex: 80,
        background: 'rgba(28,28,38,.92)',
        backdropFilter: 'blur(10px)',
        border: '1px solid var(--border-subtle, rgba(128,128,128,.3))',
        borderRadius: 12,
        boxShadow: '0 10px 40px rgba(0,0,0,.5)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: 'var(--text-primary, #eaeaea)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>任务待办</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭待办"
          style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 2 }}
        >
          <CloseOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
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
          style={{
            border: '1px solid var(--border-subtle, rgba(128,128,128,.4))',
            borderRadius: 6,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: '0 10px',
          }}
        >
          <PlusOutlined />
        </button>
      </div>
      {todos.length === 0 ? (
        <div style={{ color: 'var(--text-secondary, #aaa)', textAlign: 'center', padding: '8px 0' }}>暂无待办</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {todos.map((t) => (
            <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => onToggle(t.id)}
                style={{ cursor: 'pointer', flexShrink: 0 }}
              />
              <span
                style={{
                  flex: 1,
                  textDecoration: t.done ? 'line-through' : undefined,
                  color: t.done ? 'var(--text-secondary, #aaa)' : 'inherit',
                  wordBreak: 'break-all',
                }}
              >
                {t.text}
              </span>
              <button
                type="button"
                onClick={() => onDelete(t.id)}
                aria-label="删除待办"
                style={{ border: 0, background: 'transparent', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', padding: 2, flexShrink: 0 }}
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