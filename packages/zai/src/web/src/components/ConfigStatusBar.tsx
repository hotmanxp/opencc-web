import ModelStatusButton from "./ModelStatusButton";
import ModeStatusButton from "./ModeStatusButton";
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