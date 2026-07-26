// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/web/src/store/useAppStore.js";
import { useAgentStore } from "../../src/web/src/store/useAgentStore.js";
import SharePopover from "../../src/web/src/components/SharePopover.js";

// hoisted 必须在 import 之前,所以 vi.hoisted 包 mock state。
// 每个测试按需重置 mocks.successOrError 用最新 fn。
const mocks = vi.hoisted(() => {
  return {
    successOrError: { success: () => {}, error: () => {} },
  } as {
    successOrError: { success: () => void; error: (...args: unknown[]) => void };
  };
});

vi.mock("antd", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    message: {
      success: (...args: unknown[]) => mocks.successOrError.success(...args),
      error: (...args: unknown[]) => mocks.successOrError.error(...args),
    },
    QRCode: ({ value, "data-testid": testId, ...rest }: { value: string; "data-testid"?: string }) => (
      <div data-testid={testId} data-value={value} {...rest} />
    ),
  };
});

beforeEach(() => {
  useAppStore.setState({
    instanceContext: {
      cwd: "/tmp",
      cwdName: "tmp",
      branch: null,
      host: "0.0.0.0",
      port: 9888,
      ips: ["192.168.1.5", "10.0.0.2"],
    },
  });
  useAgentStore.setState({
    sessionId: "sess-test-123",
  });
  // 默认 message 静默,单独 case 覆写
  mocks.successOrError = { success: () => {}, error: () => {} };
});

describe("SharePopover", () => {
  test("renders IP list with sid in URL", () => {
    render(<SharePopover />);
    // 验证每行有 data-testid 复制按钮(后续 test 也用它索引)。
    // clipboard URL 含完整 sid 由 test 4 验证,展示文本因多 text node 切片
    // 不直接用 getByText 整串匹配(react 把相邻表达式当独立 child)。
    expect(screen.getByTestId("share-copy-192.168.1.5")).toBeInTheDocument();
    expect(screen.getByTestId("share-copy-10.0.0.2")).toBeInTheDocument();
  });

  test("shows '先开一个会话' when no sessionId", () => {
    useAgentStore.setState({ sessionId: null });
    render(<SharePopover />);
    expect(screen.getByText(/先开一个会话/)).toBeInTheDocument();
  });

  test("shows '未启用 --lan' when ips empty", () => {
    useAppStore.setState({
      instanceContext: {
        cwd: "/tmp",
        cwdName: "tmp",
        branch: null,
        host: "127.0.0.1",
        port: 9888,
        ips: [],
      },
    });
    render(<SharePopover />);
    // --lan 被包在 <code> 子节点里,所以用 getByText("未启用") + 容器文本匹配。
    expect(screen.getByText(/未启用/)).toBeInTheDocument();
    expect(screen.getByText("--lan")).toBeInTheDocument();
  });

  test("clicking Copy invokes navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<SharePopover />);
    const copyBtns = screen.getAllByRole("button", { name: /复制/ });
    fireEvent.click(copyBtns[0]!);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "http://192.168.1.5:9888/agent?sid=sess-test-123",
      );
    });
  });

  test("clipboard.writeText reject triggers error message", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const errorFn = vi.fn();
    mocks.successOrError = { success: () => {}, error: errorFn };
    render(<SharePopover />);
    const copyBtns = screen.getAllByRole("button", { name: /复制/ });
    fireEvent.click(copyBtns[0]!);
    await waitFor(() => {
      expect(errorFn).toHaveBeenCalled();
    });
  });

  test("renders primary QRCode with /m URL and '其它可用 IP' list when multiple IPs", () => {
    render(<SharePopover />);
    // QR stub 存在
    expect(screen.getByTestId("share-primary-qrcode")).toBeInTheDocument();
    // 副标题文本
    expect(screen.getByText(/扫码在手机上打开/)).toBeInTheDocument();
    expect(screen.getByText(/\/m\?sid=sess-test-123/)).toBeInTheDocument();
    // "其它可用 IP" 分组标题
    expect(screen.getByText(/其它可用 IP/)).toBeInTheDocument();
    // 2 个 IP → 2 个复制按钮(每个 IP 一行)
    expect(screen.getAllByRole("button", { name: /复制/ })).toHaveLength(2);
  });

  test("primary QRCode value points to /m?sid=<sid> with first IP", () => {
    render(<SharePopover />);
    const qr = screen.getByTestId("share-primary-qrcode");
    // stub 把 value 放在 data-value 上
    expect(qr.getAttribute("data-value")).toBe(
      "http://192.168.1.5:9888/m?sid=sess-test-123",
    );
  });

  test("hides '其它可用 IP' group when only one IP", () => {
    useAppStore.setState({
      instanceContext: {
        cwd: "/tmp",
        cwdName: "tmp",
        branch: null,
        host: "0.0.0.0",
        port: 9888,
        ips: ["192.168.1.5"],
      },
    });
    render(<SharePopover />);
    // QR 仍渲染
    expect(screen.getByTestId("share-primary-qrcode")).toBeInTheDocument();
    // "其它可用 IP" 标题不出现
    expect(screen.queryByText(/其它可用 IP/)).not.toBeInTheDocument();
    // 仅 1 个复制按钮
    expect(screen.getAllByRole("button", { name: /复制/ })).toHaveLength(1);
  });
});