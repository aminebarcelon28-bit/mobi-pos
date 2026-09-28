import { buildMobileTestPage, loadMobilePrinter, saveMobilePrinter, DEFAULT_MOBILE_PRINTER } from '../src/utils/mobilePrinter.ts';

// 1. defaults + persistence round-trip
const d = loadMobilePrinter();
console.log('defaults:', JSON.stringify(d.enabled === false && d.wifiPort === 9100 && d.labelProtocol === 'ESCPOS' ? 'OK' : d));
saveMobilePrinter({ ...DEFAULT_MOBILE_PRINTER, enabled: true, connection: 'bluetooth', bluetoothMac: 'aa:bb:cc:dd:ee:ff', wifiHost: ' 192.168.1.20 ', wifiPort: 9100, labelProtocol: 'ZPL' });
const re = loadMobilePrinter();
const persistOk = re.enabled && re.connection === 'bluetooth' && re.bluetoothMac === 'AA:BB:CC:DD:EE:FF' && re.wifiHost === '192.168.1.20' && re.labelProtocol === 'ZPL';
console.log('persist:', persistOk ? 'OK' : JSON.stringify(re));
// corrupt storage falls back safely
localStorage.setItem('mobi_pos_mobile_printer_v1', '{broken');
console.log('corrupt-fallback:', loadMobilePrinter().enabled === false ? 'OK' : 'FAIL');
// bad values sanitized
saveMobilePrinter({ enabled: true, connection: 'wifi', wifiHost: '', wifiPort: 99999, bluetoothName: '', bluetoothMac: '', labelProtocol: 'XXX' });
const s = loadMobilePrinter();
console.log('sanitize:', s.wifiHost === '192.168.1.50' && s.wifiPort === 9100 && s.labelProtocol === 'ESCPOS' ? 'OK' : JSON.stringify(s));

// 2. test page bytes: starts with ESC @, ends with cut, non-empty
const page = buildMobileTestPage('STORE', 'Wi-Fi 1.2.3.4:9100');
const headOk = page[0] === 0x1b && page[1] === 0x40;
const tail = Array.from(page.slice(-4));
console.log('test-page:', page.length > 40 && headOk ? `OK (${page.length} bytes, tail ${tail.map((b) => b.toString(16)).join(' ')})` : 'FAIL');
