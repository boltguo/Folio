import { i18n } from "../i18n";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly messageId?: string,
    public readonly code?: string,
    public readonly details?: string,
  ) {
    super(message);
  }
}
export function errorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code &&
    i18n.global.te(`errors.${error.code}`)
  ) {
    const message = i18n.global.t(`errors.${error.code}`);
    return error.details
      ? `${message} ${i18n.global.t("errors.technical", { detail: error.details })}`
      : message;
  }
  return error instanceof Error
    ? error.message
    : i18n.global.t("errors.generic");
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (error) {
    if (error instanceof TypeError)
      throw new ApiError(i18n.global.t("errors.network"), 0);
    throw error;
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(i18n.global.t("errors.response"), response.status);
  }
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    const error =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : i18n.global.t("errors.request", { status: response.status });
    const messageId =
      typeof data === "object" &&
      data !== null &&
      "messageId" in data &&
      typeof data.messageId === "string"
        ? data.messageId
        : undefined;
    const code =
      typeof data === "object" &&
      data !== null &&
      "code" in data &&
      typeof data.code === "string"
        ? data.code
        : undefined;
    const details =
      typeof data === "object" &&
      data !== null &&
      "details" in data &&
      typeof data.details === "string"
        ? data.details
        : undefined;
    throw new ApiError(error, response.status, messageId, code, details);
  }
  return data as T;
}
export const post = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api(path, { method: "DELETE" });
