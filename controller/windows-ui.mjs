#!/usr/bin/env node
import path from "node:path";
import {
  activateWindow,
  listWindows,
  navigateExplorer,
  saveFileDialog,
  sendKeys,
  typeText,
  waitForWindow
} from "./lib/windows-ui-client.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      if (inlineValue != null) {
        flags[key] = inlineValue;
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          index += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    positional.push(token);
  }

  return { positional, flags };
}

function usage() {
  console.log(`Uso:
  node controller/windows-ui.mjs list
  node controller/windows-ui.mjs wait-window "Guardar como" [--timeout 10000]
  node controller/windows-ui.mjs activate-window "Guardar como"
  node controller/windows-ui.mjs send-keys "^l" [--title "Explorador de archivos"]
  node controller/windows-ui.mjs type-text "C:\\ruta\\archivo.zip" [--title "Guardar como"] [--replace]
  node controller/windows-ui.mjs navigate-explorer "Explorador de archivos" "C:\\ruta\\destino" [--timeout 10000]
  node controller/windows-ui.mjs save-file "Guardar como" "C:\\ruta\\archivo.zip" [--timeout 10000]
`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(0);
}

let result;

switch (command) {
  case "list":
    result = await listWindows();
    break;

  case "wait-window":
    if (!positional[1]) {
      throw new Error("Falta el titulo de ventana.");
    }
    result = await waitForWindow(positional[1], {
      timeoutMs: Number(flags.timeout || 10000)
    });
    break;

  case "activate-window":
    if (!positional[1]) {
      throw new Error("Falta el titulo de ventana.");
    }
    result = await activateWindow(positional[1]);
    break;

  case "send-keys":
    if (!positional[1]) {
      throw new Error("Faltan las teclas.");
    }
    result = await sendKeys(positional[1], {
      title: flags.title ? String(flags.title) : undefined
    });
    break;

  case "type-text":
    if (!positional[1]) {
      throw new Error("Falta el texto.");
    }
    result = await typeText(positional.slice(1).join(" "), {
      title: flags.title ? String(flags.title) : undefined,
      replace: Boolean(flags.replace)
    });
    break;

  case "navigate-explorer":
    if (!positional[1] || !positional[2]) {
      throw new Error("Uso: navigate-explorer <titulo> <ruta>");
    }
    result = await navigateExplorer(positional[1], path.resolve(positional[2]), {
      timeoutMs: Number(flags.timeout || 10000)
    });
    break;

  case "save-file":
    if (!positional[1] || !positional[2]) {
      throw new Error("Uso: save-file <titulo> <ruta>");
    }
    result = await saveFileDialog(positional[1], path.resolve(positional[2]), {
      timeoutMs: Number(flags.timeout || 10000)
    });
    break;

  default:
    usage();
    process.exitCode = 1;
    process.exit();
}

console.log(JSON.stringify({ ok: true, result }, null, 2));

