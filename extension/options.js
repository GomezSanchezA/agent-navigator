const profileEditor = document.getElementById("profileEditor");
const profileSelect = document.getElementById("profileSelect");
const statusView = document.getElementById("statusView");

function setStatus(text, isError = false) {
  statusView.textContent = text;
  statusView.style.color = isError ? "#b91c1c" : "#2f2a23";
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function orderedProfiles(profiles) {
  const preferredOrder = BrowserAgentDefaults.PROFILE_ORDER || [];
  const entries = Object.values(profiles || {});
  return entries.sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);
    const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (safeLeft !== safeRight) {
      return safeLeft - safeRight;
    }
    return String(left.name || left.id).localeCompare(String(right.name || right.id));
  });
}

function renderSelector(state) {
  const profiles = orderedProfiles(state.profiles);
  profileSelect.innerHTML = "";

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.id})`;
    profileSelect.appendChild(option);
  }

  profileSelect.value = state.activeProfileId;
}

function renderEditor(state) {
  const profile = state.profiles[state.activeProfileId];
  profileEditor.value = JSON.stringify(profile, null, 2);
}

async function refresh() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (!response.ok) {
    setStatus(response.error || "No he podido cargar el estado.", true);
    return;
  }

  renderSelector(response.state);
  renderEditor(response.state);
}

profileSelect.addEventListener("change", async () => {
  const response = await sendMessage({
    type: "SET_ACTIVE_PROFILE_ID",
    id: profileSelect.value
  });

  if (!response.ok) {
    setStatus(response.error || "No he podido activar el perfil.", true);
    return;
  }

  renderSelector(response.state);
  renderEditor(response.state);
  setStatus(`Perfil activo: ${response.state.activeProfileId}`);
});

document.getElementById("saveProfile").addEventListener("click", async () => {
  try {
    const response = await sendMessage({
      type: "SET_ACTIVE_PROFILE_JSON",
      json: profileEditor.value
    });

    if (!response.ok) {
      setStatus(response.error || "No he podido guardar el perfil.", true);
      return;
    }

    renderSelector(response.state);
    renderEditor(response.state);
    setStatus("Perfil guardado.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById("resetProfile").addEventListener("click", async () => {
  const response = await sendMessage({
    type: "RESET_PROFILE",
    id: profileSelect.value
  });
  if (!response.ok) {
    setStatus(response.error || "No he podido restaurar el perfil.", true);
    return;
  }

  renderSelector(response.state);
  renderEditor(response.state);
  setStatus("Perfil base restaurado.");
});

refresh();
