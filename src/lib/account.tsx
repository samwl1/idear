import { createContext, useContext } from "react";
import type { AccountView } from "./api";

export interface AccountCtx {
  account: AccountView | null;
  setAccount: (a: AccountView) => void;
}

export const AccountContext = createContext<AccountCtx>({ account: null, setAccount: () => {} });

export const useAccount = () => useContext(AccountContext);

/** Group a hex key into blocks for reading aloud or comparing: "a1b2 c3d4 e5f6 7890". */
export function fingerprint(id: string, groups = 4): string {
  return (id.match(/.{1,4}/g) ?? []).slice(0, groups).join(" ");
}

/** `@me` in an assignee filter means your own name. */
export function expandMe(text: string, name: string): string {
  return name ? text.replace(/@me\b/gi, name) : text;
}
