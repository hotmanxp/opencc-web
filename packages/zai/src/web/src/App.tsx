import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppRouter from './router';
import { useEventStream } from './store/useEventStream';

export default function App() {
  useEventStream();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#ff6600',
          colorBgContainer: '#12121a',
          colorBgElevated: '#1a1a2e',
          colorBgLayout: '#0a0a0f',
          colorText: '#f1f5f9',
          colorTextSecondary: '#94a3b8',
          colorBorder: 'rgba(255, 102, 0, 0.15)',
          borderRadius: 8,
        },
      }}
    >
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ConfigProvider>
  );
}
