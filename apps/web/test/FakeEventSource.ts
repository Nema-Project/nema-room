export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
  open() { this.onopen?.(); }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
  close() { this.closed = true; }
  static reset() { FakeEventSource.instances = []; }
  static forWorkspace(id: string) { return this.instances.find((source) => source.url.includes(`/workspaces/${id}/events`)); }
}
