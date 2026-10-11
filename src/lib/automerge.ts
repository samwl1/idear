// Automerge's "slim" build plus an inlined wasm binary: no bundler plugin needed.
import * as A from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";

let ready: Promise<void> | null = null;

export function initAutomerge(): Promise<void> {
  ready ??= A.initializeBase64Wasm(automergeWasmBase64);
  return ready;
}

export { A };
