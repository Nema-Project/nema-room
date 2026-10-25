import { randomBytes } from "node:crypto";

const TICKET_LIFETIME_MS = 60_000;

export type SessionManagerOptions = {
  /** Clock hook for deterministic expiry tests. */
  now?: () => number;
};

/** Holds launch tickets and runtime-only browser sessions in memory. */
export class SessionManager {
  private readonly now: () => number;
  private readonly tickets = new Map<string, number>();
  private readonly sessions = new Set<string>();
  private closed = false;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  issueTicket(): string {
    if (this.closed) throw new Error("Session manager is closed");
    this.pruneExpiredTickets();
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, this.now() + TICKET_LIFETIME_MS);
    return ticket;
  }

  consumeTicket(ticket: string): string | null {
    if (this.closed || !/^[0-9a-f]{64}$/.test(ticket)) return null;
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (expiresAt === undefined || expiresAt <= this.now()) return null;
    const token = randomBytes(32).toString("hex");
    this.sessions.add(token);
    return token;
  }

  isValidSession(token: string): boolean {
    return !this.closed && /^[0-9a-f]{64}$/.test(token) && this.sessions.has(token);
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  close(): void {
    this.closed = true;
    this.tickets.clear();
    this.sessions.clear();
  }

  private pruneExpiredTickets(): void {
    const now = this.now();
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
