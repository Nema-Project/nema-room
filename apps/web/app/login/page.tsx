"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { HubError, getMe, login } from "@/lib/hub";
import { useT } from "@/lib/i18n";

type Failure = "invalid" | "locked" | "unavailable";

/**
 * Remote-form sign-in (#167 task 7). Whether someone is signed in is decided only by GET /api/me: an answer
 * means a session (or the local form, which has no login) and goes straight to the room; a 401 shows the form.
 * A refused login shows one message whether the account is unknown or the password is wrong.
 */
export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const accountId = useId();
  const passwordId = useId();
  const [checking, setChecking] = useState(true);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    let live = true;
    getMe().then(() => {
      if (live) router.replace("/");
    }).catch(() => {
      if (live) setChecking(false);
    });
    return () => { live = false; };
  }, [router]);

  async function submit() {
    if (busy || account.trim() === "" || password === "") return;
    setBusy(true);
    setFailure(null);
    try {
      await login(account.trim(), password);
      router.replace("/");
    } catch (error) {
      const status = error instanceof HubError ? error.status : 0;
      setFailure(status === 401 ? "invalid" : status === 429 ? "locked" : "unavailable");
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form
        className="login-form"
        aria-labelledby="login-title"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <h1 id="login-title">{t("login.title")}</h1>
        <label htmlFor={accountId}>{t("login.account")}</label>
        <input
          id={accountId}
          type="text"
          name="account"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={account}
          disabled={checking}
          onChange={(event) => setAccount(event.target.value)}
        />
        <label htmlFor={passwordId}>{t("login.password")}</label>
        <input
          id={passwordId}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={checking}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={checking || busy}>{busy ? t("login.submitting") : t("login.submit")}</button>
        {failure && <p className="error" role="alert">{t(`login.error.${failure}`)}</p>}
      </form>
    </main>
  );
}
