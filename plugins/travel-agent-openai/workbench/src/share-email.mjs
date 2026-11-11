export function normalizeShareEmail(value) {
  if (typeof value !== "string") throw new Error("请输入对方用于 Google 登录的邮箱。");
  const address = value.trim();
  const at = address.indexOf("@");
  if (address.length > 254 || at <= 0 || at !== address.lastIndexOf("@") || at >= address.length - 1
      || address.slice(at + 1).indexOf(".") <= 0 || address.endsWith(".") || /[\s\p{Cc}]/u.test(address))
    throw new Error("请输入对方用于 Google 登录的邮箱。");
  const domain = address.slice(at + 1).normalize("NFC").toLowerCase();
  const local = address.slice(0, at);
  return `${domain === "gmail.com" ? local.toLowerCase() : local}@${domain}`;
}

/** Raw email is kept in the app; only the digest is sent to the owner-only directory tool. */
export async function shareEmailDigest(value) {
  const email = normalizeShareEmail(value);
  if (!globalThis.crypto?.subtle) throw new Error("当前宿主无法安全查找账号，请重新连接旅行插件。");
  const bytes = new TextEncoder().encode(`travel-share-email-v1:${email}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}
