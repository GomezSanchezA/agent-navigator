#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkStopRequested,
  clearStopControl,
  clickByText,
  clickSelector,
  delay,
  ensureStopControl,
  fillByLabel,
  fillSelector,
  openSession,
  showPageNotice,
  snapshotPage,
  waitForSelector,
  waitForText
} from "./lib/cdp-client.mjs";
import {
  activateWindow,
  navigateExplorer,
  saveFileDialog,
  sendKeys,
  typeText,
  waitForWindow
} from "./lib/windows-ui-client.mjs";
import { parseRecordsText, summarizeRecord } from "./lib/operations-parser.mjs";

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
    } else {
      positional.push(token);
    }
  }

  return { positional, flags };
}

function usage(commandName = "run-records.mjs") {
  console.error(`Uso: node controller/${commandName} <registros.txt|registros.json> <perfil.json> [--match texto|--index N] [--port 9222] [--start 0] [--limit 1]`);
}

function readPath(source, pathExpression) {
  return String(pathExpression || "")
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

function createContext(profile, record, recordIndex, extra = {}) {
  return {
    index: recordIndex,
    item: record,
    profile,
    record,
    row: record,
    vars: profile.variables || {},
    ...extra
  };
}

async function executeSteps(connection, steps, context, timing) {
  const log = [];
  for (const step of steps) {
    await ensureStopControl(connection);
    await throwIfStopRequested(connection);
    const outcome = await executeStep(connection, step, context, timing);
    log.push(outcome);
    await delay(timing.stepDelayMs);
  }
  return log;
}

async function executeStep(connection, step, context, timing) {
  if (step.type === "waitForText") {
    const texts = resolveStepStrings(step.texts || step.text, context);
    const ok = await waitForText(connection, texts, {
      timeoutMs: step.timeoutMs || 5000
    });
    if (!ok && !step.optional) {
      throw new Error(`No ha aparecido el texto esperado: ${JSON.stringify(texts)}`);
    }
    return { type: step.type, ok, target: texts };
  }

  if (step.type === "waitForSelector") {
    const selector = resolveStepStrings(step.selector, context);
    const ok = await waitForSelector(connection, selector, {
      timeoutMs: step.timeoutMs || 5000
    });
    if (!ok && !step.optional) {
      throw new Error(`No ha aparecido el selector esperado: ${selector}`);
    }
    return { type: step.type, ok, selector };
  }

  if (step.type === "clickText") {
    const texts = resolveStepStrings(step.texts || step.text, context);
    const result = await clickByText(connection, texts);
    if (!result.ok && !step.optional) {
      throw new Error(`No encuentro un boton o enlace para ${JSON.stringify(texts)}`);
    }
    await delay(step.postDelayMs || timing.postClickDelayMs);
    return { type: step.type, ...result };
  }

  if (step.type === "clickSelector") {
    const selector = resolveStepStrings(step.selector, context);
    const result = await clickSelector(connection, selector);
    if (!result.ok && !step.optional) {
      throw new Error(`No encuentro el selector ${selector}`);
    }
    await delay(step.postDelayMs || timing.postClickDelayMs);
    return { type: step.type, selector, ...result };
  }

  if (step.type === "fillByLabel") {
    const labels = resolveStepStrings(step.labels || step.label, context);
    const value = resolveStepValue(step, context);
    if ((value == null || value === "") && step.optional) {
      return { type: step.type, ok: false, skipped: true, reason: "Valor vacio" };
    }
    if (value == null || value === "") {
      throw new Error(`Falta el valor para ${step.field || JSON.stringify(labels)}`);
    }
    const result = await fillByLabel(connection, labels, value);
    if (!result.ok && !step.optional) {
      throw new Error(`No encuentro un campo para ${JSON.stringify(labels)}`);
    }
    await delay(step.postDelayMs || timing.stepDelayMs);
    return { type: step.type, ...result };
  }

  if (step.type === "fillSelector") {
    const selector = resolveStepStrings(step.selector, context);
    const value = resolveStepValue(step, context);
    if ((value == null || value === "") && step.optional) {
      return { type: step.type, ok: false, skipped: true, reason: "Valor vacio" };
    }
    if (value == null || value === "") {
      throw new Error(`Falta el valor para ${selector}`);
    }
    const result = await fillSelector(connection, selector, value);
    if (!result.ok && !step.optional) {
      throw new Error(`No encuentro el selector ${selector}`);
    }
    await delay(step.postDelayMs || timing.stepDelayMs);
    return { type: step.type, selector, ...result };
  }

  if (step.type === "showNotice") {
    return {
      type: step.type,
      ...(await showPageNotice(connection, {
        id: step.id || "__browser_agent_notice__",
        title: renderTemplate(step.title || "Aviso", context),
        message: renderTemplate(step.message || "", context),
        tone: step.tone || "info"
      }))
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
      const loopContext = createContext(context.profile, context.record, context.index, {
        loop: {
          index,
          count
        }
      });
      const log = await executeSteps(connection, step.steps, loopContext, timing);
      iterations.push({
        index,
        log
      });
    }

    return {
      type: step.type,
      ok: true,
      count,
      iterations
    };
  }

  if (step.type === "waitForWindow") {
    const title = resolveStepStrings(step.title || step.text, context);
    const result = await waitForWindow(title, {
      timeoutMs: step.timeoutMs || 10000
    });
    return { type: step.type, ok: true, window: result };
  }

  if (step.type === "activateWindow") {
    const title = resolveStepStrings(step.title || step.text, context);
    const result = await activateWindow(title);
    return { type: step.type, ok: true, window: result };
  }

  if (step.type === "sendKeys") {
    const keys = resolveStepStrings(step.keys, context);
    const title = step.title ? resolveStepStrings(step.title, context) : undefined;
    const result = await sendKeys(keys, { title });
    return { type: step.type, ...result };
  }

  if (step.type === "typeText") {
    const text = resolveStepValue(step, context);
    const title = step.title ? resolveStepStrings(step.title, context) : undefined;
    const result = await typeText(text, {
      title,
      replace: Boolean(step.replace)
    });
    return { type: step.type, ...result };
  }

  if (step.type === "navigateExplorer") {
    const title = resolveStepStrings(step.title || step.text, context);
    const destinationPath = resolveStepValue(step, context);
    const result = await navigateExplorer(title, destinationPath, {
      timeoutMs: step.timeoutMs || 10000
    });
    return { type: step.type, ...result };
  }

  if (step.type === "saveFile") {
    const title = resolveStepStrings(step.title || step.text, context);
    const destinationPath = resolveStepValue(step, context);
    const result = await saveFileDialog(title, destinationPath, {
      timeoutMs: step.timeoutMs || 10000
    });
    return { type: step.type, ...result };
  }

  throw new Error(`Paso no soportado: ${step.type}`);
}

async function throwIfStopRequested(connection) {
  const stopRequested = await checkStopRequested(connection);
  if (stopRequested) {
    throw new Error("Parada manual solicitada desde la pagina.");
  }
}

export async function main({ argv = process.argv.slice(2), commandName = "run-records.mjs" } = {}) {
  const { positional, flags } = parseArgs(argv);
  if (positional.length < 2) {
    usage(commandName);
    process.exitCode = 1;
    return;
  }

  const recordsPath = path.resolve(positional[0]);
  const profilePath = path.resolve(positional[1]);
  const port = Number(flags.port || 9222);
  const startIndex = Number(flags.start || 0);
  const limit = flags.limit != null ? Number(flags.limit) : undefined;
  const match = flags.match ? String(flags.match) : undefined;
  const index = flags.index != null ? Number(flags.index) : undefined;

  const recordsText = await fs.readFile(recordsPath, "utf8");
  const parsed = parseRecordsText(recordsText);
  const records = parsed.records;
  if (!records.length) {
    throw new Error(parsed.warnings && parsed.warnings.length
      ? parsed.warnings.join(" ")
      : `No he podido leer registros desde ${recordsPath}`);
  }

  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  if (!Array.isArray(profile.steps)) {
    throw new Error("El perfil necesita un array steps.");
  }

  const { connection, target } = await openSession({ port, match, index });
  const summary = [];

  try {
    await ensureStopControl(connection);
    const end = limit == null ? records.length : Math.min(records.length, startIndex + limit);

    for (let recordIndex = startIndex; recordIndex < end; recordIndex += 1) {
      await ensureStopControl(connection);
      await throwIfStopRequested(connection);

      const record = records[recordIndex];
      const timing = {
        stepDelayMs: profile.stepDelayMs || 400,
        postClickDelayMs: profile.postClickDelayMs || 700
      };

      if (profile.urlIncludes && profile.urlIncludes.length) {
        const current = await snapshotPage(connection);
        const allowed = profile.urlIncludes.some((fragment) => String(current.url || "").includes(fragment));
        if (!allowed) {
          throw new Error(`La URL actual no coincide con el perfil. URL actual: ${current.url}`);
        }
      }

      const log = await executeSteps(
        connection,
        profile.steps,
        createContext(profile, record, recordIndex),
        timing
      );

      summary.push({
        index: recordIndex,
        label: summarizeRecord(record, recordIndex),
        ok: true,
        log
      });
    }

    console.log(JSON.stringify({
      ok: true,
      parser: parsed.meta ? parsed.meta.mode : null,
      target: {
        title: target.title,
        url: target.url
      },
      processed: summary.length,
      summary,
      warnings: parsed.warnings || []
    }, null, 2));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const manualStop = message.includes("Parada manual solicitada");
    console.log(JSON.stringify({
      ok: false,
      stopped: manualStop,
      error: message,
      parser: parsed.meta ? parsed.meta.mode : null,
      target: {
        title: target.title,
        url: target.url
      },
      processed: summary.length,
      summary,
      warnings: parsed.warnings || []
    }, null, 2));
    if (!manualStop) {
      process.exitCode = 1;
    }
  } finally {
    await clearStopControl(connection).catch(() => undefined);
    await connection.close();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
