import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CoreApi } from "./api";
import "./styles.css";

// The core port + session token are passed by the Electron main process as
// ?port=NNNN&token=…. When run in a plain browser for development, fall back to
// the default core port (add ?token=<value from ~/.aive/data/server.json>).
const params = new URLSearchParams(window.location.search);
const port = Number(params.get("port")) || 4789;
const token = params.get("token") ?? "";

const api = new CoreApi(port, token);
api.connect();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
);
