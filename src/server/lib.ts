export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
export const sha256 = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function sessionDigest(token: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export const randomToken = (bytes = 32) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
export async function hashPassword(password: string) {
  const salt = randomToken(16),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2$310000$${salt}$${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [kind, rounds, salt, expected] = stored.split("$");
  if (kind !== "pbkdf2" || !rounds || !salt || !expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: Number(rounds),
      hash: "SHA-256",
    },
    key,
    256,
  );
  const actual = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return (
    actual.length === expected.length &&
    [...actual].reduce(
      (n, c, i) => n | (c.charCodeAt(0) ^ expected.charCodeAt(i)),
      0,
    ) === 0
  );
}
export const parseList = (v: string | null | undefined): string[] => {
  const list: unknown = JSON.parse(v || "[]");
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string"))
    throw new Error("Invalid stored address list");
  return list;
};
export function safeFilename(name: string) {
  return name.replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
}
