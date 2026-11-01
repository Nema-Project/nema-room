"use client";

import { useCallback, useEffect, useState } from "react";
import { accountsApi, type AccountView } from "@/lib/accounts";

/**
 * The accounts this machine has, for the pickers. One fetch per component that asks; the answer is small
 * (no credentials) and local, and a shared store would only add a cache to invalidate after every edit.
 *
 * `supported: false` means the daemon has no accounts route. Every caller uses it to keep the picker off
 * the page, which is what makes a 0.2.0 daemon look exactly like 0.2.0.
 */
export type AccountsState = {
  accounts: AccountView[];
  bindings: Record<string, string>;
  defaultAccountId: string;
  /** The machine-wide automatic routing switch (D-3). Off by default, including for an older daemon. */
  autoRouting: boolean;
  supported: boolean;
  reload: () => void;
};

export function useAccounts(): AccountsState {
  const [state, setState] = useState<Omit<AccountsState, "reload">>({
    accounts: [],
    bindings: {},
    defaultAccountId: "",
    autoRouting: false,
    supported: true,
  });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void accountsApi.list(controller.signal).then((list) => {
      if (controller.signal.aborted) return;
      setState({
        accounts: list.accounts ?? [],
        bindings: list.bindings ?? {},
        defaultAccountId: list.defaultAccountId ?? "",
        // An older daemon's answer has no switch in it, which reads as off — the same thing a missing key in
        // `accounts.json` means.
        autoRouting: list.autoRouting === true,
        supported: true,
      });
    }).catch(() => {
      if (controller.signal.aborted) return;
      // Both "older daemon" and "could not ask" leave no picker: a control whose save would fail is worse
      // than no control, and neither case has accounts to offer.
      setState({ accounts: [], bindings: {}, defaultAccountId: "", autoRouting: false, supported: false });
    });
    return () => controller.abort();
  }, [version]);

  return { ...state, reload };
}
