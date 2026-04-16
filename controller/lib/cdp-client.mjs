import fs from "node:fs/promises";
import path from "node:path";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al pedir ${url}`);
  }
  return response.json();
}

export async function listTargets({ port = 9222 } = {}) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

export async function fetchVersion({ port = 9222 } = {}) {
  return fetchJson(`http://127.0.0.1:${port}/json/version`);
}

function scoreTarget(target, match) {
  if (!match) {
    return 0;
  }
  const haystack = `${target.title || ""} ${target.url || ""}`.toLowerCase();
  const needle = match.toLowerCase();
  if (haystack === needle) {
    return 100;
  }
  if (haystack.includes(needle)) {
    return 10 + needle.length;
  }
  return -1;
}

export async function selectTarget({
  port = 9222,
  match,
  index,
  allowExtensions = false
} = {}) {
  const targets = (await listTargets({ port }))
    .filter((target) => target.type === "page")
    .filter((target) => allowExtensions || !String(target.url || "").startsWith("chrome-extension://"));

  if (!targets.length) {
    throw new Error(`No he encontrado pestanas accesibles en el puerto ${port}.`);
  }

  if (Number.isInteger(index)) {
    if (index < 0 || index >= targets.length) {
      throw new Error(`Indice de pestana fuera de rango: ${index}.`);
    }
    return targets[index];
  }

  if (match) {
    const ranked = targets
      .map((target) => ({ target, score: scoreTarget(target, match) }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score);

    if (!ranked.length) {
      throw new Error(`No he encontrado una pestana que coincida con "${match}".`);
    }

    return ranked[0].target;
  }

  return targets[0];
}

export class CdpConnection {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);

    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) {
        return;
      }
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      } else {
        pending.resolve(payload.result);
      }
    });

    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("La conexion CDP se ha cerrado."));
      }
      this.pending.clear();
    });
  }

  async close() {
    if (!this.ws) {
      return;
    }
    await new Promise((resolve) => {
      this.ws.addEventListener("close", resolve, { once: true });
      this.ws.close();
    });
    this.ws = null;
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }
}

export async function openSession(options = {}) {
  const target = await selectTarget(options);
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  await connection.send("Page.bringToFront");
  return { target, connection };
}

export async function evaluate(connection, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate ha fallado.");
  }

  return result.result ? result.result.value : undefined;
}

export async function snapshotPage(connection) {
  const expression = `
    (() => {
      const normalize = (value) => String(value || "").trim();
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: normalize(element.innerText || element.textContent || ""),
          id: element.id || "",
          name: element.getAttribute("name") || "",
          type: element.getAttribute("type") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          placeholder: element.getAttribute("placeholder") || "",
          value: "value" in element ? String(element.value || "") : "",
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      const labelFor = (field) => {
        if (field.labels && field.labels.length) {
          return Array.from(field.labels).map((item) => normalize(item.innerText || item.textContent || "")).join(" ").trim();
        }
        const ariaLabel = field.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
        const parentLabel = field.closest("label");
        if (parentLabel) return normalize(parentLabel.innerText || parentLabel.textContent || "");
        return "";
      };
      return {
        url: location.href,
        title: document.title,
        headings: Array.from(document.querySelectorAll("h1,h2,h3,legend")).filter(visible).map((item) => normalize(item.innerText || item.textContent || "")).filter(Boolean).slice(0, 20),
        buttons: Array.from(document.querySelectorAll("button,a,input[type='button'],input[type='submit'],[role='button']")).filter(visible).map(describe).filter((item) => item.text || item.ariaLabel || item.value).slice(0, 80),
        fields: Array.from(document.querySelectorAll("input,select,textarea")).filter(visible).map((field) => ({ ...describe(field), label: labelFor(field) })).slice(0, 120)
      };
    })()
  `;

  return evaluate(connection, expression);
}

function jsString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

