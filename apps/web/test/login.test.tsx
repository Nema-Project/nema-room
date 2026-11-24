import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/login/page";
import { AppSettings } from "@/components/AppSettings";
import { resetAppReleaseForTests } from "@/components/AppRelease";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import { pageNavigation } from "@/lib/navigation";

const { replace, FakeHubError } = vi.hoisted(() => ({
  replace: vi.fn(),
  FakeHubError: class FakeHubError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace }) }));

vi.mock("@/lib/hub", () => ({
  HubError: FakeHubError,
  LOGIN_PATH: "/login",
  getMe: vi.fn(),
  updateMe: vi.fn(async (displayName: string | null) => ({ userId: "usr_local", displayName })),
  login: vi.fn(),
  logout: vi.fn(async () => ({ ok: true })),
  listExtensions: vi.fn(async () => []),
  discoverExtensions: vi.fn(async () => ({ locations: [], skills: [], truncated: false })),
  getComponents: vi.fn(async () => ({ components: [] })),
  getAgentClis: vi.fn(async () => ({ agents: [] })),
}));

const unauthorized = () => new FakeHubError(401, "unauthorized");

beforeEach(() => {
  replace.mockReset();
  vi.mocked(hub.getMe).mockReset();
  vi.mocked(hub.login).mockReset();
  vi.mocked(hub.logout).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

afterEach(() => {
  resetAppReleaseForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderLogin() {
  render(<I18nProvider><LoginPage /></I18nProvider>);
}

async function fillAndSubmit(account: string, password: string) {
  const accountBox = screen.getByLabelText("Account") as HTMLInputElement;
  await waitFor(() => expect(accountBox.disabled).toBe(false));
  await userEvent.type(accountBox, account);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("login page", () => {
  it("renders the account and password form when GET /api/me answers 401", async () => {
    vi.mocked(hub.getMe).mockRejectedValue(unauthorized());
    renderLogin();
    expect(screen.getByRole("heading", { name: "Sign in to Nema Room" })).toBeTruthy();
    const account = screen.getByLabelText("Account") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("current-password");
    await waitFor(() => expect(account.disabled).toBe(false));
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes straight to the room when GET /api/me already answers", async () => {
    vi.mocked(hub.getMe).mockResolvedValue({ userId: "usr_alice", displayName: "Alice" });
    renderLogin();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(hub.login).not.toHaveBeenCalled();
  });

  it("posts the credentials and goes to / after a successful login", async () => {
    vi.mocked(hub.getMe).mockRejectedValue(unauthorized());
    vi.mocked(hub.login).mockResolvedValue({ userId: "usr_alice" });
    renderLogin();
    await fillAndSubmit(" usr_alice ", "correct horse");
    await waitFor(() => expect(hub.login).toHaveBeenCalledWith("usr_alice", "correct horse"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one message for a 401, whatever the cause, and stays on the page", async () => {
    vi.mocked(hub.getMe).mockRejectedValue(unauthorized());
    vi.mocked(hub.login).mockRejectedValue(new FakeHubError(401, "invalid credentials"));
    renderLogin();
    await fillAndSubmit("usr_nobody", "wrong");
    expect((await screen.findByRole("alert")).textContent).toBe("The account or password is incorrect.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains a lockout without naming the account", async () => {
    vi.mocked(hub.getMe).mockRejectedValue(unauthorized());
    vi.mocked(hub.login).mockRejectedValue(new FakeHubError(429, "too many failed attempts; try again later"));
    renderLogin();
    await fillAndSubmit("usr_alice", "pw");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many failed attempts. Try again later.");
  });
});

describe("session entry in app settings", () => {
  async function openGeneral() {
    render(<I18nProvider><AppSettings onClose={vi.fn()} /></I18nProvider>);
    await userEvent.click(screen.getByRole("tab", { name: "General" }));
  }

  it("shows the signed-in name and signs out through POST /api/auth/logout", async () => {
    const assign = vi.spyOn(pageNavigation, "assign").mockImplementation(() => {});
    vi.mocked(hub.getMe).mockResolvedValue({ userId: "usr_alice", displayName: "Alice" });
    await openGeneral();
    expect(await screen.findByText("Signed in as Alice")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(hub.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("treats a 401 from logout as already signed out, and explains any other failure", async () => {
    const assign = vi.spyOn(pageNavigation, "assign").mockImplementation(() => {});
    vi.mocked(hub.getMe).mockResolvedValue({ userId: "usr_alice", displayName: "Alice" });
    vi.mocked(hub.logout).mockRejectedValueOnce(new FakeHubError(500, "boom")).mockRejectedValueOnce(unauthorized());
    await openGeneral();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    expect(assign).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("names the account id when the user has no display name", async () => {
    vi.mocked(hub.getMe).mockResolvedValue({ userId: "usr_bob", displayName: null });
    await openGeneral();
    expect(await screen.findByText("Signed in as usr_bob")).toBeTruthy();
  });

  it("renders nothing for usr_local (single-machine form, D-10)", async () => {
    vi.mocked(hub.getMe).mockResolvedValue({ userId: "usr_local", displayName: null });
    await openGeneral();
    // The display-name field also reads /api/me; once it is enabled the answer has arrived.
    const name = await screen.findByRole("textbox", { name: "Display name" }) as HTMLInputElement;
    await waitFor(() => expect(name.disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByText(/Signed in/)).toBeNull();
  });
});

describe("hub API layer and the login redirect", () => {
  async function loadHub(local: boolean) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NEMA_LOCAL", local ? "1" : "0");
    vi.stubEnv("NEXT_PUBLIC_HUB_URL", "http://127.0.0.1:4400");
    const navigation = await import("@/lib/navigation");
    const assign = vi.spyOn(navigation.pageNavigation, "assign").mockImplementation(() => {});
    const real = await vi.importActual<typeof import("@/lib/hub")>("@/lib/hub");
    return { real, assign };
  }

  function stubFetch(status: number, body: unknown = { error: "unauthorized" }) {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("sends credentials to a cross-origin hub and goes to /login on a session 401", async () => {
    const { real, assign } = await loadHub(false);
    const fetchMock = stubFetch(401);
    await expect(real.listWorkspaces()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("does not redirect while already on /login", async () => {
    const { real, assign } = await loadHub(false);
    window.history.replaceState(null, "", "/login");
    stubFetch(401);
    await expect(real.getMe()).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not redirect for a refused login or for other errors", async () => {
    const { real, assign } = await loadHub(false);
    const fetchMock = stubFetch(401, { error: "invalid credentials" });
    await expect(real.login("usr_alice", "wrong")).rejects.toMatchObject({ status: 401, message: "invalid credentials" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4400/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({ account: "usr_alice", password: "wrong" });
    stubFetch(403, { error: "forbidden" });
    await expect(real.listWorkspaces()).rejects.toMatchObject({ status: 403 });
    expect(assign).not.toHaveBeenCalled();
  });

  it("never redirects in the managed local build, whose 401 comes from the desktop gateway", async () => {
    const { real, assign } = await loadHub(true);
    const fetchMock = stubFetch(401);
    await expect(real.listWorkspaces()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workspaces");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
    expect(assign).not.toHaveBeenCalled();
  });
});
