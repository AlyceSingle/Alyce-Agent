import enTranslations from "./en.js";
import zhTranslations from "./zh.js";
import type { UiLocale, TranslationParams } from "./types.js";

let currentLocale: UiLocale = "en";

const LOCALE_BCP47: Record<UiLocale, string> = {
  en: "en-US",
  zh: "zh-CN"
};

export function setLocale(locale: UiLocale): void {
  currentLocale = locale;
}

export function getLocale(): UiLocale {
  return currentLocale;
}

export function t(key: string, params?: TranslationParams): string {
  const translations = currentLocale === "zh" ? zhTranslations : enTranslations;
  let text: string = translations[key] ?? enTranslations[key] ?? key;
  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replaceAll(`{${paramKey}}`, String(paramValue));
    }
  }
  return text;
}

export function formatDate(
  value: string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "";
  }
  const bcp47 = LOCALE_BCP47[currentLocale];
  return new Intl.DateTimeFormat(bcp47, options).format(date);
}

export function formatTime(value: string | Date): string {
  return formatDate(value, { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value: string | Date): string {
  return formatDate(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export type { UiLocale, TranslationParams };
