import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import MobileLayout from './components/MobileLayout';
import Dashboard from './pages/Dashboard';
import Tools from './pages/Tools';
import Resources from './pages/Resources';
import Login from './pages/Login';
import Config from './pages/Config';
import Directory from './pages/Directory';
import Agent from './pages/Agent';
import MobileAgent from './pages/MobileAgent';

export default function AppRouter() {
  return (
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
  );
}