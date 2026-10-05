// 一次性探针:用 mermaid.parse() 逐个验证图型类型头 + 最小示例语法。
// parse 只跑 grammar,不进渲染/layout,所以不需要 getBBox;但 mermaid 内部
// import 了 DOMPurify,没有 DOM 会抛 "DOMPurify.sanitize is not a function"
// —— 那是环境噪音不是语法错,所以先垫 happy-dom,再 dynamic import。
import { Window } from "happy-dom";

const w = new Window({ url: "http://localhost" });
for (const k of [
  "window", "document", "navigator", "location", "history",
  "Element", "HTMLElement", "SVGElement", "Node", "NodeFilter",
  "DocumentFragment", "DOMParser", "XMLSerializer", "getComputedStyle",
  "MutationObserver", "CustomEvent", "DOMImplementation",
]) {
  if (w[k] === undefined) continue;
  // node 22 的 globalThis.navigator 是只读 getter,直接赋值会抛
  try {
    Object.defineProperty(globalThis, k, {
      value: w[k], writable: true, configurable: true,
    });
  } catch { /* 抢不到就算了,DOMPurify 只关心 document/window */ }
}

const { default: mermaid } = await import("mermaid");

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  useMaxWidth: false,
});

const cases = {
  flowchart: 'flowchart TD\n  A["流程"] --> B["结果"]',
  sequenceDiagram: "sequenceDiagram\n  participant U as 用户\n  participant S as 服务\n  U->>S: 请求",
  classDiagram: "classDiagram\n  class A {\n    +run() void\n  }",
  "stateDiagram-v2": "stateDiagram-v2\n  [*] --> 空闲\n  空闲 --> 运行",
  erDiagram: "erDiagram\n  SESSION ||--o{ MESSAGE : 包含",
  gantt: "gantt\n  title T\n  dateFormat YYYY-MM-DD\n  section S\n  任务 :a1, 2026-10-01, 3d",
  pie: 'pie showData\n  title T\n  "甲" : 10\n  "乙" : 20',
  mindmap: "mindmap\n  root((根))\n    甲\n    乙",
  timeline: "timeline\n  title T\n  2026-10-01 : 事件",
  gitGraph: 'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"\n  checkout main\n  merge dev',
  journey: "journey\n  title T\n  section S\n  做事: 5: 我",
  quadrantChart:
    'quadrantChart\n  title T\n  x-axis 低 --> 高\n  y-axis 低 --> 高\n  quadrant-1 A\n  quadrant-2 B\n  quadrant-3 C\n  quadrant-4 D\n  点: [0.3, 0.6]',
  "sankey-beta": "sankey-beta\n甲,乙,10\n甲,丙,5",
  "sankey-beta 纯英文": "sankey-beta\nA,B,10\nA,C,5",
  "sankey-beta 单行英文": "sankey-beta\nA,B,10",
  "xychart-beta 无引号y轴": "xychart-beta\n  x-axis [a, b]\n  y-axis 0 --> 700\n  bar [1, 2]",
  "xychart-beta 中文x轴": "xychart-beta\n  x-axis [一月, 二月]\n  y-axis 0 --> 700\n  bar [1, 2]",
  "xychart-beta 带引号y轴": 'xychart-beta\n  x-axis [a, b]\n  y-axis "KB" 0 --> 700\n  bar [1, 2]',
  "architecture-beta 纯英文":
    'architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api\n  db:L -- R:api',
  "xychart-beta":
    'xychart-beta\n  title T\n  x-axis [一月, 二月]\n  y-axis "KB" 0 --> 700\n  bar [483, 597]',
  C4Context: "C4Context\n  title T\n  Person(a, \"用户\")\n  System(b, \"系统\")\n  Rel(a, b, \"使用\")",
  kanban: "kanban\n    待办\n        任务甲\n    完成\n        任务乙",
  "radar-beta":
    'radar-beta\n  axis s1["结构类"], s2["时序类"]\n  curve hot["常用"]{4, 4}\n  curve cold["冷门"]{1, 2}\n  min 0\n  max 5',
  treemap: 'treemap\n  "根"\n    "甲": 10\n    "乙": 20',
  "packet-beta": 'packet-beta\n  0-15: "源端口"\n  16-31: "目的端口"',
  "block-beta": 'block-beta\n  columns 1\n  a["甲"]\n  b["乙"]',
  "architecture-beta": 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api\n  db:L -- R:api',
  // 反例:验证"去掉 beta 后缀"是否真的不行
  "radar (无 beta)": 'radar\n  axis s1["A"]\n  curve hot["B"]{1, 1}',
  "xychart (无 beta)": 'xychart\n  x-axis [a, b]\n  bar [1, 2]',
  zenuml: "zenuml\n  A->B: 调用",
};

const rows = [];
for (const [name, code] of Object.entries(cases)) {
  try {
    await mermaid.parse(code);
    rows.push([name, "OK", ""]);
  } catch (e) {
    rows.push([name, "FAIL", String(e?.message ?? e).split("\n").slice(0, 2).join(" ").slice(0, 110)]);
  }
}
let ok = 0;
for (const [n, s, msg] of rows) {
  if (s === "OK") ok++;
  console.log(`${n.padEnd(20)} ${s.padEnd(5)} ${msg}`);
}
console.log(`\n${ok}/${rows.length} 可用`);
