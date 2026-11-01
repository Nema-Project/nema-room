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
  supported: boolean;
  reload: () => void;
};

export function useAccounts(): AccountsState {
  const [state, setState] = useState<Omit<AccountsState, "reload">>({
    accounts: [],
    bindings: {},
    defaultAccountId: "",
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
        supported: true,
      });
    }).catch(() => {
      if (controller.signal.aborted) return;
      // Both "older daemon" and "could not ask" leave no picker: a control whose save would fail is worse
      // than no control, and neither case has accounts to offer.
      setState({ accounts: [], bindings: {}, defaultAccountId: "", supported: false });
    });
    return () => controller.abort();
  }, [version]);

  return { ...state, reload };
}
