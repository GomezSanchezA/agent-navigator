importScripts("shared/profile-defaults.js", "shared/operation-parser.js");

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultProfiles() {
  return deepClone(BrowserAgentDefaults.DEFAULT_PROFILES);
}

function createDefaultState() {
  return {
    records: [],
    currentIndex: 0,
    warnings: [],
    activeProfileId: BrowserAgentDefaults.DEFAULT_PROFILE.id,
    profiles: createDefaultProfiles(),
    lastSnapshot: null,
    lastRun: null
  };
}

function normalizeState(state) {
  const defaults = createDefaultState();
  const records = Array.isArray(state && state.records)
    ? state.records
    : Array.isArray(state && state.operations)
      ? state.operations
      : defaults.records;

  const profiles = {
    ...defaults.profiles,
    ...((state && state.profiles) || {})
  };

  const requestedIndex = Number((state && state.currentIndex) || 0);
  const maxIndex = Math.max(records.length - 1, 0);
  const currentIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, maxIndex))
    : 0;

  const activeProfileId = profiles[(state && state.activeProfileId) || ""]
    ? state.activeProfileId
    : defaults.activeProfileId;

  return {
    ...defaults,
    ...(state || {}),
    records,
    operations: records,
    currentIndex,
    warnings: Array.isArray(state && state.warnings) ? state.warnings : [],
    activeProfileId,
    profiles,
    lastSnapshot: state && state.lastSnapshot ? state.lastSnapshot : null,
    lastRun: state && state.lastRun ? state.lastRun : null
  };
}

async function getState() {
  const stored = await chrome.storage.local.get("state");
  return normalizeState(stored.state || {});
}

async function saveState(state) {
  const normalized = normalizeState(state);
  const { operations, ...persisted } = normalized;
  await chrome.storage.local.set({ state: persisted });
  return normalized;
}

async function updateState(mutator) {
  const current = await getState();
  const next = await mutator({ ...current, profiles: { ...current.profiles } });
  await saveState(next);
  return next;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) {
    throw new Error("No hay una pestana activa.");
  }
  return tab;
}

async function sendToActiveTab(type, payload = {}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { type, ...payload });
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("El perfil debe ser un objeto JSON.");
  }
  if (!profile.id || !String(profile.id).trim()) {
    throw new Error("El perfil necesita un campo id.");
  }
  if (!Array.isArray(profile.steps)) {
    throw new Error("El perfil necesita un array steps.");
  }

  return {
    stepDelayMs: 400,
    postClickDelayMs: 700,
    urlIncludes: [],
    variables: {},
    ...profile
  };
}

async function captureSnapshot() {
  const snapshot = await sendToActiveTab("SNAPSHOT_PAGE");
  return updateState((state) => {
    state.lastSnapshot = snapshot;
    return state;
  });
}

async function runCurrentRecord() {
  const state = await getState();
  const record = state.records[state.currentIndex];
  if (!record) {
    throw new Error("No hay un registro cargado en el indice actual.");
  }

  const profile = state.profiles[state.activeProfileId];
  const result = await sendToActiveTab("AUTOMATE_RECORD", {
    record,
    recordIndex: state.currentIndex,
    profile
  });

  return updateState((nextState) => {
    nextState.lastRun = result;
    if (result && result.ok && nextState.currentIndex < nextState.records.length - 1) {
      nextState.currentIndex += 1;
    }
    return nextState;
  });
}

async function runRemainingRecords() {
  let state = await getState();
  const results = [];

  while (state.currentIndex < state.records.length) {
    const record = state.records[state.currentIndex];
    const profile = state.profiles[state.activeProfileId];
    const result = await sendToActiveTab("AUTOMATE_RECORD", {
      record,
      recordIndex: state.currentIndex,
      profile
    });

    results.push(result);

    state = await updateState((nextState) => {
      nextState.lastRun = result;
      if (result && result.ok) {
        nextState.currentIndex += 1;
      }
      return nextState;
    });

    if (!result || !result.ok) {
      break;
    }
  }

  return {
    ok: results.every((item) => item && item.ok),
    count: results.length,
    results
  };
}

async function setActiveProfileId(profileId) {
  return updateState((state) => {
    if (!state.profiles[profileId]) {
      throw new Error(`No existe el perfil ${profileId}.`);
    }
    state.activeProfileId = profileId;
    return state;
  });
}

async function resetProfile(profileId) {
  const baseProfile = BrowserAgentDefaults.DEFAULT_PROFILES[profileId];
  if (!baseProfile) {
    throw new Error(`No hay un perfil base para ${profileId}.`);
  }

  return updateState((state) => {
    state.profiles[profileId] = deepClone(baseProfile);
    state.activeProfileId = profileId;
    return state;
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("state");
  if (!existing.state) {
    await saveState(createDefaultState());
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE":
        sendResponse({ ok: true, state: await getState() });
        return;

      case "IMPORT_RECORDS_TEXT":
      case "IMPORT_OPERATIONS_TEXT": {
        const parsed = BrowserAgentParser.parseRecordsText(message.text);
        const nextState = await updateState((state) => {
          state.records = parsed.records;
          state.currentIndex = 0;
          state.warnings = parsed.warnings || [];
          state.lastRun = null;
          return state;
        });
        sendResponse({
          ok: parsed.records.length > 0,
          state: nextState,
          warnings: parsed.warnings || []
        });
        return;
      }

      case "CAPTURE_SNAPSHOT":
        sendResponse({ ok: true, state: await captureSnapshot() });
        return;

      case "RUN_CURRENT_RECORD":
      case "RUN_CURRENT_OPERATION":
        sendResponse({ ok: true, state: await runCurrentRecord() });
        return;

      case "RUN_REMAINING_RECORDS":
      case "RUN_REMAINING_OPERATIONS": {
        const result = await runRemainingRecords();
        sendResponse({ ok: result.ok, result, state: await getState() });
        return;
      }

      case "SET_CURRENT_INDEX": {
        const desiredIndex = Number(message.index);
        const state = await updateState((nextState) => {
          if (Number.isFinite(desiredIndex)) {
            const bounded = Math.max(0, Math.min(desiredIndex, Math.max(nextState.records.length - 1, 0)));
            nextState.currentIndex = bounded;
          }
          return nextState;
        });
        sendResponse({ ok: true, state });
        return;
      }

      case "SET_ACTIVE_PROFILE_ID":
        sendResponse({ ok: true, state: await setActiveProfileId(String(message.id || "")) });
        return;

      case "SET_ACTIVE_PROFILE_JSON": {
        const profile = validateProfile(JSON.parse(message.json));
        const state = await updateState((nextState) => {
          nextState.profiles[profile.id] = profile;
          nextState.activeProfileId = profile.id;
          return nextState;
        });
        sendResponse({ ok: true, state });
        return;
      }

      case "RESET_PROFILE":
        sendResponse({ ok: true, state: await resetProfile(String(message.id || "")) });
        return;

      case "RESET_DEFAULT_PROFILE":
        sendResponse({ ok: true, state: await resetProfile(BrowserAgentDefaults.DEFAULT_PROFILE.id) });
        return;

      default:
        sendResponse({ ok: false, error: `Mensaje no soportado: ${message.type}` });
    }
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  });

  return true;
});
