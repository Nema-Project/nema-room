import { AuthRateLimitedError, ReloginRequiredError } from "../direct/authStore.js";
import { ByokRejectedError, ModelApiError, ModelQuotaError } from "../direct/transport.js";

/**
 * Why a model call failed, in the terms routing needs (spec 2026-10-31 §4.3). The split is not "retryable or
 * not": it is "would the user's other account do any better".
 *
 * The provider's own words decide, not the status code alone. A 400 that names the context window is a
 * different thing from a 400 that names a bad parameter, and a provider that answers 200 with an error event
 * still gets classified by what that event says (the transport already turns those into the same errors).
 */
export type RouteFailure =
  | "rate_limit"
  | "quota"
  | "server"
  | "context"
  | "auth"
  | "policy"
  | "bad_request"
  | "streaming_started"
  | "unknown";

export type SwitchDecision = { switch: true } | { switch: false; because: string };

const CONTEXT = /context[_ ]length|context window|too many tokens|prompt is too long|maximum context/i;

export function classifyFailure(e: unknown, o: { startedOutput: boolean }): RouteFailure {
  // Highest priority, whatever the error is: the user has already seen part of this answer, and a second
  // account would continue with a different model's text.
  if (o.startedOutput) return "streaming_started";
  if (e instanceof ModelQuotaError) return "quota";
  if (e instanceof ByokRejectedError || e instanceof ReloginRequiredError) return "auth";
  if (e instanceof AuthRateLimitedError) return "rate_limit";
  if (e instanceof ModelApiError) {
    const status = e.status;
    if (status === 429) return "rate_limit";
    if (status !== undefined && status >= 500) return "server";
    if (status === 401) return "auth";
    if (status === 403) return "policy";
    if (status === 400 && CONTEXT.test(e.message)) return "context";
    if (status !== undefined && status >= 400) return "bad_request";
    // A connection failure the transport already retried once, or a failure with no status at all.
    return "unknown";
  }
  return "unknown";
}

/**
 * Whether another account could plausibly answer where this one did not. A different key is a different
 * limit, so limits switch. It is not a different request, so a malformed one does not; and it is not a
 * different policy, so a refusal by the provider's rules does not either — switching there would be
 * helping the user around a provider's decision.
 */
export function shouldSwitch(failure: RouteFailure): SwitchDecision {
  switch (failure) {
    case "rate_limit":
      return { switch: true };
    case "quota":
      return { switch: true };
    case "server":
      return { switch: true };
    case "context":
      return { switch: true };
    case "auth":
      return { switch: false, because: "这是这个账户凭据的问题，换账户会掩盖它" };
    case "policy":
      return { switch: false, because: "这是供应商的内容策略，换账户等于绕过它" };
    case "bad_request":
      return { switch: false, because: "请求本身有问题，换账户也一样会失败" };
    case "streaming_started":
      return { switch: false, because: "已经开始输出，不会再换账户" };
    case "unknown":
      return { switch: false, because: "错误原因不明，不猜着换账户" };
  }
}
