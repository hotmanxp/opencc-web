# Task 4 Brief

## Task 4: 把内联底栏抽出为 `ConfigStatusBar`



**Files:**
- Create: `packages/zai/src/web/src/components/ConfigStatusBar.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1405-1432`

**Interfaces:**
- Consumes: `cwdName: string`、`branch: string`、`onTaskSelect: (taskId: string) => void`（即 `setSelectedTaskId`）
- Produces: 一个无状态的 React 组件，返回原有那段 div

- [ ] **Step 1: 写组件骨架**

`packages/zai/src/web/src/components/ConfigStatusBar.tsx`:

```tsx
import { ModelStatusButton } from "./ModelStatusButton";
import { ModeStatusButton } from "./ModeStatusButton";
import { TaskDock } from "./TaskDock";

type Props = {
  cwdName: string;
  branch: string;
  onTaskSelect: (taskId: string) => void;
};

export default function ConfigStatusBar({ cwdName, branch, onTaskSelect }: Props) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.10)",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "rgba(255,255,255,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <ModeStatusButton />
      <span style={{ color: "#eab308" }}>{cwdName}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#22c55e" }}>{branch}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#f97316" }}>
        <ModelStatusButton />
      </span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <TaskDock onSelect={onTaskSelect} />
    </div>
  );
}
```

- [ ] **Step 2: 在 Agent.tsx 替换原内联 div**

`packages/zai/src/web/src/pages/Agent.tsx`:

1. 加 import：

```tsx
import ConfigStatusBar from "../components/ConfigStatusBar";
```

2. 删除 `Agent.tsx:1407-1431` 整段内联 div，替换为：

```tsx
<div className="bottom-stack">
  <AgentInputBox />
  <ConfigStatusBar
    cwdName={cwdName}
    branch={branch}
    onTaskSelect={setSelectedTaskId}
  />
</div>
```

- [ ] **Step 3: 视觉零改动验证**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: pass

Run: 浏览器手动加载 `/agent` 路由，对比改前底栏
Expected: bypass / cwd / branch / model / 后台任务 5 个元素位置与外观完全一致

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/ConfigStatusBar.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): extract inline bottom config bar into ConfigStatusBar component"
```

---
