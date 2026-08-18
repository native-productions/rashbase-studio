import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { applyTranslucency, loadTranslucency } from "@/lib/translucency";
import "@/styles/theme.css";

// Before the first paint. The attribute decides what every chrome surface
// paints, so setting it after render would show one frame of opaque chrome.
void applyTranslucency(loadTranslucency());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
