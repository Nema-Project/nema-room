import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { DaemonsSettings } from "@/components/DaemonsSettings";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import en from "../messages/en.json";

vi.mock("@/lib/hub", async (importOriginal) => ({
  ...await importOriginal<typeof hub>(),
  listDaemons: vi.fn(),
  createDaemonRegistrationCode: vi.fn(),
  revokeDaemon: vi.fn(),
}));

test("keeps the current code on generation failure and still clears it at expiry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.mocked(hub.listDaemons).mockResolvedValue([]);
  vi.mocked(hub.createDaemonRegistrationCode)
    .mockResolvedValueOnce({ code: "current-code", expiresAt: new Date(Date.now() + 600_000).toISOString() })
    .mockRejectedValueOnce(new hub.HubError(429, "registration code limit"));
  try {
    render(<I18nProvider messages={{ en }}><DaemonsSettings /></I18nProvider>);
    const generate = screen.getByRole("button", { name: "Generate registration code" });
    await act(async () => { fireEvent.click(generate); });
    expect(screen.getByText("current-code")).toBeTruthy();
    await act(async () => { fireEvent.click(generate); });
    expect(screen.getByRole("alert").textContent).toMatch(/use one or wait for it to expire/i);
    expect(screen.getByText("current-code")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(screen.queryByText("current-code")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("refreshes daemon rows on window focus and retains the list when refresh fails", async () => {
  const laptop = { id: "dmn_1", label: "Laptop", lastSeenAt: null, revokedAt: null };
  const desktop = { ...laptop, id: "dmn_2", label: "Desktop" };
  const list = vi.mocked(hub.listDaemons).mockClear()
    .mockResolvedValueOnce([laptop])
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([laptop, desktop]);
  const view = render(<I18nProvider messages={{ en }}><DaemonsSettings /></I18nProvider>);
  await screen.findByText("Laptop");
  fireEvent.focus(window);
  await screen.findByRole("alert");
  expect(screen.getByText("Laptop")).toBeTruthy();
  fireEvent.focus(window);
  const newRow = (await screen.findByText("Desktop")).closest("li")!;
  expect(within(newRow).getByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  fireEvent.focus(window);
  expect(list).toHaveBeenCalledTimes(3);
});

test("displays a new code only for the current visit and asks before revoking a daemon", async () => {
  const laptop = { id: "dmn_1", label: "Laptop", lastSeenAt: "2026-11-24T12:00:00Z", revokedAt: null };
  vi.mocked(hub.listDaemons).mockResolvedValue([laptop, { id: "dmn_2", label: "Old Mac", lastSeenAt: null, revokedAt: "2026-11-24T12:00:00Z" }]);
  vi.mocked(hub.createDaemonRegistrationCode).mockImplementationOnce(async () => ({
    code: "one-time-code", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })).mockImplementationOnce(async () => ({
    code: "next-code", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }));
  vi.mocked(hub.revokeDaemon).mockResolvedValue({ revokedAt: "2026-11-25T12:00:00Z" });
  const user = userEvent.setup();
  const view = () => <I18nProvider messages={{ en }}><DaemonsSettings /></I18nProvider>;
  const initial = render(view());
  const laptopRow = (await screen.findByText("Laptop")).closest("li")!;
  expect(within(laptopRow).getByText("Registered")).toBeTruthy();
  expect(screen.getByText("Revoked")).toBeTruthy();
  expect(screen.getByText(/never connected/i)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Generate registration code" }));
  expect(await screen.findByText("one-time-code")).toBeTruthy();
  expect(screen.getByText(/expires/i)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Generate registration code" }));
  expect(await screen.findByText("next-code")).toBeTruthy();
  expect(screen.queryByText("one-time-code")).toBeNull();

  await user.click(within(laptopRow).getByRole("button", { name: "Revoke" }));
  expect(hub.revokeDaemon).not.toHaveBeenCalled();
  await user.click(within(laptopRow).getByRole("button", { name: "Confirm revocation" }));
  expect(hub.revokeDaemon).toHaveBeenCalledWith("dmn_1");
  expect(await within(laptopRow).findByText("Revoked")).toBeTruthy();

  initial.unmount();
  render(view());
  await screen.findByText("Laptop");
  expect(screen.queryByText("next-code")).toBeNull();
});
