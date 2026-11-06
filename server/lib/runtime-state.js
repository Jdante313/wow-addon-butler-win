'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../config');

const LAST_CHECK_FILE = path.join(DATA_DIR, 'last-check.json');
let lastCheck;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    lastCheck = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
  } catch {
    lastCheck = null;
  }
}

function getLastCheck() {
  load();
  return lastCheck;
}

function setLastCheck(value) {
  lastCheck = value;
  loaded = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // The in-memory value still works for this session.
  }
}

module.exports = { getLastCheck, setLastCheck };
