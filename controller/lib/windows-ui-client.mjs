import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "windows-ui.ps1"
);

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message;
        reject(new Error(details));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runWindowsUi(action, payload = {}) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Action",
    action,
    "-JsonArgs",
    JSON.stringify(payload)
  ]);

  const text = String(stdout || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Salida no valida de windows-ui.ps1: ${text}`);
  }
}

export function listWindows() {
  return runWindowsUi("list-windows");
}

export function waitForWindow(title, options = {}) {
  return runWindowsUi("wait-window", {
    title,
    timeoutMs: options.timeoutMs
  });
}

export function activateWindow(title) {
  return runWindowsUi("activate-window", { title });
}

export function sendKeys(keys, options = {}) {
  return runWindowsUi("send-keys", {
    keys,
    title: options.title
  });
}

export function typeText(text, options = {}) {
  return runWindowsUi("type-text", {
    text,
    title: options.title,
    replace: options.replace
  });
}

export function navigateExplorer(title, destinationPath, options = {}) {
  return runWindowsUi("navigate-explorer", {
    title,
    path: destinationPath,
    timeoutMs: options.timeoutMs
  });
}

export function saveFileDialog(title, destinationPath, options = {}) {
  return runWindowsUi("save-file", {
    title,
    path: destinationPath,
    timeoutMs: options.timeoutMs
  });
}

