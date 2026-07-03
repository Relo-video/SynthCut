// Preload script: exposes a minimal, safe bridge to the renderer. The renderer
// has no direct Node access — only these explicit functions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aive", {
  platform: process.platform,
  /** Open a native file picker; returns an array of absolute paths. */
  pickFiles: () => ipcRenderer.invoke("dialog:openFiles"),
  /** Open a native save dialog; returns an absolute path or null. */
  pickSavePath: () => ipcRenderer.invoke("dialog:saveFile"),
  /** Open a native picker for a .aive project; returns an absolute path or null. */
  openProject: () => ipcRenderer.invoke("dialog:openProject"),
  /** Native save dialog for a .aive project; returns an absolute path or null. */
  saveProjectAs: (defaultName) => ipcRenderer.invoke("dialog:saveProject", defaultName),
  /** Subscribe to native-menu actions ("new"|"open"|"save"|"save-as"|"undo"|"redo"). */
  onMenu: (cb) => ipcRenderer.on("menu", (_e, action) => cb(action)),
  /** Report unsaved/has-file state so the main process can guard quit. */
  reportProjectState: (state) => ipcRenderer.send("project:state", state),
  /** Ready-to-paste MCP client config for this exact install (no repo path guessing). */
  getMcpConfig: () => ipcRenderer.invoke("mcp:config"),
});
