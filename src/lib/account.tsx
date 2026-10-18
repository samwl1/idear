import { createContext, useContext } from "react";
import type { AccountView } from "./api";

export interface AccountCtx {
  account: AccountView | null;
  setAccount: (a: AccountView) => void;
}

export const AccountContext = createContext<AccountCtx>({ account: null, setAccount: () => {} });

export const useAccount = () => useContext(AccountContext);

/**
 * Group a hex key into blocks for reading aloud or comparing: "a1b2 c3d4 …".
 * The whole key by default: a prefix is easy to collide on purpose, and a
 * check over the phone only means something against all of it.
 */
export function fingerprint(id: string, groups?: number): string {
  const blocks = id.match(/.{1,4}/g) ?? [];
  return (groups ? blocks.slice(0, groups) : blocks).join(" ");
}

/** `@me` in an assignee filter means your own name. */
export function expandMe(text: string, name: string): string {
  return name ? text.replace(/@me\b/gi, name) : text;
}
