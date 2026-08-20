import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { applyTranslucency, loadTranslucency } from "@/lib/translucency";
import { applyPrefs, loadPrefs } from "@/lib/prefs";
import "@/styles/theme.css";

// Before the first paint. The attributes decide what every surface paints and
// how large it is, so setting them after render would show one frame of the
// wrong palette at the wrong size.
applyPrefs(loadPrefs());
void applyTranslucency(loadTranslucency());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
