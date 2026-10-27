/** Probe: get the app from cold start to the LOGIN screen and photograph it. */
import * as adb from '../mobile/lib/adb.mjs';
import { dismissMobileOverlays } from '../lib/session.mjs';

const { sleep, ocrScreen, screenshot, startApp, stopApp } = adb;
const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 500);

stopApp();
startApp();
sleep(9000);

await dismissMobileOverlays(40000);
sleep(1500);

const lines = ocrScreen('probe-login');
console.log('SCREEN=' + flat(lines));
const shot = screenshot('probe-login');
console.log('SHOT=' + shot);
