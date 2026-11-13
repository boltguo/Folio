import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, canEditSend } from "../src/client/lib/api";

afterEach(() => vi.restoreAllMocks());

describe("send error metadata", () => {
  it("preserves the server's submission decision and provider reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: "Invalid sender",
          code: "SEND_REJECTED",
          details: "Sender verification is required",
          messageId: "message",
          submissionState: "not_accepted",
          retryable: false,
          canEdit: true,
          providerCode: "validation_error",
          retryAfter: 120,
        },
        { status: 422 },
      ),
    );
    const result = await api("/send").catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ApiError);
    expect(result).toMatchObject({
      code: "SEND_REJECTED",
      messageId: "message",
      details: "Sender verification is required",
      submissionState: "not_accepted",
      retryable: false,
      canEdit: true,
      providerCode: "validation_error",
      retryAfter: 120,
    });
    expect(canEditSend(result, true)).toBe(true);
  });

  it("only unlocks a retry when the server proves that the stored request was not accepted", () => {
    expect(
      canEditSend(
        new ApiError("Rejected", 422, "message", "SEND_REJECTED", undefined, {
          submissionState: "not_accepted",
          retryable: false,
          canEdit: true,
        }),
        true,
      ),
    ).toBe(true);
    for (const submissionState of ["uncertain", "accepted"] as const)
      expect(
        canEditSend(
          new ApiError("Error", 502, "message", "SEND_UNCONFIRMED", undefined, {
            submissionState,
            canEdit: true,
          }),
          true,
        ),
      ).toBe(false);
    expect(
      canEditSend(
        new ApiError(
          "Rate limited",
          429,
          "message",
          "SEND_RATE_LIMITED",
          undefined,
          { submissionState: "not_accepted", retryable: true, canEdit: false },
        ),
        true,
      ),
    ).toBe(false);
    expect(
      canEditSend(
        new ApiError("No key", 400, undefined, "INVALID_SEND_KEY", undefined, {
          submissionState: "not_accepted",
          canEdit: true,
        }),
        true,
      ),
    ).toBe(false);
  });

  it("unlocks initial validation errors without treating a failed retry as a new send", () => {
    for (const code of [
      "INVALID_INPUT",
      "AUTH_REQUIRED",
      "TOO_LARGE",
      "SENDER_DISABLED",
      "RESEND_CONFIG",
    ]) {
      const error = new ApiError("Request rejected", 400, undefined, code);
      expect(canEditSend(error, false)).toBe(true);
      expect(canEditSend(error, true)).toBe(false);
    }
    expect(canEditSend(new ApiError("Network error", 0), false)).toBe(false);
    expect(canEditSend(new ApiError("Unexpected error", 503), false)).toBe(
      false,
    );
    expect(canEditSend(new Error("Unexpected error"), false)).toBe(false);
  });
});
