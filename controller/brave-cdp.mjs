#!/usr/bin/env node
import path from "node:path";
import {
  captureScreenshot,
  clickByText,
  clickSelector,
  evaluate,
  fetchVersion,
  fillByLabel,
  fillSelector,
  listTargets,
  openSession,
  snapshotPage,
  waitForSelector,
  waitForText
} from "./lib/cdp-client.mjs";

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
  node controller/brave-cdp.mjs version [--port 9222]
  node controller/brave-cdp.mjs list [--port 9222]
  node controller/brave-cdp.mjs snapshot [--match texto|--index N] [--port 9222]
  node controller/brave-cdp.mjs eval "document.title" [--match texto|--index N]
  node controller/brave-cdp.mjs wait-text "Gracias" [--timeout 5000] [--match texto|--index N]
  node controller/brave-cdp.mjs wait-selector "form button[type=submit]" [--timeout 5000] [--match texto|--index N]
  node controller/brave-cdp.mjs click-text "Guardar" [--match texto|--index N]
  node controller/brave-cdp.mjs click-selector "button.primary" [--match texto|--index N]
  node controller/brave-cdp.mjs fill-label "Fecha de adquisicion" "01/02/2020" [--match texto|--index N]
  node controller/brave-cdp.mjs fill-selector "input[name=fecha]" "01/02/2020" [--match texto|--index N]
  node controller/brave-cdp.mjs screenshot out.png [--match texto|--index N]
`);
}

function commonOptions(flags) {
  return {
    port: Number(flags.port || 9222),
    match: flags.match ? String(flags.match) : undefined,
    index: flags.index != null ? Number(flags.index) : undefined
  };
}

async function withSession(flags, run) {
  const { connection, target } = await openSession(commonOptions(flags));
  try {
    const result = await run(connection, target);
    console.log(JSON.stringify({ ok: true, target: { title: target.title, url: target.url }, result }, null, 2));
  } finally {
    await connection.close();
  }
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(0);
}

switch (command) {
  case "version": {
    const version = await fetchVersion(commonOptions(flags));
    console.log(JSON.stringify(version, null, 2));
    break;
  }

  case "list": {
    const targets = await listTargets(commonOptions(flags));
    const pages = targets
      .filter((target) => target.type === "page")
      .map((target, index) => ({
        index,
        id: target.id,
        title: target.title,
        url: target.url
      }));
    console.log(JSON.stringify(pages, null, 2));
    break;
  }

  case "snapshot": {
    await withSession(flags, async (connection) => snapshotPage(connection));
    break;
  }

  case "eval": {
    const expression = positional.slice(1).join(" ").trim();
    if (!expression) {
      throw new Error("Falta la expresion JavaScript.");
    }
    await withSession(flags, async (connection) => evaluate(connection, expression));
    break;
  }

  case "wait-text": {
    const text = positional.slice(1).join(" ").trim();
    if (!text) {
      throw new Error("Falta el texto a esperar.");
    }
    await withSession(flags, async (connection) => waitForText(connection, text, {
      timeoutMs: Number(flags.timeout || 5000)
    }));
    break;
  }

  case "wait-selector": {
    const selector = positional[1];
    if (!selector) {
      throw new Error("Falta el selector a esperar.");
    }
    await withSession(flags, async (connection) => waitForSelector(connection, selector, {
      timeoutMs: Number(flags.timeout || 5000)
    }));
    break;
  }

  case "click-text": {
    const text = positional.slice(1).join(" ").trim();
    if (!text) {
      throw new Error("Falta el texto del boton o enlace.");
    }
    await withSession(flags, async (connection) => clickByText(connection, text));
    break;
  }

  case "click-selector": {
    const selector = positional[1];
    if (!selector) {
      throw new Error("Falta el selector.");
    }
    await withSession(flags, async (connection) => clickSelector(connection, selector));
    break;
  }

  case "fill-label": {
    const label = positional[1];
    const value = positional.slice(2).join(" ");
    if (!label || !value) {
      throw new Error("Uso: fill-label <label> <valor>");
    }
    await withSession(flags, async (connection) => fillByLabel(connection, label, value));
    break;
  }

  case "fill-selector": {
    const selector = positional[1];
    const value = positional.slice(2).join(" ");
    if (!selector || !value) {
      throw new Error("Uso: fill-selector <selector> <valor>");
    }
    await withSession(flags, async (connection) => fillSelector(connection, selector, value));
    break;
  }

  case "screenshot": {
    const outputPath = positional[1];
    if (!outputPath) {
      throw new Error("Falta la ruta de salida.");
    }
    await withSession(flags, async (connection) => captureScreenshot(connection, path.resolve(outputPath)));
    break;
  }

  default:
    usage();
    process.exitCode = 1;
}
