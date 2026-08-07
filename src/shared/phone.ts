import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhone(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, "");
  const parsed = parsePhoneNumberFromString(compact, "CN");
  if (!parsed?.isValid()) throw new Error("请输入有效的国际手机号");
  return parsed.number;
}
