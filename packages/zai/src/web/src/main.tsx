import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// 侧效应导入: 注册 window.lanAgentAttachImage(s) / window.lanAgentGoToAgent。
// 必须在入口顶层 import —— lan-agent 探测这些全局的时刻早于任何组件的
// useEffect(图片选择回调 / 点击「回到原生对话」都可能发生在首帧之前),
// 放进组件树里则会被 Vite 摇掉。
import './lib/lanAgentBridge.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
