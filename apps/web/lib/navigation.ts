/**
 * Full-page navigation, as an object so tests can observe it (jsdom's `location.assign` cannot be replaced).
 * A full load is deliberate for session changes: it drops every cached view of the previous session.
 */
export const pageNavigation = {
  assign(path: string): void {
    window.location.assign(path);
  },
};
