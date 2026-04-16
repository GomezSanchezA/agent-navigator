const fileInput = document.getElementById("fileInput");
const pasteInput = document.getElementById("pasteInput");
const currentRecord = document.getElementById("currentRecord");
const snapshotView = document.getElementById("snapshotView");
const statusView = document.getElementById("statusView");
const countValue = document.getElementById("countValue");
const indexValue = document.getElementById("indexValue");
const activeProfileValue = document.getElementById("activeProfileValue");

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatObject(value) {
  return JSON.stringify(value, null, 2);
}

function setStatus(text, isError = false) {
  statusView.textContent = text;
  statusView.style.color = isError ? "#b91c1c" : "#2f2a23";
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    snapshotView.textContent = "Sin lectura todavia.";
    return;
  }

  const buttonLines = (snapshot.buttons || []).slice(0, 8).map((item) => `- ${item.text || item.ariaLabel || item.value || item.tag}`);
  const fieldLines = (snapshot.fields || []).slice(0, 8).map((item) => `- ${item.label || item.ariaLabel || item.placeholder || item.name || item.id || item.tag}`);

  snapshotView.textContent = [
    `URL: ${snapshot.url}`,
    `Titulo: ${snapshot.title}`,
    "",
    "Cabeceras:",
    ...(snapshot.headings || []).slice(0, 6).map((item) => `- ${item}`),
    "",
    "Botones:",
    ...buttonLines,
    "",
    "Campos:",
    ...fieldLines
  ].join("\n");
}

function renderCurrentRecord(state) {
  const records = state.records || [];
  const index = state.currentIndex || 0;
  const profile = state.profiles && state.profiles[state.activeProfileId];

  countValue.textContent = String(records.length);
  indexValue.textContent = records.length ? String(index + 1) : "0";
  activeProfileValue.textContent = profile && profile.name ? profile.name : "Sin perfil";

  if (!records.length) {
    currentRecord.textContent = "Sin registros cargados.";
    return;
  }

  const item = records[index];
  const summary = BrowserAgentParser.summarizeRecord(item, index);
  currentRecord.textContent = `${summary}\n\n${formatObject(item)}`;
}

async function refreshView() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (!response.ok) {
    setStatus(response.error || "No he podido leer el estado.", true);
    return;
  }

  renderCurrentRecord(response.state);
  renderSnapshot(response.state.lastSnapshot);

  if (response.state.warnings && response.state.warnings.length) {
    setStatus(response.state.warnings.join("\n"), true);
  } else if (response.state.lastRun && response.state.lastRun.log) {
    setStatus(`Ultima ejecucion: ${response.state.lastRun.log.length} pasos.`);
  } else {
    setStatus("Listo.");
  }
}

async function readSelectedFile() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    return "";
  }
  return file.text();
}

document.getElementById("importText").addEventListener("click", async () => {
  try {
    const fileText = await readSelectedFile();
    const text = pasteInput.value.trim() || fileText.trim();
    if (!text) {
      setStatus("No hay texto para importar.", true);
      return;
    }

    const response = await sendMessage({
      type: "IMPORT_RECORDS_TEXT",
      text
    });

    if (!response.ok) {
      setStatus(response.error || "No he podido importar el texto.", true);
      return;
    }

    pasteInput.value = "";
    fileInput.value = "";
    await refreshView();
    setStatus(`Importados ${response.state.records.length} registros.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById("readWeb").addEventListener("click", async () => {
  const response = await sendMessage({ type: "CAPTURE_SNAPSHOT" });
  if (!response.ok) {
    setStatus(response.error || "No he podido leer la web.", true);
    return;
  }
  renderSnapshot(response.state.lastSnapshot);
  setStatus("Lectura de la web actualizada.");
});

document.getElementById("runCurrent").addEventListener("click", async () => {
  const response = await sendMessage({ type: "RUN_CURRENT_RECORD" });
  if (!response.ok) {
    setStatus(response.error || "La automatizacion ha fallado.", true);
    return;
  }
  await refreshView();
  setStatus("Registro actual ejecutado.");
});

document.getElementById("runRemaining").addEventListener("click", async () => {
  const response = await sendMessage({ type: "RUN_REMAINING_RECORDS" });
  if (!response.ok) {
    setStatus(response.error || "La ejecucion por lotes ha fallado.", true);
    return;
  }
  await refreshView();
  setStatus(`Proceso por lotes completado: ${response.result.count} intentos.`);
});

document.getElementById("prevRecord").addEventListener("click", async () => {
  const stateResponse = await sendMessage({ type: "GET_STATE" });
  if (!stateResponse.ok) {
    setStatus(stateResponse.error || "No he podido leer el estado.", true);
    return;
  }
  await sendMessage({
    type: "SET_CURRENT_INDEX",
    index: Math.max((stateResponse.state.currentIndex || 0) - 1, 0)
  });
  await refreshView();
});

document.getElementById("nextRecord").addEventListener("click", async () => {
  const stateResponse = await sendMessage({ type: "GET_STATE" });
  if (!stateResponse.ok) {
    setStatus(stateResponse.error || "No he podido leer el estado.", true);
    return;
  }
  await sendMessage({
    type: "SET_CURRENT_INDEX",
    index: (stateResponse.state.currentIndex || 0) + 1
  });
  await refreshView();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshView();
