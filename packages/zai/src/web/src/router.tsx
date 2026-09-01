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
const Desktop = lazy(() => import('./pages/Desktop'));
// 任务工厂面板 — Task 8 才落地完整 UI,本任务先把路由挂上 + redirect 通路打通,
// 期间页面 404(暂未实现)可接受:路由表与跳转契约先固化,避免 Task 8 一次性改动
// 把 router.tsx 的边界移动到不一致状态。
const SuperTasks = lazy(() => import('./pages/SuperTasks'));

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

/**
 * 任务工厂实例 root 重定向(用于 `/`):任务工厂实例直接落到顶层
 * /super-tasks;标准实例落到 `defaultTarget`(典型用法 `/agent`)。
 * 与 `TaskFactoryAgentEntry` 的差别:后者负责 `/agent` 路由的 element
 * (既要 redirect 又要渲染 `<Agent />`),前者只做 URL 跳转 — 避免在
 * `TaskFactoryAgentEntry` 之外再写一份重复的 redirect 组件。
 */
function TaskFactoryRedirect({
  taskFactoryTarget,
  defaultTarget,
}: {
  taskFactoryTarget: string
  defaultTarget: string
}): JSX.Element {
  const isTaskFactory = useAppStore((s) => s.instanceContext?.app === 'task-factory')
  return <Navigate to={isTaskFactory ? taskFactoryTarget : defaultTarget} replace />
}

/**
 * 任务工厂实例入口:当 GET /api/system 回显的 `app === 'task-factory'`
 * (即当前进程是任务工厂实例 profile,通过 `cli/index.ts --app` flag 注入
 * `process.env.ZAI_APP`,后端 routes/system.ts 原样回传,Layout mount effect
 * 写入 useAppStore.instanceContext.app)时,把 `/` 与 `/agent` 都跳到顶层
 * /super-tasks — 任务工厂实例没有"标准 Agent 入口",只展示任务面板。
 * 标准实例(无 profile 或其它 app 值)直接渲染 `<Agent />` 页面(把 redirect
 * 换成条件渲染,避免 `/agent → /agent` 的死循环)。
 *
 * 注意:`/super-tasks` 本身不挂 Layout,见下方顶层 Route;`<Routes>` 是
 * React Router 6 语义,redirect 元素放在 Layout 路由内部不会跳出 Layout,
 * 所以"标准实例渲染 / 任务工厂实例 redirect"在同一个 element 函数内分流。
 */
function TaskFactoryAgentEntry(): JSX.Element {
  const isTaskFactory = useAppStore((s) => s.instanceContext?.app === 'task-factory')
  if (isTaskFactory) return <Navigate to="/super-tasks" replace />
  return <Agent />
}

export default function AppRouter() {
  return (
    <Suspense fallback={routeFallback}>
      <Routes>
        {/* 桌面端 — 走 Layout(含 Sider) */}
        <Route element={<Layout />}>
          {/*
            / 与 /agent 都包一层任务工厂分流:
            - / 始终重定向到 /agent(标准实例旧行为);任务工厂实例直接落到
              /super-tasks,避免再绕一次 /agent → /super-tasks 多一跳。
            - /agent 在标准实例下渲染 <Agent />,任务工厂实例 redirect 到
              /super-tasks(顶层,脱离 Layout)。详细契约见 TaskFactoryAgentEntry。
          */}
          <Route
            path="/"
            element={
              <TaskFactoryRedirect
                taskFactoryTarget="/super-tasks"
                defaultTarget="/agent"
              />
            }
          />
          <Route path="/login" element={<Login />} />
          <Route path="/manage" element={<Manage />} />
          {/* /tools 现在是 /manage 内的 tab,老 URL 重定向过去,书签不丢 */}
          <Route path="/tools" element={<Navigate to="/manage?tab=tools" replace />} />
          <Route path="/resources" element={<Navigate to="/manage?tab=resources" replace />} />
          <Route path="/config" element={<Navigate to="/manage?tab=config" replace />} />
          <Route path="/dirs" element={<Navigate to="/manage?tab=dirs" replace />} />
          <Route path="/agent" element={<TaskFactoryAgentEntry />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route
            path="/instances"
            element={
              <InstanceRouteGuard>
                <Instances />
              </InstanceRouteGuard>
            }
          />
          {/*
            通配 fallback:任务工厂实例直接 URL 输入 unknown 路径 → /super-tasks
            (与 `/` `/agent` 的分流一致);标准实例落到 /agent。
          */}
          <Route
            path="*"
            element={
              <TaskFactoryRedirect
                taskFactoryTarget="/super-tasks"
                defaultTarget="/agent"
              />
            }
          />
        </Route>

        {/* 移动端 — 走 MobileLayout(无 Sider, 挂 visualViewport) */}
        <Route element={<MobileLayout />}>
          <Route path="/m" element={<MobileAgent />} />
        </Route>

        {/* /desktop 是脱离 Layout 的全屏办公桌面页 — 顶层路由 */}
        <Route path="/desktop" element={<Desktop />} />

        {/*
          /super-tasks 是任务工厂面板(脱离 Layout,顶层路由,与 /desktop 并列):
          - 不挂 Layout(Sider + Header):任务面板自管 viewport,菜单里也不
            该出现"实例管理"等子进程不相关入口。
          - 路由元素 SuperTasks 由 Task 8 落地;本任务先挂表,期间 lazy import
            失败 / 页面 404 可接受 — 跳转契约本身已生效,业务 UI 后续补齐。
        */}
        <Route path="/super-tasks" element={<SuperTasks />} />
      </Routes>
    </Suspense>
  );
}