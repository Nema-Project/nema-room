import { DAEMON_ERROR, isErrorCode, readCodeParams, type CodeParams, type CodedText } from "@nema/shared";
import { graphifyErrorText } from "./graphifyText";
import type { HubError } from "./hub";
import type { useT } from "./i18n";

type T = ReturnType<typeof useT>;

/**
 * `t(key, params)` when the catalog has the key, else null. `t` answers a missing key with the key itself,
 * which must never reach the page: the caller shows its fallback text instead (#299 batch 1).
 */
export function lookup(t: T, key: string, params?: CodeParams): string | null {
  const text = t(key, params);
  return text === key ? null : text;
}

/** Codes shown with a message that already exists elsewhere in the catalog (#297's component copy), instead of an `error.` key. */
export const ERROR_KEY: Readonly<Record<string, string>> = {
  [DAEMON_ERROR.componentOfferChanged]: "components.reason.offerChanged",
};

/**
 * The text to show for a failed hub request, in the page's language when the hub sent a code the catalog
 * knows (`error.<code>`), else the hub's own message. Errors from older hubs and daemons carry no code and
 * are shown exactly as before.
 */
export function hubErrorText(err: unknown, t: T): string {
  if (!(err instanceof Error)) return String(err);
  // Read by shape rather than `instanceof HubError`, so a caller's own error class (or a test double of the
  // hub client) works too. A code is only used when it is well formed and the catalog knows it, so a Node
  // `code` such as ENOENT falls through to the message.
  const { graphifyError, code, params } = err as Partial<Pick<HubError, "graphifyError" | "code" | "params">>;
  if (graphifyError) return graphifyErrorText(graphifyError, t);
  if (isErrorCode(code)) {
    const text = lookup(t, ERROR_KEY[code] ?? `error.${code}`, readCodeParams(params));
    if (text !== null) return text;
  }
  return err.message;
}

/** One localisable line: `progress.<code>` when the catalog has it, else the fallback text. */
export function codedText(item: CodedText, t: T): string {
  return (item.code && lookup(t, `progress.${item.code}`, item.params)) || item.text;
}

/** What a running task's progress line carries; `text` is always there. */
export type ProgressLine = { text: string; code?: string; params?: CodeParams; items?: CodedText[] };

/** A route failure as a phrase ("was rate limited"); an unknown reason reads as a plain failure. */
function routeFailure(reason: string | number | undefined, t: T): string {
  return lookup(t, `route.failure.${String(reason)}`) ?? t("route.failure.unknown");
}

/**
 * A progress line in the page's language. A line without a code, or one whose code the catalog does not
 * know, is shown as the daemon wrote it. A list line (`items`) renders each item the same way and joins them.
 */
export function progressText(line: ProgressLine, t: T): string {
  if (!line.code) return line.text;
  const params: CodeParams = { ...line.params };
  // The account switch reuses the route failure phrases the message route line already shows.
  if (line.code === "route.switch") params.reason = routeFailure(line.params?.reason, t);
  if (line.items) params.items = line.items.map((item) => codedText(item, t)).join(t("progress.separator"));
  return lookup(t, `progress.${line.code}`, params) ?? line.text;
}
