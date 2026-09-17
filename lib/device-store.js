'use strict';
/**
 * אחסון ניהול מכשירים — tokenים מקושרים, קודי קישור, זמנים.
 * המודול הזה מכיל את כל ה-I/O לדיסק של מצב ההתקשרות בין מכשירים.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const DEVICE_TTL_MS = 90 * 24 * 3600 * 1000;     // 90 ימים
const PAIR_MAX_TRIES = 5;
const PAIR_CODE_EXPIRY_MS = 15 * 60 * 1000;      // 15 דקות

module.exports = function createDeviceStore({ devicesFile, dbg = () => {} }) {
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  function readDevices() {
    try {
      const j = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
      return Array.isArray(j.devices) ? j.devices : [];
    } catch { return []; }
  }

  function writeDevices(devices) {
    const tmp = devicesFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, devicesFile);
  }

  function findDevice(token) {
    if (!token) return null;
    const h = hashToken(token);
    const now = Date.now();
    for (const d of readDevices()) {
      if (d.hash && d.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))) {
        if (d.expiresAt && d.expiresAt < now) return null;
        return d;
      }
    }
    return null;
  }

  function touchDevice(id) {
    const devices = readDevices();
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    const now = Date.now();
    if (d.lastSeen && now - d.lastSeen < 3600 * 1000) return;
    d.lastSeen = now;
    try { writeDevices(devices); } catch {}
  }

  let pairCode = null;

  function generatePairCode(by) {
    pairCode = {
      code: crypto.randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})/, '$1-'),
      by: by || null,
      tries: 0,
      expiresAt: Date.now() + PAIR_CODE_EXPIRY_MS,
    };
    return pairCode.code;
  }

  function consumePairCode(code, deviceLabel) {
    const normCode = (s) => String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const given = normCode(code);
    if (!given || !pairCode) return null;
    if (pairCode.expiresAt <= Date.now()) { pairCode = null; return null; }
    const want = Buffer.from(pairCode.code.replace(/-/g, ''));
    const got = Buffer.from(given);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      if (++pairCode.tries >= PAIR_MAX_TRIES) pairCode = null;
      return null;
    }
    const by = pairCode.by;
    pairCode = null;   // חד-פעמי
    const token = crypto.randomBytes(32).toString('base64url');
    const devices = readDevices();
    devices.push({
      id: crypto.randomBytes(6).toString('hex'),
      name: deviceLabel || 'מכשיר',
      ua: '',
      hash: hashToken(token),
      pairedBy: by || null,
      createdAt: Date.now(), lastSeen: Date.now(),
      expiresAt: Date.now() + DEVICE_TTL_MS,
    });
    writeDevices(devices);
    return token;
  }

  function listDevices() {
    const now = Date.now();
    return readDevices().filter((d) => !d.expiresAt || d.expiresAt >= now);
  }

  function removeDevice(id) {
    const devices = readDevices().filter((d) => d.id !== id);
    if (devices.length < readDevices().length) writeDevices(devices);
  }

  return {
    findDevice,
    touchDevice,
    generatePairCode: () => generatePairCode(),
    getPairCode: () => pairCode,
    consumePairCode,
    listDevices,
    removeDevice,
    readDevices,
    writeDevices,
  };
};
