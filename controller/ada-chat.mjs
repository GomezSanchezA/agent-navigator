#!/usr/bin/env node
import { delay, evaluate, openSession } from "./lib/cdp-client.mjs";

const DEFAULT_ADA_URL = "https://ada.lovelacesquare.org";

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
  node controller/ada-chat.mjs goto [--url https://ada.lovelacesquare.org] [--match texto|--index N] [--port 9222] [--timeout 30000]
  node controller/ada-chat.mjs state [--match texto|--index N] [--port 9222]
  node controller/ada-chat.mjs send "Hola Ada" [--match texto|--index N] [--port 9222] [--timeout 90000] [--no-wait]
  node controller/ada-chat.mjs wait-response [--match texto|--index N] [--port 9222] [--timeout 90000]
  node controller/ada-chat.mjs read-latest [--match texto|--index N] [--port 9222]
  node controller/ada-chat.mjs stop [--match texto|--index N] [--port 9222]

Ejemplos:
  node controller/ada-chat.mjs goto --url https://ada.lovelacesquare.org --match demo-form
  node controller/ada-chat.mjs state --match ada.lovelacesquare.org
  node controller/ada-chat.mjs send "Hola Ada" --match ada.lovelacesquare.org
  node controller/ada-chat.mjs read-latest --match ada.lovelacesquare.org
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

async function getAdaState(connection) {
  return evaluate(connection, `
    (() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const normalizeLoose = (value) => normalize(value).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
      const isVisible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const exactText = (element) => normalize(element.innerText || element.textContent || "");

      const assistantRoots = [];
      const labelCandidates = Array.from(document.querySelectorAll("div, span, p"))
        .filter((element) => isVisible(element) && exactText(element) === "Ada");

      for (const label of labelCandidates) {
        const root = label.parentElement;
        if (!root) continue;
        const body = Array.from(root.querySelectorAll(".markdown-body")).find(isVisible);
        if (!body) continue;
        if (!assistantRoots.includes(root)) {
          assistantRoots.push(root);
        }
      }

      const assistantMessages = assistantRoots
        .map((root) => {
          const body = Array.from(root.querySelectorAll(".markdown-body")).find(isVisible);
          if (!body) return null;
          return {
            text: normalize(body.innerText || body.textContent || ""),
            html: body.innerHTML || ""
          };
        })
        .filter(Boolean);

      const latestAssistant = assistantMessages.length ? assistantMessages[assistantMessages.length - 1] : null;
      const textarea = document.querySelector('textarea[placeholder="Message Ada..."]');
      const sendButton = document.querySelector('button[aria-label="Send message"]');
      const stopButton = document.querySelector('button[aria-label="Stop generation"]');
      const signInButton = Array.from(document.querySelectorAll("button, a"))
        .find((element) => isVisible(element) && normalizeLoose(exactText(element)) === "sign in");
      const bodyText = normalizeLoose(document.body.innerText || "");

      return {
        url: location.href,
        title: document.title,
        inputFound: !!textarea,
        inputValueLength: textarea ? String(textarea.value || "").length : 0,
        canSend: !!(sendButton && !sendButton.disabled),
        isGenerating: !!stopButton,
        requiresSignIn: !!signInButton || bodyText.includes("sign in to start chatting and keep your history"),
        assistantCount: assistantMessages.length,
        latestAssistantText: latestAssistant ? latestAssistant.text : "",
        latestAssistantHtml: latestAssistant ? latestAssistant.html : "",
        recentAssistantTexts: assistantMessages.slice(-3).map((item) => item.text),
        canvas: {
          hasPreviewFrame: !!document.querySelector('iframe[title="Component preview"]'),
          hasPreviewTab: !!Array.from(document.querySelectorAll("button")).find((element) => isVisible(element) && exactText(element) === "Preview"),
          hasCodeTab: !!Array.from(document.querySelectorAll("button")).find((element) => isVisible(element) && exactText(element) === "Code"),
          hasEmptyCanvasHint: bodyText.includes("components will appear here"),
          hasFilesPanel: !!Array.from(document.querySelectorAll("p, span, div")).find((element) => isVisible(element) && exactText(element) === "Files")
        }
      };
    })()
  `);
}

async function waitForAdaReady(connection, { timeoutMs = 30000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await getAdaState(connection);
    if (lastState.inputFound || /ada/i.test(lastState.title || "")) {
      return lastState;
    }
    await delay(pollMs);
  }

  throw new Error(`Ada no ha quedado lista en ${timeoutMs} ms.${lastState ? ` Estado final: ${JSON.stringify(lastState)}` : ""}`);
}

async function fillAdaInput(connection, message) {
  return evaluate(connection, `
    (() => {
      const textarea = document.querySelector('textarea[placeholder="Message Ada..."]');
      if (!textarea) {
        return { ok: false, error: "No encuentro el cuadro de texto de Ada." };
      }
      textarea.focus();
      textarea.value = ${JSON.stringify(message)};
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, length: textarea.value.length };
    })()
  `);
}

async function clickAdaSend(connection) {
  return evaluate(connection, `
    (() => {
      const button = document.querySelector('button[aria-label="Send message"]');
      if (!button) {
        return { ok: false, error: "No encuentro el boton de enviar." };
      }
      if (button.disabled) {
        return { ok: false, error: "El boton de enviar esta deshabilitado." };
      }
      button.click();
      return { ok: true };
    })()
  `);
}

async function clickAdaStop(connection) {
  return evaluate(connection, `
    (() => {
      const button = document.querySelector('button[aria-label="Stop generation"]');
      if (!button) {
        return { ok: false, error: "Ada no esta generando ahora mismo." };
      }
      button.click();
      return { ok: true };
    })()
  `);
}

async function waitForResponse(connection, previousState, { timeoutMs = 90000, pollMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let sawGeneration = Boolean(previousState && previousState.isGenerating);
  let lastState = previousState || null;

  while (Date.now() < deadline) {
    lastState = await getAdaState(connection);
    if (lastState.isGenerating) {
      sawGeneration = true;
    }

    const countChanged = !previousState || lastState.assistantCount > previousState.assistantCount;
    const textChanged = !previousState || lastState.latestAssistantText !== previousState.latestAssistantText;
    const hasNewAssistant = countChanged || textChanged;

    if (!lastState.isGenerating && hasNewAssistant && (sawGeneration || lastState.latestAssistantText)) {
      return lastState;
    }

    await delay(pollMs);
  }

  throw new Error(`Ada no ha terminado de responder en ${timeoutMs} ms.${lastState ? ` Ultimo estado: ${JSON.stringify(lastState)}` : ""}`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(0);
}

switch (command) {
  case "goto": {
    await withSession(flags, async (connection) => {
      const url = flags.url ? String(flags.url) : DEFAULT_ADA_URL;
      await connection.send("Page.navigate", { url });
      return {
        navigatedTo: url,
        state: await waitForAdaReady(connection, { timeoutMs: Number(flags.timeout || 30000) })
      };
    });
    break;
  }

  case "state": {
    await withSession(flags, async (connection) => getAdaState(connection));
    break;
  }

  case "send": {
    const message = positional.slice(1).join(" ").trim();
    if (!message) {
      throw new Error("Falta el mensaje para Ada.");
    }

    await withSession(flags, async (connection) => {
      const before = await getAdaState(connection);
      if (before.requiresSignIn) {
        throw new Error("Ada requiere login en esta sesion de Brave. Inicia sesion manualmente y vuelve a intentarlo.");
      }
      if (!before.inputFound) {
        throw new Error("No encuentro el cuadro de texto de Ada en la pestana seleccionada.");
      }

      const fillResult = await fillAdaInput(connection, message);
      if (!fillResult.ok) {
        throw new Error(fillResult.error || "No he podido escribir en Ada.");
      }

      const sendResult = await clickAdaSend(connection);
      if (!sendResult.ok) {
        throw new Error(sendResult.error || "No he podido enviar el mensaje a Ada.");
      }

      if (flags["no-wait"]) {
        return {
          sent: true,
          message,
          state: await getAdaState(connection)
        };
      }

      return {
        sent: true,
        message,
        state: await waitForResponse(connection, before, { timeoutMs: Number(flags.timeout || 90000) })
      };
    });
    break;
  }

  case "wait-response": {
    await withSession(flags, async (connection) => {
      const before = await getAdaState(connection);
      return waitForResponse(connection, before, { timeoutMs: Number(flags.timeout || 90000) });
    });
    break;
  }

  case "read-latest": {
    await withSession(flags, async (connection) => {
      const state = await getAdaState(connection);
      return {
        assistantCount: state.assistantCount,
        latestAssistantText: state.latestAssistantText,
        recentAssistantTexts: state.recentAssistantTexts,
        isGenerating: state.isGenerating,
        canvas: state.canvas
      };
    });
    break;
  }

  case "stop": {
    await withSession(flags, async (connection) => {
      const result = await clickAdaStop(connection);
      if (!result.ok) {
        throw new Error(result.error || "No he podido detener la generacion.");
      }
      await delay(500);
      return {
        stopped: true,
        state: await getAdaState(connection)
      };
    });
    break;
  }

  default:
    usage();
    process.exitCode = 1;
}
