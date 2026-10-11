/// <reference types="vite/client" />

interface Window {
  /** Where Excalidraw loads its fonts from (copied into public/ by scripts/copy-excalidraw-fonts.mjs). */
  EXCALIDRAW_ASSET_PATH?: string | string[];
}
