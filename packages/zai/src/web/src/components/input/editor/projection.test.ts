/**
 * 投影层单测:detect 坐标 ⇄ clipboard 坐标 ⇄ occurrence 三者的不变量。
 *
 * 这里守护的是整个迁移最容易静默出错的地方 —— 坐标系错位不会抛错,只
 * 会表现为 chip 漂到错误位置、@ 菜单替换错 token。所以「一个 chip 在
 * detectText 里恰好占 1 个 U+FFFC」这条不变量必须被钉死。
 *
 * 用 @lexical/headless 的无 DOM 编辑器:投影是纯函数,不需要真实根元素。
 */
import { describe, expect, test } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createReferenceChipNode, ReferenceChipNode } from "./chip-node.js";
import { $composerLayout, $projectComposer } from "./projection.js";
import { $replaceDetectSpanWithText } from "./span-map.js";

function newEditor() {
  return createHeadlessEditor({ nodes: [ReferenceChipNode] });
}

/** 建一份「普通文本 + 一个 chip + 普通文本」的文档 */
function seedChip(editor = newEditor()) {
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("看 "));
      paragraph.append(
        $createReferenceChipNode({
          source: "fs",
          ref: "src/a.ts",
          label: "a.ts",
          clipboardText: "@src/a.ts",
        }),
      );
      paragraph.append($createTextNode(" 谢谢"));
      $getRoot().append(paragraph);
    },
    { discrete: true },
  );
  return editor;
}

function project(editor: ReturnType<typeof newEditor>) {
  return editor.getEditorState().read(() => $projectComposer(() => 1));
}

describe("投影:chip 占 1 个 U+FFFC", () => {
  test("detectText 里 chip 只占 1 个字符,clipboardText 展开成 @path", () => {
    const projection = project(seedChip());
    expect(projection.detectText).toBe("看 ￼ 谢谢");
    expect(projection.clipboardText).toBe("看 @src/a.ts 谢谢");
  });

  test("occurrence 的 offset 用 detect 坐标,可与 draft 字符串下标直接比较", () => {
    const projection = project(seedChip());
    expect(projection.occurrences).toHaveLength(1);
    expect(projection.occurrences[0].offset).toBe(2);
    expect(projection.occurrences[0].label).toBe("a.ts");
    expect(projection.occurrences[0].ref).toBe("src/a.ts");
    expect(projection.detectText[projection.occurrences[0].offset]).toBe("￼");
  });

  test("多个 chip 的 occurrence 按文档序排列", () => {
    const editor = newEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        for (const name of ["a.ts", "b.ts", "c.ts"]) {
          paragraph.append(
            $createReferenceChipNode({
              source: "fs",
              ref: `src/${name}`,
              label: name,
              clipboardText: `@src/${name}`,
            }),
          );
        }
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );
    const projection = project(editor);
    expect(projection.detectText).toBe("￼￼￼");
    expect(projection.occurrences.map((o) => o.offset)).toEqual([0, 1, 2]);
    expect(projection.clipboardText).toBe("@src/a.ts@src/b.ts@src/c.ts");
  });

  test("纯文本文档的两种投影一致", () => {
    const editor = newEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("没有任何引用"));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );
    const projection = project(editor);
    expect(projection.detectText).toBe("没有任何引用");
    expect(projection.clipboardText).toBe("没有任何引用");
    expect(projection.occurrences).toHaveLength(0);
  });

  test("段落之间的换行在两种投影里各贡献一个 \\n", () => {
    const editor = newEditor();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode("第一段")),
          $createParagraphNode().append($createTextNode("第二段")),
        );
      },
      { discrete: true },
    );
    const projection = project(editor);
    expect(projection.detectText).toBe("第一段\n第二段");
    expect(projection.clipboardText).toBe("第一段\n第二段");
  });
});

describe("布局:段序列与 chip 原子性", () => {
  test("段序列按文档序覆盖全部内容,gap 只在块之间出现", () => {
    const editor = seedChip();
    const layout = editor.getEditorState().read(() => $composerLayout());
    expect(layout.segments.map((s) => s.kind)).toEqual(["text", "chip", "text"]);
    expect(layout.detectLength).toBe("看 ￼ 谢谢".length);
  });

  test("跨过 chip 的编辑删除整个 chip,而不是留下半个", () => {
    const editor = seedChip();
    editor.update(
      () => {
        // [1,4) 覆盖 ' ' + chip + ' ':结果里不该再有 chip
        $replaceDetectSpanWithText({ start: 1, end: 4 }, "X");
      },
      { discrete: true },
    );
    const projection = project(editor);
    expect(projection.detectText).toBe("看X谢谢");
    expect(projection.clipboardText).toBe("看X谢谢");
    expect(projection.occurrences).toHaveLength(0);
  });

  test("只编辑 chip 之前的文本不会动到 chip", () => {
    const editor = seedChip();
    editor.update(
      () => {
        $replaceDetectSpanWithText({ start: 0, end: 2 }, "请看");
      },
      { discrete: true },
    );
    const projection = project(editor);
    expect(projection.detectText).toBe("请看￼ 谢谢");
    expect(projection.occurrences[0].offset).toBe(2);
  });
});