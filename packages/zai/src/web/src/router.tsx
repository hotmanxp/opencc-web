import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import Layout from './components/Layout';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Tools = lazy(() => import('./pages/Tools'));
const Resources = lazy(() => import('./pages/Resources'));
const Login = lazy(() => import('./pages/Login'));
const Config = lazy(() => import('./pages/Config'));
const Directory = lazy(() => import('./pages/Directory'));
const Agent = lazy(() => import('./pages/Agent'));
const MobileLayout = lazy(() => import('./components/MobileLayout'));
const MobileAgent = lazy(() => import('./pages/MobileAgent'));

// Suspense fallback — 路由懒加载生效时短暂出现, 仅占 layout 中心.
// 整页高度会被 layout 设成 100vh, 这里用 min-height 100% 即可让 Spin 居中.
const routeFallback = (
  <div
    style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <Spin />
  </div>
);

export default function AppRouter() {
  return (
    <Suspense fallback={routeFallback}>
      <Routes>
        {/* 桌面端 — 走 Layout(含 Sider) */}
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/resources" element={<Resources />} />
          <Route path="/config" element={<Config />} />
          <Route path="/dirs" element={<Directory />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Route>

        {/* 移动端 — 走 MobileLayout(无 Sider, 挂 visualViewport) */}
        <Route element={<MobileLayout />}>
          <Route path="/m" element={<MobileAgent />} />
        </Route>
      </Routes>
    </Suspense>
  );
}