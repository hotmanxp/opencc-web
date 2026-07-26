import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppRouter from './router';
import { useEventStream } from './store/useEventStream';
import { useEffectiveTheme } from './hooks/useEffectiveTheme.js';

/* DARK: 主题色用 Tailwind orange-500 (#f97316) — 比 #ff6600 更柔和; 次要
   文字提到 slate-300/600 让 antd 默认组件在深背景上清晰可读.

   LIGHT: 用户最新要求"白色主题 + 卡片浅灰底 + 保持橙色主题色".
   - colorPrimary 仍是 #f97316 (橙色), 主按钮/Avatar/Tag 都用橙色;
   - body 用纯白 #ffffff, 卡片 / sidebar 用 #f1f5f5 拉层次. */
const DARK_TOKENS = {
  colorPrimary: '#f97316',
  colorBgContainer: '#12121a',
  colorBgElevated: '#1a1a2e',
  colorBgLayout: '#0a0a0f',
  colorText: '#f8fafc',
  colorTextSecondary: '#cbd5e1',
  colorBorder: 'rgba(249, 115, 22, 0.18)',
  borderRadius: 8,
} as const;

const LIGHT_TOKENS = {
  colorPrimary: '#f97316',
  colorBgContainer: '#f1f5f5',
  colorBgElevated: '#ffffff',
  colorBgLayout: '#ffffff',
  colorText: '#0f172a',
  colorTextSecondary: '#475569',
  colorBorder: 'rgba(249, 115, 22, 0.20)',
  borderRadius: 8,
} as const;

export default function App() {
  useEventStream();
  const effective = useEffectiveTheme();

  // 同步 <html data-theme="..."> 让 index.css 的 [data-theme] 选择器命中
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = effective;
    }
  }, [effective]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: effective === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: effective === 'dark' ? DARK_TOKENS : LIGHT_TOKENS,
      }}
    >
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ConfigProvider>
  );
}
