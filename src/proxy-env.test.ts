import { describe, expect, test } from "vitest";
import { summarizeProxyEnvironment } from "./proxy-env.js";

describe("summarizeProxyEnvironment", () => {
  test("redacts proxy credentials and reports no_proxy coverage", () => {
    const summary = summarizeProxyEnvironment({
      https_proxy: "http://user:secret@127.0.0.1:7890",
      ALL_PROXY: "socks5://proxy.local:7891",
      no_proxy: "localhost,open.feishu.cn,internal.local",
    });

    expect(summary).toEqual({
      httpProxy: "unset",
      httpsProxy: "http://127.0.0.1:7890",
      allProxy: "socks5://proxy.local:7891",
      noProxyEntries: 3,
      noProxyHasFeishu: true,
    });
  });

  test("handles proxy values without a URL scheme", () => {
    const summary = summarizeProxyEnvironment({
      HTTP_PROXY: "127.0.0.1:7890",
    });

    expect(summary.httpProxy).toBe("set");
    expect(summary.httpsProxy).toBe("unset");
    expect(summary.allProxy).toBe("unset");
  });

  test("uses no_proxy when npm_config_no_proxy is empty and accepts ports", () => {
    const summary = summarizeProxyEnvironment({
      npm_config_no_proxy: " ",
      NO_PROXY: "open.feishu.cn:443",
    });

    expect(summary.noProxyEntries).toBe(1);
    expect(summary.noProxyHasFeishu).toBe(true);
  });

  test("recognizes bare feishu domains in no_proxy", () => {
    const summary = summarizeProxyEnvironment({
      no_proxy: "localhost,feishu.cn",
    });

    expect(summary.noProxyHasFeishu).toBe(true);
  });

  test("recognizes wildcard no_proxy entries", () => {
    expect(summarizeProxyEnvironment({ no_proxy: "*" }).noProxyHasFeishu).toBe(true);
    expect(summarizeProxyEnvironment({ no_proxy: "*.feishu.cn" }).noProxyHasFeishu).toBe(true);
  });
});
