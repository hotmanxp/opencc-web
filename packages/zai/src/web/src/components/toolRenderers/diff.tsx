import React from "react"
import type { ToolRenderer } from "./types.js"
import DiffBlock from "../DiffBlock.js"
import { truncate } from "./shared.js"

// Edit / Write 工具: 整段交回 DiffBlock 一体渲染 (header + 行级 diff + error).
// 用 renderFull 而不是 renderInput/renderOutput, 因为 DiffBlock 用整个 msg
// (包括 type 推导 status、input + error + reason) 自成一体, 不是简单的 input vs
// output 二分. ToolCallBlock 检测到 renderFull 会跳过默认折叠面板和 parameter/
// result/error 三段, 直接挂载此节点的输出.

export const diffRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    // Edit 才有的 replace_all, Write 没有
    const all = input.replace_all === true ? " (all)" : ""
    return truncate(`${p}${all}`, 80)
  },

  renderFull(msg) {
    return <DiffBlock msg={msg} />
  },
}
