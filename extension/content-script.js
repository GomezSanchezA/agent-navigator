(function () {
  function normalizeText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden"
      && style.display !== "none"
      && rect.width > 0
      && rect.height > 0;
  }

  function textMatches(candidate, target) {
    const left = normalizeText(candidate);
    const right = normalizeText(target);
    return left === right || left.includes(right) || right.includes(left);
  }

  function readPath(source, path) {
    return String(path || "")
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .reduce((current, segment) => {
        if (current == null) {
          return undefined;
        }
        return current[segment];
      }, source);
  }

  function renderTemplate(template, context) {
    return String(template || "").replace(/\{([^}]+)\}/g, (_, fieldName) => {
      const value = readPath(context, fieldName.trim());
      return value == null ? "" : String(value);
    });
  }

  function resolveStepStrings(value, context) {
    if (Array.isArray(value)) {
      return value
        .map((item) => typeof item === "string" ? renderTemplate(item, context) : item)
        .filter((item) => item != null && String(item).trim());
    }
    if (typeof value === "string") {
      return renderTemplate(value, context);
    }
    return value;
  }

  function resolveStepValue(step, context) {
    if (step.template != null) {
      return renderTemplate(step.template, context);
    }
    if (step.valueTemplate != null) {
      return renderTemplate(step.valueTemplate, context);
    }
    if (step.field) {
      const value = readPath(context.record, step.field) ?? readPath(context, step.field);
      return value == null ? "" : value;
    }
    if (step.value != null) {
      return typeof step.value === "string" ? renderTemplate(step.value, context) : step.value;
    }
    return "";
  }

  function resolveCount(step, context) {
    const raw = step.countTemplate != null
      ? renderTemplate(step.countTemplate, context)
      : step.count;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  function describeElement(element) {
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      text: element.innerText ? element.innerText.trim() : "",
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      placeholder: element.getAttribute("placeholder") || "",
      value: "value" in element ? element.value : "",
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function findAssociatedLabel(field) {
    if (field.labels && field.labels.length) {
      return Array.from(field.labels).map((item) => item.innerText || item.textContent || "").join(" ").trim();
    }

    const labelledBy = field.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((item) => item.innerText || item.textContent || "")
        .join(" ")
        .trim();
    }

    const parentLabel = field.closest("label");
    if (parentLabel) {
      return (parentLabel.innerText || parentLabel.textContent || "").trim();
    }

    const wrapper = field.closest("[class],[data-testid],td,th,div,section,article");
    if (wrapper) {
      const nearby = wrapper.querySelector("label,span,strong,p");
      if (nearby && nearby !== field) {
        return (nearby.innerText || nearby.textContent || "").trim();
      }
    }

    return "";
  }

  function collectSnapshot() {
    const buttons = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"))
      .filter(isVisible)
      .map(describeElement)
      .filter((item) => item && (item.text || item.ariaLabel || item.value));

    const fields = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter(isVisible)
      .map((field) => {
        const description = describeElement(field);
        description.label = findAssociatedLabel(field);
        return description;
      });

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend"))
      .filter(isVisible)
      .map((item) => (item.innerText || item.textContent || "").trim())
      .filter(Boolean);

    return {
      url: window.location.href,
      title: document.title,
      headings: headings.slice(0, 20),
      buttons: buttons.slice(0, 60),
      fields: fields.slice(0, 80)
    };
  }

  function findClickableByTexts(texts) {
    const targets = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
    const clickables = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"))
      .filter(isVisible);

    for (const target of targets) {
      const match = clickables.find((element) => {
        const combinedText = [
          element.innerText || element.textContent || "",
          element.getAttribute("aria-label") || "",
          element.getAttribute("value") || "",
          element.getAttribute("title") || ""
        ].join(" ");
        return textMatches(combinedText, target);
      });

      if (match) {
        return match;
      }
    }

    return null;
  }

  function findFieldByLabels(labels) {
    const targets = (Array.isArray(labels) ? labels : [labels]).filter(Boolean);
    const fields = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter(isVisible);

    for (const target of targets) {
      const match = fields.find((field) => {
        const combinedText = [
          findAssociatedLabel(field),
          field.getAttribute("aria-label") || "",
          field.getAttribute("placeholder") || "",
          field.getAttribute("name") || "",
          field.id || ""
        ].join(" ");
        return textMatches(combinedText, target);
      });

      if (match) {
        return match;
      }
    }

    return null;
  }

  function findVisibleSelector(selector) {
    const element = document.querySelector(selector);
    if (element && isVisible(element)) {
      return element;
    }
    return null;
  }

  function highlightElement(element, color) {
    const previous = element.style.outline;
    element.style.outline = `3px solid ${color}`;
    element.style.outlineOffset = "2px";
    window.setTimeout(() => {
      element.style.outline = previous;
    }, 1200);
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    highlightElement(element, "#c2410c");
    element.focus();
    element.click();
    return describeElement(element);
  }

  function fillElement(element, value) {
    const normalizedValue = value == null ? "" : String(value);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    highlightElement(element, "#0f766e");
    element.focus();

    if (element.tagName === "SELECT") {
      const option = Array.from(element.options).find((item) => textMatches(item.textContent || "", normalizedValue) || String(item.value) === normalizedValue);
      element.value = option ? option.value : normalizedValue;
    } else {
      element.value = normalizedValue;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
    return describeElement(element);
  }

  function renderNotice(step, context) {
    const id = step.id || "__browser_agent_notice__";
    let notice = document.getElementById(id);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = id;
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

    const tone = String(step.tone || "info");
    const isError = tone === "error";
    notice.style.background = isError ? "rgba(153, 27, 27, 0.96)" : "rgba(17, 24, 39, 0.96)";
    notice.style.color = "#ffffff";
    notice.innerHTML = "";

    const header = document.createElement("div");
    header.textContent = renderTemplate(step.title || "Aviso", context);
    header.style.fontWeight = "700";
    header.style.marginBottom = "6px";
    header.style.fontSize = "14px";
    notice.appendChild(header);

    const body = document.createElement("div");
    body.textContent = renderTemplate(step.message || "", context);
    body.style.fontSize = "13px";
    notice.appendChild(body);

    return { ok: true, id, tone };
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function waitForTexts(texts, timeoutMs) {
    const targets = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const bodyText = normalizeText(document.body.innerText || "");
      if (targets.some((target) => bodyText.includes(normalizeText(target)))) {
        return true;
      }
      await delay(150);
    }
    return false;
  }

  async function waitForSelector(selector, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (findVisibleSelector(selector)) {
        return true;
      }
      await delay(150);
    }
    return false;
  }

  async function executeStep(step, context, timing) {
    if (step.type === "waitForText") {
      const targetTexts = resolveStepStrings(step.texts || step.text, context);
      const ok = await waitForTexts(targetTexts, step.timeoutMs || 5000);
      if (!ok && !step.optional) {
        throw new Error(`No ha aparecido el texto esperado: ${JSON.stringify(targetTexts)}`);
      }
      return { type: step.type, ok, target: targetTexts };
    }

    if (step.type === "waitForSelector") {
      const selector = resolveStepStrings(step.selector, context);
      const ok = await waitForSelector(selector, step.timeoutMs || 5000);
      if (!ok && !step.optional) {
        throw new Error(`No ha aparecido el selector esperado: ${selector}`);
      }
      return { type: step.type, ok, selector };
    }

    if (step.type === "clickText") {
      const targetTexts = resolveStepStrings(step.texts || step.text, context);
      const element = findClickableByTexts(targetTexts);
      if (!element) {
        if (step.optional) {
          return { type: step.type, ok: false, skipped: true, reason: "No encontrado" };
        }
        throw new Error(`No encuentro un boton o enlace para ${JSON.stringify(targetTexts)}`);
      }

      const clicked = clickElement(element);
      await delay(step.postDelayMs || timing.postClickDelayMs);
      return { type: step.type, ok: true, clicked };
    }

    if (step.type === "clickSelector") {
      const selector = resolveStepStrings(step.selector, context);
      const element = findVisibleSelector(selector);
      if (!element) {
        if (step.optional) {
          return { type: step.type, ok: false, skipped: true, reason: "Selector no encontrado" };
        }
        throw new Error(`No encuentro el selector ${selector}`);
      }

      const clicked = clickElement(element);
      await delay(step.postDelayMs || timing.postClickDelayMs);
      return { type: step.type, ok: true, selector, clicked };
    }

    if (step.type === "fillByLabel") {
      const targetLabels = resolveStepStrings(step.labels || step.label, context);
      const field = findFieldByLabels(targetLabels);
      if (!field) {
        if (step.optional) {
          return { type: step.type, ok: false, skipped: true, reason: "Campo no encontrado" };
        }
        throw new Error(`No encuentro un campo para ${JSON.stringify(targetLabels)}`);
      }

      const value = resolveStepValue(step, context);
      if ((value == null || value === "") && !step.optional) {
        throw new Error(`Falta el valor para ${step.field || JSON.stringify(targetLabels)}`);
      }
      if (value == null || value === "") {
        return { type: step.type, ok: false, skipped: true, reason: "Valor vacio" };
      }

      const filled = fillElement(field, value);
      await delay(step.postDelayMs || timing.stepDelayMs);
      return { type: step.type, ok: true, filled, value: String(value) };
    }

    if (step.type === "fillSelector") {
      const selector = resolveStepStrings(step.selector, context);
      const field = findVisibleSelector(selector);
      if (!field) {
        if (step.optional) {
          return { type: step.type, ok: false, skipped: true, reason: "Selector no encontrado" };
        }
        throw new Error(`No encuentro el selector ${selector}`);
      }

      const value = resolveStepValue(step, context);
      if ((value == null || value === "") && !step.optional) {
        throw new Error(`Falta el valor para ${selector}`);
      }
      if (value == null || value === "") {
        return { type: step.type, ok: false, skipped: true, reason: "Valor vacio" };
      }

      const filled = fillElement(field, value);
      await delay(step.postDelayMs || timing.stepDelayMs);
      return { type: step.type, ok: true, selector, filled, value: String(value) };
    }

    if (step.type === "showNotice") {
      return {
        type: step.type,
        ...renderNotice(step, context)
      };
    }

    if (step.type === "sleep") {
      const ms = Number(resolveStepValue(step, context) || step.ms || 0);
      await delay(ms);
      return { type: step.type, ok: true, ms };
    }

    if (step.type === "repeat") {
      if (!Array.isArray(step.steps)) {
        throw new Error("El paso repeat necesita un array steps.");
      }

      const count = resolveCount(step, context);
      const iterations = [];
      for (let index = 0; index < count; index += 1) {
        const loopContext = {
          ...context,
          loop: {
            index,
            count
          }
        };
        const loopLog = [];
        for (const nestedStep of step.steps) {
          const outcome = await executeStep(nestedStep, loopContext, timing);
          loopLog.push(outcome);
          await delay(timing.stepDelayMs);
        }
        iterations.push({
          index,
          log: loopLog
        });
      }

      return {
        type: step.type,
        ok: true,
        count,
        iterations
      };
    }

    throw new Error(`Paso no soportado: ${step.type}`);
  }

  async function automateRecord(profile, record, recordIndex) {
    if (!profile || !Array.isArray(profile.steps)) {
      throw new Error("Perfil invalido.");
    }

    if (profile.urlIncludes && profile.urlIncludes.length) {
      const currentUrl = window.location.href;
      const matches = profile.urlIncludes.some((fragment) => currentUrl.includes(fragment));
      if (!matches) {
        throw new Error("La URL actual no coincide con el perfil activo.");
      }
    }

    const timing = {
      stepDelayMs: profile.stepDelayMs || 400,
      postClickDelayMs: profile.postClickDelayMs || 700
    };
    const context = {
      index: recordIndex,
      item: record,
      profile,
      record,
      row: record,
      vars: profile.variables || {}
    };

    const log = [];
    for (const step of profile.steps) {
      const outcome = await executeStep(step, context, timing);
      log.push(outcome);
      await delay(timing.stepDelayMs);
    }

    return {
      ok: true,
      recordIndex,
      record,
      url: window.location.href,
      title: document.title,
      log
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === "SNAPSHOT_PAGE") {
        sendResponse(collectSnapshot());
        return;
      }

      if (message.type === "AUTOMATE_RECORD" || message.type === "AUTOMATE_OPERATION") {
        const record = message.record || message.operation;
        const recordIndex = message.recordIndex != null ? message.recordIndex : message.operationIndex;
        sendResponse(await automateRecord(message.profile, record, recordIndex));
        return;
      }

      sendResponse({ ok: false, error: `Mensaje no soportado en content script: ${message.type}` });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    });

    return true;
  });
})();
