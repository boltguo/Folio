import { createI18n } from "vue-i18n";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export type Locale = "en" | "zh-CN";
const storageKey = "folio.locale";
export const isLocale = (value: unknown): value is Locale =>
  value === "en" || value === "zh-CN";
export function detectLocale(
  saved: unknown,
  languages: readonly string[],
): Locale {
  if (isLocale(saved)) return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}
export const i18n = createI18n({
  legacy: false,
  locale: "en" as Locale,
  fallbackLocale: "en",
  messages: { en, "zh-CN": zhCN },
});

function applyLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  document.title = i18n.global.t("app.title");
}
export function initializeLocale() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch (error) {
    console.warn("locale_preference_unavailable", error);
  }
  applyLocale(detectLocale(saved, navigator.languages));
}
export function setLocale(locale: Locale): boolean {
  applyLocale(locale);
  try {
    localStorage.setItem(storageKey, locale);
    return true;
  } catch (error) {
    console.warn("locale_preference_not_saved", error);
    return false;
  }
}
