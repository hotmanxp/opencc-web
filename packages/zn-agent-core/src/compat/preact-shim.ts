/**
 * react → preact/compat shim。
 *
 * opencc-src 的 UI 组件(ink / tool UI / permission 对话框等)import 的
 * 'react' 由 bundle-opencc.ts 的 preactAliasPlugin 指向本文件。
 * preact/compat 提供 react 兼容 API(createElement / hooks / Component /
 * forwardRef / memo / createContext / useSyncExternalStore 等),体积远小于
 * react —— opencc-core.mjs 由 19.1MB 降到 17.9MB(大头是 stub 掉的
 * react-reconciler ink 渲染引擎,preact 替换本身省 react core 双份)。
 *
 * 与纯 stub 方案的区别:渲染类 API(createElement / hooks)是真实实现,万一
 * 死代码(ink 终端 UI / tool UI 渲染)意外被触发,preact 能真实渲染而非抛错
 * "not a function"。zai 是 Node 无 DOM 环境,正常路径永远不会走到渲染。
 *
 * 类型说明:preact/compat 的类型是 `export = React`(CommonJS 风格),tsc
 * 不允许对它 `export *`,因此这里用命名空间导入 + 显式 re-export bundle
 * 实际引用的全部 API(见 bundle-opencc.ts 的 react 属性访问统计)。
 *
 * preact 10 未提供 react 19 的 `use` hook。bundle 中实际未调用它
 * (opencc-src 源码里的 `.use(` 引用均为 marked 库误匹配),这里补一个
 * 安全实现兜底:promise 直接抛错,context 返回当前值。
 */
import * as React from 'preact/compat'

export default React

export const Children = React.Children
export const Component = React.Component
export const PureComponent = React.PureComponent
export const Fragment = React.Fragment
export const Suspense = React.Suspense
export const createContext = React.createContext
export const createElement = React.createElement
export const createRef = React.createRef
export const forwardRef = React.forwardRef
export const isValidElement = React.isValidElement
export const lazy = React.lazy
export const memo = React.memo
export const useCallback = React.useCallback
export const useContext = React.useContext
export const useDeferredValue = React.useDeferredValue
export const useEffect = React.useEffect
export const useImperativeHandle = React.useImperativeHandle
export const useLayoutEffect = React.useLayoutEffect
export const useMemo = React.useMemo
export const useReducer = React.useReducer
export const useRef = React.useRef
export const useState = React.useState
export const useSyncExternalStore = React.useSyncExternalStore

export function use<T>(resource: T): T {
  const maybePromise = resource as { then?: unknown } | null
  if (maybePromise && typeof maybePromise.then === 'function') {
    throw new Error(
      '[preact-shim] use() with a promise is not supported by preact',
    )
  }
  const ctx = resource as { _currentValue?: T } | null
  return (ctx?._currentValue ?? resource) as T
}
