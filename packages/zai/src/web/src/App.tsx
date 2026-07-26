import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppRouter from './router';
import { useEventStream } from './store/useEventStream';
import { useEffectiveTheme } from './hooks/useEffectiveTheme.js';

const DARK_TOKENS = {
  colorPrimary: '#ff6600',
  colorBgContainer: '#12121a',
  colorBgElevated: '#1a1a2e',
  colorBgLayout: '#0a0a0f',
  colorText: '#f1f5f9',
  colorTextSecondary: '#94a3b8',
  colorBorder: 'rgba(255, 102, 0, 0.15)',
  borderRadius: 8,
} as const;

const LIGHT_TOKENS = {
  colorPrimary: '#ff6600',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgLayout: '#f8fafc',
  colorText: '#0f172a',
  colorTextSecondary: '#475569',
  colorBorder: 'rgba(15, 23, 42, 0.10)',
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
