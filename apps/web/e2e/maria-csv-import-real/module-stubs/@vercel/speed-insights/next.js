"use strict";

// Runtime-only analytics stub for the isolated browser harness. The application
// dependency is absent from the retained node_modules tree; this keeps the
// journey offline without changing production source or installing packages.
exports.SpeedInsights = function SpeedInsights() {
  return null;
};
