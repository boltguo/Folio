import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLocale,
  i18n,
  initializeLocale,
  setLocale,
} from "../src/client/i18n";
import { ApiError, errorMessage } from "../src/client/lib/api";
import en from "../src/client/locales/en";
import zhCN from "../src/client/locales/zh-CN";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  });
  vi.stubGlobal("navigator", { languages: ["zh-CN", "en-US"] });
  vi.stubGlobal("document", { documentElement: { lang: "" }, title: "" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.global.locale.value = "en";
});

describe("language preferences", () => {
  it("uses a saved supported locale, then browser preference order, then English", () => {
    expect(detectLocale("en", ["zh-CN"])).toBe("en");
    expect(detectLocale("invalid", ["fr-FR", "zh-TW", "en"])).toBe("zh-CN");
    expect(detectLocale(null, ["en-GB", "zh-CN"])).toBe("en");
    expect(detectLocale(null, ["fr-FR"])).toBe("en");
  });
  it("switches UI strings, metadata and pluralized counts, and persists across initialization", () => {
    initializeLocale();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(i18n.global.t("nav.settings")).toBe("设置");
    expect(setLocale("en")).toBe(true);
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Folio — Your domains, one inbox");
    expect(i18n.global.t("mail.messageCount", 1)).toBe("1 message");
    expect(i18n.global.t("mail.messageCount", 2)).toBe("2 messages");
    i18n.global.locale.value = "zh-CN";
    initializeLocale();
    expect(i18n.global.locale.value).toBe("en");
  });
  it("still switches language and reports when browser storage is unavailable", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(setLocale("zh-CN")).toBe(false);
    expect(i18n.global.t("auth.logout")).toBe("退出登录");
    expect(warn).toHaveBeenCalledOnce();
  });
  it("provides matching catalog keys and compiles every translation with interpolation", () => {
    function keys(value: Record<string, unknown>, prefix = ""): string[] {
      return Object.entries(value).flatMap(([key, item]) =>
        typeof item === "string"
          ? [prefix + key]
          : keys(item as Record<string, unknown>, `${prefix}${key}.`),
      );
    }
    expect(keys(zhCN).sort()).toEqual(keys(en).sort());
    for (const locale of ["en", "zh-CN"] as const) {
      i18n.global.locale.value = locale;
      for (const key of keys(en)) {
        expect(
          i18n.global.t(key, {
            count: 2,
            page: 1,
            total: 2,
            status: "test",
            size: "1.0",
            name: "file.txt",
            email: "user@example.com",
            recipients: "user@example.com",
            detail: "provider detail",
          }),
        ).not.toBe(key);
      }
    }
  });
  it("localizes stable API error codes without translating provider diagnostics", () => {
    i18n.global.locale.value = "zh-CN";
    expect(
      errorMessage(
        new ApiError(
          "Invalid email or password",
          401,
          undefined,
          "INVALID_CREDENTIALS",
        ),
      ),
    ).toBe("邮箱或密码不正确。");
    const detail = "Provider request abc123 timed out";
    expect(
      errorMessage(
        new ApiError(
          "Unknown outcome",
          502,
          undefined,
          "SEND_UNCONFIRMED",
          detail,
        ),
      ),
    ).toContain(detail);
    i18n.global.locale.value = "en";
    expect(
      errorMessage(
        new ApiError(
          "Invalid email or password",
          401,
          undefined,
          "INVALID_CREDENTIALS",
        ),
      ),
    ).toBe("Incorrect email or password.");
  });
});
