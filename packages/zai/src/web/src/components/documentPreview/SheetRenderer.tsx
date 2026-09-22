/**
 * SheetRenderer —— .xlsx/.xlsm/.xlsb/.xls/.ods/.csv 预览(SheetJS)。
 *
 * 保真度取舍(spec §2.4,UI 上可见):不重绘图表、不还原单元格样式细节、不做公式
 * 求值(显示文件里的缓存值)。首版按**纯表格**渲染。
 *
 * 大表策略:单 sheet 只渲染前 MAX_ROWS × MAX_COLS 个单元格,超出在表头提示。
 * 刻意不走 `sheet_to_json(ws)` —— 那会把整张表(30 MB 的 CSV 可能有几十万行)
 * 先物化成 JS 数组再截断;这里按 `!ref` 的 range 直接按坐标取单元格,内存与
 * 耗时都与"实际渲染的行列数"成正比。
 *
 * 多 sheet 走 AntD Tabs;workbook 留在 ref 里,切换 sheet 时才解析那一张。
 *
 * 表格配色**固定浅色**(白底黑字 + 中性灰描边),不取 `var(--bg-*)` /
 * `var(--text-*)`:暗色主题下那套变量会把表格变成深底浅字,与文档预览整体
 * 的白底黑字不一致,也影响同一份表格在两种主题下的辨识度。见 index.tsx 的
 * DOC_LIGHT_TOKENS 注释。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Spin, Tabs, Typography } from 'antd'

/** 单 sheet 渲染上限(行 × 列)。 */
const MAX_ROWS = 2000
const MAX_COLS = 100

type Cell = { w?: string; v?: unknown }
type WorkSheet = Record<string, unknown> & { '!ref'?: string }

interface Grid {
  rows: string[][]
  truncatedRows: boolean
  truncatedCols: boolean
}

function readGrid(XLSX: typeof import('xlsx'), ws: WorkSheet): Grid {
  const ref = ws['!ref']
  if (!ref) return { rows: [], truncatedRows: false, truncatedCols: false }
  const range = XLSX.utils.decode_range(ref)
  const totalRows = range.e.r - range.s.r + 1
  const totalCols = range.e.c - range.s.c + 1
  const rowCount = Math.min(totalRows, MAX_ROWS)
  const colCount = Math.min(totalCols, MAX_COLS)
  const rows: string[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row: string[] = []
    for (let c = 0; c < colCount; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })] as Cell | undefined
      if (!cell) {
        row.push('')
        continue
      }
      // `w` 是 SheetJS 解析时生成的格式化文本(带千分位/日期格式);没有就用原始值。
      row.push(cell.w ?? (cell.v == null ? '' : String(cell.v)))
    }
    rows.push(row)
  }
  return {
    rows,
    truncatedRows: totalRows > rowCount,
    truncatedCols: totalCols > colCount,
  }
}

export function SheetRenderer({ data, path }: { data: ArrayBuffer; path: string }) {
  const wbRef = useRef<{ Sheets: Record<string, WorkSheet> } | null>(null)
  const xlsxRef = useRef<typeof import('xlsx') | null>(null)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [active, setActive] = useState<string>('')
  const [grid, setGrid] = useState<Grid | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 解析 workbook(每个 ArrayBuffer 一次)。
  useEffect(() => {
    let cancelled = false
    wbRef.current = null
    xlsxRef.current = null
    setSheetNames([])
    setActive('')
    setGrid(null)
    setError(null)
    void import('xlsx')
      .then((XLSX) => {
        const wb = XLSX.read(new Uint8Array(data), { type: 'array' })
        if (cancelled) return
        xlsxRef.current = XLSX
        wbRef.current = wb as unknown as { Sheets: Record<string, WorkSheet> }
        setSheetNames(wb.SheetNames)
        setActive(wb.SheetNames[0] ?? '')
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      wbRef.current = null
      xlsxRef.current = null
    }
  }, [data])

  // 解析当前 sheet。
  useEffect(() => {
    const XLSX = xlsxRef.current
    const ws = wbRef.current?.Sheets[active]
    if (!XLSX || !ws) {
      setGrid(null)
      return
    }
    try {
      setGrid(readGrid(XLSX, ws))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [active, sheetNames])

  if (error) {
    return (
      <div data-testid="sheet-error" className="p-3">
        <Typography.Paragraph type="danger" className="!mb-0 text-xs">
          解析表格失败:{error}
        </Typography.Paragraph>
      </div>
    )
  }

  if (sheetNames.length === 0) {
    return (
      <div data-testid="sheet-loading" className="flex h-full items-center justify-center">
        <Spin />
      </div>
    )
  }

  return (
    <div data-testid="document-sheet" data-path={path} className="flex h-full flex-col">
      {sheetNames.length > 1 && (
        <Tabs
          size="small"
          activeKey={active}
          onChange={setActive}
          className="shrink-0 px-2"
          items={sheetNames.map((n) => ({ key: n, label: n }))}
        />
      )}
      {(grid?.truncatedRows || grid?.truncatedCols) && (
        <Alert
          data-testid="sheet-truncated"
          type="info"
          showIcon
          className="mx-2 my-1 shrink-0"
          message={
            <span className="text-xs">
              仅显示前 {MAX_ROWS} 行 / {MAX_COLS} 列
              {grid?.truncatedRows ? '(行被截断)' : ''}
              {grid?.truncatedCols ? '(列被截断)' : ''}
            </span>
          }
        />
      )}
      <div className="flex-1 min-h-0 overflow-auto bg-white text-black">
        <table data-testid="sheet-table" className="border-collapse text-xs">
          <tbody>
            {(grid?.rows ?? []).map((row, r) => (
              // 表格是只读快照,行列都没有稳定 id,index 作 key 是这里唯一可用且正确的选择。
              <tr key={r} className={r === 0 ? 'bg-[#f2f4f7] font-medium' : ''}>
                <th className="sticky left-0 z-10 border border-[#d9d9d9] bg-[#f7f8fa] px-1 text-right text-[10px] font-normal text-[#8c8c8c]">
                  {r + 1}
                </th>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="max-w-[320px] truncate border border-[#d9d9d9] px-1 whitespace-nowrap"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {grid && grid.rows.length === 0 && (
          <div className="p-3 text-xs text-[#8c8c8c]">这张表是空的</div>
        )}
      </div>
    </div>
  )
}