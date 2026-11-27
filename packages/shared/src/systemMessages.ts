/**
 * Phrase in the system message the hub posts to draw a newly bound repo's architecture diagram. The web
 * progress bar labels a running system task as "drawing a diagram" when its message contains it (#299
 * batch 0: producer and matcher share this constant). Stored messages keep the current wording, so a later
 * translation must keep matching it.
 */
export const ARCHITECTURE_DIAGRAM_MARKER = "画架构图";
