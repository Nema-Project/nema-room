/** Set at build time for the managed local desktop build; its UI and API share one origin. */
export const LOCAL_HUB_MODE = process.env.NEXT_PUBLIC_NEMA_LOCAL === "1";

/**
 * In the remote form the hub may sit on another origin, and its session cookie only travels with
 * credentials "include" (the hub's CORS answer allows credentials for its configured web origins only).
 * The managed local build shares one origin with its gateway, whose own session cookie needs same-origin.
 */
export const HUB_CREDENTIALS: RequestCredentials = LOCAL_HUB_MODE ? "same-origin" : "include";

/** Options for EventSource so the remote form's session cookie reaches a cross-origin hub too. */
export const hubEventSourceInit: EventSourceInit = LOCAL_HUB_MODE ? {} : { withCredentials: true };
