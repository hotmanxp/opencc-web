import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Spin, message } from 'antd';
import Layout from './components/Layout';
import { useAppStore } from './store/useAppStore';
const Dashboard = lazy(() => import('./pages/Dashboard'));
// /login 是顶层菜单(常用入口免进 tab),/resources /config /dirs /tools
// 四个页面合并到 /manage(Manage.tsx 用 AntD Tabs 在顶部切换);老 URL 走
// 下方 <Navigate> 重定向到 /manage?tab=<key>。
const Login = lazy(() => import('./pages/Login'));
const Manage = lazy(() => import('./pages/Manage'));
const Agent = lazy(() => import('./pages/Agent'));
const Instances = lazy(() => import('./pages/Instances'));
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

/**
 * /instances 路由守卫:instance 子实例(instance manager 派生的子进程)
 * 不能 spawn 孙实例,给它挂 /instances 入口只会 404。在路由层直接 redirect
 * 到 /agent,避免用户看到一个空白 / 404 页面。Layout 也会隐藏菜单,但路由
 * 守卫是兜底 — 用户直接 URL 访问 /instances 也能被截走。
 */
function InstanceRouteGuard({ children }: { children: ReactNode }): JSX.Element {
  const isInstanceChild = useAppStore(
    (s) => s.instanceContext?.isManagedChild === true && (s.instanceContext?.instanceId ?? null) != null,
  )
  const navigate = useNavigate()
  useEffect(() => {
    if (isInstanceChild) {
      message.info('当前进程是受管子实例,不支持实例管理')
      navigate('/agent', { replace: true })
    }
  }, [isInstanceChild, navigate])
  if (isInstanceChild) return <></>
  return <>{children}</>
}

export default function AppRouter() {
  return (
    <Suspense fallback={routeFallback}>
      <Routes>
        {/* 桌面端 — 走 Layout(含 Sider) */}
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/agent" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/manage" element={<Manage />} />
          {/* /tools 现在是 /manage 内的 tab,老 URL 重定向过去,书签不丢 */}
          <Route path="/tools" element={<Navigate to="/manage?tab=tools" replace />} />
          <Route path="/resources" element={<Navigate to="/manage?tab=resources" replace />} />
          <Route path="/config" element={<Navigate to="/manage?tab=config" replace />} />
          <Route path="/dirs" element={<Navigate to="/manage?tab=dirs" replace />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route
            path="/instances"
            element={
              <InstanceRouteGuard>
                <Instances />
              </InstanceRouteGuard>
            }
          />
          <Route path="*" element={<Navigate to="/agent" replace />} />
        </Route>

        {/* 移动端 — 走 MobileLayout(无 Sider, 挂 visualViewport) */}
        <Route element={<MobileLayout />}>
          <Route path="/m" element={<MobileAgent />} />
        </Route>
      </Routes>
    </Suspense>
  );
}