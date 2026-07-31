const fs = require("fs");
const path = require("path");

function createStateStore(rootDir, logWarn) {
  const statePath = path.join(rootDir, ".config", "state.json");

  function load() {
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        const now = Date.now();
        if (state.sessions) {
          for (const [key, session] of Object.entries(state.sessions)) {
            if (
              session.expiresAt &&
              new Date(session.expiresAt).getTime() < now
            )
              delete state.sessions[key];
          }
        }
        return state;
      }
    } catch (error) {
      logWarn(`[State] Failed to load state: ${error.message}`);
    }
    return { sessions: {}, lockedModels: {}, tokenHealth: {} };
  }

  function save(state) {
    try {
      const configDir = path.dirname(statePath);
      if (!fs.existsSync(configDir))
        fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      logWarn(`[State] Failed to save state: ${error.message}`);
    }
  }

  return { load, save, path: statePath };
}

module.exports = { createStateStore };
