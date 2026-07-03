import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CoreApi } from "./api";
import "./styles.css";

// The core port is passed by the Electron main process as ?port=NNNN. When run
// in a plain browser for development, fall back to the default core port.
const params = new URLSearchParams(window.location.search);
const port = Number(params.get("port")) || 4789;

const api = new CoreApi(port);
api.connect();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
);
