(function attachVerificationTimingHelpers(globalScope) {
  function toFiniteTimestamp(value) {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  function getStep7FilterAfterTimestamp(state = {}, fallbackTimestamp = 0) {
    return toFiniteTimestamp(state.step6StartTime)
      || toFiniteTimestamp(state.lastEmailTimestamp)
      || toFiniteTimestamp(state.flowStartTime)
      || toFiniteTimestamp(fallbackTimestamp);
  }

  function getStep4FilterAfterTimestamp(state = {}, fallbackTimestamp = 0) {
    return toFiniteTimestamp(state.step3StartTime)
      || toFiniteTimestamp(state.flowStartTime)
      || toFiniteTimestamp(fallbackTimestamp);
  }

  const api = {
    getStep4FilterAfterTimestamp,
    getStep7FilterAfterTimestamp,
    toFiniteTimestamp,
  };

  globalScope.MultiPageVerificationTiming = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