export async function ensureStopControl(connection, { label = "PARAR AUTOMATIZACION" } = {}) {
  const expression = `
    (() => {
      const overlayId = "__codex_stop_overlay__";
      const buttonId = "__codex_stop_button__";
      const statusId = "__codex_stop_status__";

      let overlay = document.getElementById(overlayId);
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = overlayId;
        overlay.style.position = "fixed";
        overlay.style.top = "16px";
        overlay.style.right = "16px";
        overlay.style.zIndex = "2147483647";
        overlay.style.display = "flex";
        overlay.style.flexDirection = "column";
        overlay.style.gap = "8px";
        overlay.style.alignItems = "stretch";
        overlay.style.padding = "10px";
        overlay.style.borderRadius = "14px";
        overlay.style.background = "rgba(20, 20, 20, 0.88)";
        overlay.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
        overlay.style.backdropFilter = "blur(6px)";
        overlay.style.fontFamily = "Segoe UI, sans-serif";
        overlay.style.minWidth = "190px";
        document.documentElement.appendChild(overlay);
      }

      let button = document.getElementById(buttonId);
      if (!button) {
        button = document.createElement("button");
        button.id = buttonId;
        button.type = "button";
        button.style.border = "0";
        button.style.borderRadius = "10px";
        button.style.padding = "12px 14px";
        button.style.cursor = "pointer";
        button.style.fontSize = "14px";
        button.style.fontWeight = "700";
        button.style.letterSpacing = "0.02em";
        button.style.background = "#dc2626";
        button.style.color = "#ffffff";
        button.style.boxShadow = "inset 0 -2px 0 rgba(0,0,0,0.2)";
        button.addEventListener("click", () => {
          window.__codexStopRequested = true;
          const status = document.getElementById(statusId);
          if (status) {
            status.textContent = "Parada solicitada";
            status.style.color = "#fecaca";
          }
          button.textContent = "DETENIENDO...";
          button.style.background = "#7f1d1d";
        });
        overlay.appendChild(button);
      }

      let status = document.getElementById(statusId);
      if (!status) {
        status = document.createElement("div");
        status.id = statusId;
        status.style.fontSize = "12px";
        status.style.lineHeight = "1.35";
        status.style.color = "#e5e7eb";
        overlay.appendChild(status);
      }

      if (window.__codexStopRequested !== true) {
        window.__codexStopRequested = false;
        button.textContent = ${jsString(label)};
        button.style.background = "#dc2626";
        status.textContent = "Codex controlando esta pestaña";
        status.style.color = "#e5e7eb";
      }

      return {
        ok: true,
        stopRequested: window.__codexStopRequested === true
      };
    })()
  `;
  return evaluate(connection, expression);
}

export async function checkStopRequested(connection) {
  return evaluate(connection, `
    (() => {
      return window.__codexStopRequested === true;
    })()
  `);
}

export async function clearStopControl(connection) {
  return evaluate(connection, `
    (() => {
      window.__codexStopRequested = false;
      const overlay = document.getElementById("__codex_stop_overlay__");
      if (overlay) {
        overlay.remove();
      }
      return true;
    })()
  `);
}

export async function showPageNotice(connection, { id = "__codex_notice__", title = "Aviso", message = "", tone = "error" } = {}) {
  const titleText = jsString(title);
  const messageText = jsString(message);
  const toneText = jsString(tone);
  return evaluate(connection, `
    (() => {
      let notice = document.getElementById(${jsString(id)});
      if (!notice) {
        notice = document.createElement("div");
        notice.id = ${jsString(id)};
        notice.style.position = "fixed";
        notice.style.left = "16px";
        notice.style.bottom = "16px";
        notice.style.zIndex = "2147483647";
        notice.style.maxWidth = "420px";
        notice.style.padding = "14px 16px";
        notice.style.borderRadius = "12px";
        notice.style.boxShadow = "0 12px 30px rgba(0,0,0,0.28)";
        notice.style.border = "1px solid rgba(255,255,255,0.12)";
        notice.style.fontFamily = "Segoe UI, sans-serif";
        notice.style.whiteSpace = "pre-wrap";
        notice.style.lineHeight = "1.35";
        document.documentElement.appendChild(notice);
      }

      const isError = ${toneText} === "error";
      notice.style.background = isError ? "rgba(153, 27, 27, 0.96)" : "rgba(17, 24, 39, 0.96)";
      notice.style.color = "#ffffff";
      notice.innerHTML = "";

      const header = document.createElement("div");
      header.textContent = ${titleText};
      header.style.fontWeight = "700";
      header.style.marginBottom = "6px";
      header.style.fontSize = "14px";
      notice.appendChild(header);

      const body = document.createElement("div");
      body.textContent = ${messageText};
      body.style.fontSize = "13px";
      notice.appendChild(body);

      return { ok: true, id: ${jsString(id)} };
    })()
  `);
}

