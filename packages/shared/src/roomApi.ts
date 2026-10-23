import type { Entry, EntrySummary } from "./entry.js";

export type ListEntriesResponse = { entries: EntrySummary[] };
export type GetEntryResponse = { entry: Entry };
export type UpsertEntryResponse = { entry: Entry; commit: string };
