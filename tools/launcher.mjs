#!/usr/bin/env node
/**
 * Full application launcher
 * Starts OmniRoute (Docker), server, and opens browser
 */

import { spawn, exec } from 'child_process';
import { platform } from 'os';
import { setTimeout as sleep } from 'timers/promises';

const PORT = process.env.PORT || 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function openBrowser() {
  const cmds = {
    darwin: `open "${BASE_URL}"`,
    linux: `xdg-open "${BASE_URL}"`,
    win32: `start "${BASE_URL}"`
  };

  const cmd = cmds[platform()];
  if (!cmd) {
    console.log(`\n  🌐 פתח בדפדפן: ${BASE_URL}\n`);
    return;
  }

  exec(cmd, (err) => {
    if (err) console.log(`\n  🌐 פתח בדפדפן: ${BASE_URL}\n`);
  });
}

async function main() {
  console.log('\n  🚀 מעלה את כל רכיבי האפליקציה...\n');

  // Try to start OmniRoute
  console.log('  📦 OmniRoute (Docker) מתחיל...');
  const omniProcess = spawn('npm', ['run', 'omni:up'], {
    stdio: 'inherit',
    shell: true
  });

  await new Promise(resolve => {
    omniProcess.on('close', () => resolve());
    omniProcess.on('error', () => {
      console.log('  ⚠ OmniRoute לא הצליח — ממשיך בלעדיו\n');
      resolve();
    });
  });

  // Wait a bit for Docker to stabilize
  await sleep(1500);

  // Start server
  console.log('  🖥 השרת מתחיל...\n');
  const serverProcess = spawn('node', ['server.js'], {
    stdio: 'inherit'
  });

  // Give server a moment to bind
  await sleep(1500);

  // Open browser
  await openBrowser();

  // Keep running
  serverProcess.on('close', () => process.exit(0));
  process.on('SIGINT', () => {
    console.log('\n  ⏹ עוצר את השרת...\n');
    serverProcess.kill();
  });
}

main().catch(console.error);