export async function clickByText(connection, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const expression = `
    (() => {
      const normalize = (value) => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ");
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const candidates = ${JSON.stringify(list)}.map((item) => normalize(item));
      const nodes = Array.from(document.querySelectorAll("button,a,input[type='button'],input[type='submit'],[role='button']")).filter(visible);
      const match = nodes.find((element) => {
        const text = normalize([element.innerText || element.textContent || "", element.getAttribute("aria-label") || "", element.getAttribute("value") || "", element.getAttribute("title") || ""].join(" "));
        return candidates.some((candidate) => text === candidate || text.includes(candidate) || candidate.includes(text));
      });
      if (!match) {
        return { ok: false, error: "No encontrado" };
      }
      match.scrollIntoView({ block: "center", behavior: "instant" });
      match.focus();
      match.click();
      return { ok: true, tag: match.tagName.toLowerCase(), text: match.innerText || match.textContent || match.getAttribute("value") || "" };
    })()
  `;
  return evaluate(connection, expression);
}

export async function clickSelector(connection, selector) {
  const expression = `
    (() => {
      const element = document.querySelector(${jsString(selector)});
      if (!element) {
        return { ok: false, error: "Selector no encontrado" };
      }
      element.scrollIntoView({ block: "center", behavior: "instant" });
      element.focus();
      element.click();
      return { ok: true, selector: ${jsString(selector)} };
    })()
  `;
  return evaluate(connection, expression);
}

export async function fillSelector(connection, selector, value) {
  const expression = `
    (() => {
      const element = document.querySelector(${jsString(selector)});
      if (!element) {
        return { ok: false, error: "Selector no encontrado" };
      }
      const value = ${jsString(value)};
      element.scrollIntoView({ block: "center", behavior: "instant" });
      element.focus();
      if (element.tagName === "SELECT") {
        const option = Array.from(element.options).find((item) => String(item.value) === value || String(item.textContent || "").trim() === value);
        element.value = option ? option.value : value;
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, selector: ${jsString(selector)}, value };
    })()
  `;
  return evaluate(connection, expression);
}

export async function fillByLabel(connection, labels, value) {
  const list = Array.isArray(labels) ? labels : [labels];
  const expression = `
    (() => {
      const normalize = (text) => String(text || "").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ");
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const labelFor = (field) => {
        if (field.labels && field.labels.length) {
          return Array.from(field.labels).map((item) => item.innerText || item.textContent || "").join(" ").trim();
        }
        const ariaLabel = field.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
        const parentLabel = field.closest("label");
        if (parentLabel) return parentLabel.innerText || parentLabel.textContent || "";
        return [field.getAttribute("placeholder") || "", field.getAttribute("name") || "", field.id || ""].join(" ");
      };
      const labels = ${JSON.stringify(list)}.map((item) => normalize(item));
      const field = Array.from(document.querySelectorAll("input,select,textarea")).filter(visible).find((item) => {
        const text = normalize(labelFor(item));
        return labels.some((label) => text === label || text.includes(label) || label.includes(text));
      });
      if (!field) {
        return { ok: false, error: "Campo no encontrado" };
      }
      const value = ${jsString(value)};
      field.scrollIntoView({ block: "center", behavior: "instant" });
      field.focus();
      if (field.tagName === "SELECT") {
        const option = Array.from(field.options).find((item) => String(item.value) === value || normalize(item.textContent || "") === normalize(value));
        field.value = option ? option.value : value;
      } else {
        field.value = value;
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, label: labelFor(field), value };
    })()
  `;
  return evaluate(connection, expression);
}

export async function waitForText(connection, texts, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(connection, `
      (() => {
        const bodyText = String(document.body.innerText || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
        const needles = ${JSON.stringify(Array.isArray(texts) ? texts : [texts])}.map((item) => String(item).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, ""));
        return needles.some((needle) => bodyText.includes(needle));
      })()
    `);
    if (found) {
      return true;
    }
    await delay(150);
  }
  return false;
}

export async function waitForSelector(connection, selector, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(connection, `
      (() => {
        const element = document.querySelector(${jsString(selector)});
        if (!element) {
          return false;
        }
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })()
    `);
    if (found) {
      return true;
    }
    await delay(150);
  }
  return false;
}

export async function captureScreenshot(connection, outputPath) {
  const result = await connection.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const buffer = Buffer.from(result.data, "base64");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

export { delay };
