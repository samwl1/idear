import "./assetPath"; // must run before any Excalidraw code
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import App from "./App";
import { initPrefs } from "./lib/prefs";
import { flushAll } from "./lib/pending";

initPrefs();

// The backend asks a closing window to save first (see App). This is the
// fallback for ways out it doesn't hear about, such as a reload: hand over
// whatever is still waiting on a typing pause, and hope it gets through.
window.addEventListener("pagehide", flushAll);
window.addEventListener("beforeunload", flushAll);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
