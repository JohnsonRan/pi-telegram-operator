function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Returns an error handler that logs `label: message`, e.g. promise.catch(warn("Cannot sync")).
function warn(label) {
  return (error) => console.warn(`[pi-telegram-operator] ${label}: ${errorMessage(error)}`);
}

module.exports = Object.freeze({ errorMessage, warn });
