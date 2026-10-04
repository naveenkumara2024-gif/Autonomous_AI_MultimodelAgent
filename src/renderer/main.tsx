import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverlayWindow } from "./OverlayWindow";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("renderer: #root element missing from index.html");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {window.location.hash === "#overlay" ? <OverlayWindow /> : <App />}
  </React.StrictMode>,
);
