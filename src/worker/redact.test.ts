import { describe, expect, test } from "vitest";

import { stripInternalWorkerTags } from "./redact.js";

describe("stripInternalWorkerTags", () => {
  test("剥离完整内部区段", () => {
    const input = `好的，结果如下。\n\n<worker-continuation>\n涉及任务：\n- Work x：调研\n</worker-continuation>\n\n<worker-skill>\nWorker 可用\n</worker-skill>\n\n调研结论：使用 SQLite。`;
    const output = stripInternalWorkerTags(input);
    expect(output).not.toContain("<worker-continuation>");
    expect(output).not.toContain("<worker-skill>");
    expect(output).not.toContain("涉及任务");
    expect(output).toContain("调研结论：使用 SQLite");
  });

  test("剥离 worker-result 块（含属性）", () => {
    const input = `<worker-result work="wrk_1">\n- Job job_1：结果\n</worker-result>\n\n最终回复`;
    const output = stripInternalWorkerTags(input);
    expect(output).not.toContain("<worker-result");
    expect(output).toContain("最终回复");
  });

  test("剥离残留裸标签", () => {
    const input = "内容</worker-role>结尾";
    expect(stripInternalWorkerTags(input)).toBe("内容结尾");
  });

  test("正常回复不受影响", () => {
    const text = "这是普通回复，没有内部内容。";
    expect(stripInternalWorkerTags(text)).toBe(text);
  });

  test("剥离后合并多余空行", () => {
    const input = "开头\n\n\n\n\n结尾";
    expect(stripInternalWorkerTags(input)).toBe("开头\n\n结尾");
  });
});
