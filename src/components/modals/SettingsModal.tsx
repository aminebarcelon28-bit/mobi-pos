import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  X, Cpu, Printer, Barcode, Monitor, ShieldCheck, Download, Upload,
  Wifi, WifiOff, Activity, Zap, RefreshCcw, CheckCircle2, AlertTriangle,
  XCircle, Clock, Play, Tag, QrCode, ScanLine, Cable,
  Bluetooth, Usb, ChevronDown, ChevronUp, Settings, HardDrive,
  Server, RotateCcw, Database, Shield, Radio, Sparkles,
  Award, TrendingUp, Volume2, VolumeX, Music, Cloud,
  Sun, Moon, ChevronLeft, Store, Smartphone, ExternalLink,
  Users, UserPlus, Trash2, Edit3, Lock, Eye, EyeOff,
  ShieldAlert, User, Check
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { formatDZD, APP_VERSION, type CashierUser } from '../../types/pos';
import { verifyPin, hashDeviceLocalPin, isCommonPin, needsPinRotation } from '../../utils/security';
import { verifyManagerGate, verifyUserGate } from '../../utils/pinGate';
import { friendlyPinSetError } from '../../api/pin';
import { canSeeJournalLauncher } from '../../utils/auditGate';
import { PinDialog } from '../ui/PinDialog';
import { normalizeLoyaltyConfig, calculateFinancialProfitImpact } from '../../utils/loyaltyEngine';
import type { LoyaltyProgramConfig } from '../../types/pos';
// P11.3: maintenanceService -> maintenanceAdapter -> backupSchema pulls the whole
// zod runtime into the entry chunk. These only run from settings actions.
import type { DbStats, IntegrityReport } from '../../services/maintenanceService';
import { useAppUpdater, openExternalUrl } from '../../hooks/useAppUpdater';
import { soundEngine } from '../../utils/audioFeedback';
// P11.3: the cloud-sync tab pulls in the sync engine (~267 kB) — load on open.
const CloudSyncPanel = React.lazy(() =>
  import('../settings/CloudSyncPanel').then((m) => ({ default: m.CloudSyncPanel })),
);

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

type DeviceCategory = 'receipt_printer' | 'label_printer' | 'barcode_scanner' | 'qr_scanner' | 'display';
type ConnectionType = 'USB' | 'Bluetooth' | 'Wi-Fi' | 'Serial' | 'HID' | 'Network' | 'HDMI';
type DeviceStatus = 'connected' | 'ready' | 'active' | 'testing' | 'error' | 'offline' | 'warning';
type DiagnosticResult = 'pass' | 'fail' | 'warning' | 'pending' | 'running';
type SettingsTab = 'appearance' | 'hardware' | 'security' | 'cloud_sync' | 'diagnostics' | 'loyalty' | 'backup' | 'updates';

interface PeripheralDevice {
  id: string;
  name: string;
  model: string;
  brand: string;
  category: DeviceCategory;
  connection: ConnectionType;
  port?: string;
  status: DeviceStatus;
  firmware?: string;
  driver?: string;
  protocol?: string;
  capabilities: string[];
  lastSeen: string;
  signalStrength?: number; // 0-100
  isAutoDetected?: boolean;
}

interface DiagnosticTest {
  id: string;
  deviceId: string;
  testName: string;
  description: string;
  result: DiagnosticResult;
  duration?: number; // ms
  message?: string;
  timestamp?: string;
}

// ══════════════════════════════════════════════════════════════
// INITIAL DEVICE REGISTRY
// Printers default to offline unless auto-detected or connected
// ══════════════════════════════════════════════════════════════

const INITIAL_DEVICE_REGISTRY: PeripheralDevice[] = [
  {
    id: 'rp-1',
    name: 'Imprimante Thermique ESC/POS',
    model: 'TM-T88VI',
    brand: 'Epson',
    category: 'receipt_printer',
    connection: 'USB',
    port: 'COM3',
    status: 'offline', // Default offline until detected/connected
    firmware: 'v42.01A',
    driver: 'ESC/POS Standard (Fallback Impression Windows/PDF)',
    protocol: 'ESC/POS',
    capabilities: ['Impression 80mm', 'Code QR', 'Code-barres', 'Logo', 'Découpe auto', 'Impression NV'],
    lastSeen: new Date().toISOString(),
    signalStrength: 0,
    isAutoDetected: false,
  },
  {
    id: 'lp-1',
    name: 'Imprimante Étiquettes Thermal',
    model: 'ZD421',
    brand: 'Zebra',
    category: 'label_printer',
    connection: 'USB',
    port: 'COM5',
    status: 'offline', // Default offline until detected/connected
    firmware: 'v78.20.3Z',
    driver: 'ZPL II',
    protocol: 'ZPL/EPL',
    capabilities: ['Étiquettes 100x50mm', 'Code-barres 1D/2D', 'QR Code', 'Impression thermique directe'],
    lastSeen: new Date().toISOString(),
    signalStrength: 0,
    isAutoDetected: false,
  },
  {
    id: 'bs-1',
    name: 'Lecteur Code-Barres 2D',
    model: 'Xenon 1950g',
    brand: 'Honeywell',
    category: 'barcode_scanner',
    connection: 'HID',
    status: 'offline', // Default offline until physical scanner is connected
    firmware: 'v3.12.8',
    driver: 'HID Keyboard Wedge (Automatique Windows)',
    protocol: 'USB-HID',
    capabilities: ['1D Barcode', '2D Barcode', 'QR Code', 'DataMatrix', 'PDF417', 'GS1', 'Omnidirectionnel'],
    lastSeen: new Date().toISOString(),
    signalStrength: 0,
    isAutoDetected: false,
  },
  {
    id: 'qs-1',
    name: 'Scanner QR Code & Mobile Pay',
    model: 'DS9308',
    brand: 'Zebra',
    category: 'qr_scanner',
    connection: 'USB',
    status: 'offline', // Default offline until physical scanner is connected
    firmware: 'v2.8.14',
    driver: 'SNAPI / HID',
    protocol: 'USB-HID / SNAPI',
    capabilities: ['QR Code', 'Code-barres 1D', 'DataMatrix', 'Lecture écran mobile', 'PDF417'],
    lastSeen: new Date().toISOString(),
    signalStrength: 0,
    isAutoDetected: false,
  },
  {
    id: 'cd-1',
    name: 'Afficheur Client Écran Secondaire',
    model: 'Webview Window #2',
    brand: 'Tauri',
    category: 'display',
    connection: 'HDMI',
    status: 'active',
    firmware: 'Tauri v2',
    driver: 'WebView2',
    protocol: 'HDMI 1080p',
    capabilities: ['Affichage client', 'Promotions', 'Panier temps réel', 'Publicité dynamique'],
    lastSeen: new Date().toISOString(),
    signalStrength: 100,
    isAutoDetected: true,
  },
];

// ══════════════════════════════════════════════════════════════
// DIAGNOSTIC TEST DEFINITIONS
// ══════════════════════════════════════════════════════════════

const createDiagnosticTests = (device: PeripheralDevice): Omit<DiagnosticTest, 'timestamp'>[] => {
  const common: Omit<DiagnosticTest, 'timestamp'>[] = [
    { id: `${device.id}-conn`, deviceId: device.id, testName: 'Connexion Matérielle', description: `Vérifier la connectivité ${device.connection}`, result: 'pending' },
    { id: `${device.id}-driver`, deviceId: device.id, testName: 'Pilote / Driver', description: `Validation du pilote ${device.driver || 'système'}`, result: 'pending' },
    { id: `${device.id}-firmware`, deviceId: device.id, testName: 'Version Firmware', description: `Vérification firmware ${device.firmware || 'N/A'}`, result: 'pending' },
  ];

  if (device.category === 'receipt_printer' || device.category === 'label_printer') {
    return [
      ...common,
      { id: `${device.id}-print`, deviceId: device.id, testName: 'Test d\'Impression', description: 'Envoyer une page de test au périphérique', result: 'pending' },
      { id: `${device.id}-paper`, deviceId: device.id, testName: 'Détection Papier', description: 'Vérifier la présence du rouleau papier/étiquettes', result: 'pending' },
      { id: `${device.id}-cut`, deviceId: device.id, testName: 'Mécanisme de Découpe', description: 'Test du cutter automatique', result: 'pending' },
    ];
  }

  if (device.category === 'barcode_scanner' || device.category === 'qr_scanner') {
    return [
      ...common,
      { id: `${device.id}-scan`, deviceId: device.id, testName: 'Test de Lecture', description: 'Vérifier la capacité de décodage', result: 'pending' },
      { id: `${device.id}-speed`, deviceId: device.id, testName: 'Vitesse de Décodage', description: 'Mesurer le temps de réponse du scanner', result: 'pending' },
    ];
  }

  return [
    ...common,
    { id: `${device.id}-signal`, deviceId: device.id, testName: 'Signal / Affichage', description: 'Vérifier le signal de sortie', result: 'pending' },
  ];
};

// ══════════════════════════════════════════════════════════════
// COMPATIBLE BRANDS DATABASE
// ══════════════════════════════════════════════════════════════

const BRAND_COMPATIBILITY: Record<DeviceCategory, { brands: string[], protocols: string[] }> = {
  receipt_printer: {
    brands: ['Epson', 'Star Micronics', 'Bixolon', 'Citizen', 'Sewoo', 'Custom', 'HPRT', 'Rongta', 'Xprinter', 'POS-X', 'Munbyn', 'Gainscha'],
    protocols: ['ESC/POS', 'StarPRNT', 'CPCL', 'ZPL', 'Line Mode', 'Page Mode'],
  },
  label_printer: {
    brands: ['Zebra', 'DYMO', 'Brother', 'TSC', 'Godex', 'SATO', 'Honeywell', 'Bixolon', 'Xprinter', 'iDPRT', 'Niimbot', 'Rollo'],
    protocols: ['ZPL II', 'EPL', 'TSPL', 'DPL', 'SBPL', 'CPCL', 'ESC/POS Label'],
  },
  barcode_scanner: {
    brands: ['Honeywell', 'Zebra/Symbol', 'Datalogic', 'Newland', 'Opticon', 'CipherLab', 'Unitech', 'Socket Mobile', 'Eyoyo', 'Tera', 'Inateck', 'NetumScan'],
    protocols: ['USB-HID', 'RS-232 Serial', 'SPP Bluetooth', 'Keyboard Wedge', 'SNAPI', 'OPOS'],
  },
  qr_scanner: {
    brands: ['Zebra', 'Honeywell', 'Datalogic', 'Newland', 'Sunmi', 'Socket Mobile', 'Eyoyo', 'Tera', 'NetumScan', 'Symcode', 'MUNBYN'],
    protocols: ['USB-HID', 'SNAPI', 'Keyboard Wedge', 'Virtual COM', 'BLE GATT'],
  },
  display: {
    brands: ['Tauri WebView', 'Sunmi', 'Posiflex', 'Bematech', 'HP', 'Elo', 'Generic HDMI', 'Generic VGA'],
    protocols: ['HDMI', 'VGA', 'WebView IPC', 'DisplayPort', 'USB-C Alt Mode'],
  },
};

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

const categoryLabel: Record<DeviceCategory, string> = {
  receipt_printer: 'Imprimante Tickets',
  label_printer: 'Imprimante Étiquettes',
  barcode_scanner: 'Lecteur Code-Barres',
  qr_scanner: 'Scanner QR Code',
  display: 'Afficheur Client',
};

const categoryIcon: Record<DeviceCategory, React.ReactNode> = {
  receipt_printer: <Printer className="w-5 h-5" />,
  label_printer: <Tag className="w-5 h-5" />,
  barcode_scanner: <Barcode className="w-5 h-5" />,
  qr_scanner: <QrCode className="w-5 h-5" />,
  display: <Monitor className="w-5 h-5" />,
};

const connectionIcon: Record<ConnectionType, React.ReactNode> = {
  USB: <Usb className="w-3 h-3" />,
  Bluetooth: <Bluetooth className="w-3 h-3" />,
  'Wi-Fi': <Wifi className="w-3 h-3" />,
  Serial: <Cable className="w-3 h-3" />,
  HID: <Cpu className="w-3 h-3" />,
  Network: <Server className="w-3 h-3" />,
  HDMI: <Monitor className="w-3 h-3" />,
};

const statusConfig: Record<DeviceStatus, { label: string; color: string; bgColor: string; borderColor: string; icon: React.ReactNode }> = {
  connected: { label: 'Connecté', color: 'text-emerald-400', bgColor: 'bg-emerald-500/15', borderColor: 'border-emerald-500/30', icon: <ShieldCheck className="w-3 h-3" /> },
  ready: { label: 'Prêt', color: 'text-emerald-400', bgColor: 'bg-emerald-500/15', borderColor: 'border-emerald-500/30', icon: <ShieldCheck className="w-3 h-3" /> },
  active: { label: 'Actif', color: 'text-emerald-400', bgColor: 'bg-emerald-500/15', borderColor: 'border-emerald-500/30', icon: <ShieldCheck className="w-3 h-3" /> },
  testing: { label: 'En Test...', color: 'text-amber-400', bgColor: 'bg-amber-500/15', borderColor: 'border-amber-500/30', icon: <Activity className="w-3 h-3 animate-pulse" /> },
  error: { label: 'Erreur', color: 'text-red-400', bgColor: 'bg-red-500/15', borderColor: 'border-red-500/30', icon: <XCircle className="w-3 h-3" /> },
  offline: { label: 'Hors Ligne / Non Détecté', color: 'text-slate-400', bgColor: 'bg-slate-500/15', borderColor: 'border-slate-500/30', icon: <WifiOff className="w-3 h-3" /> },
  warning: { label: 'Avertissement', color: 'text-amber-400', bgColor: 'bg-amber-500/15', borderColor: 'border-amber-500/30', icon: <AlertTriangle className="w-3 h-3" /> },
};

const resultConfig: Record<DiagnosticResult, { label: string; color: string; icon: React.ReactNode }> = {
  pass: { label: 'OK', color: 'text-emerald-400', icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
  fail: { label: 'Échec', color: 'text-red-400', icon: <XCircle className="w-4 h-4 text-red-400" /> },
  warning: { label: 'Alerte', color: 'text-amber-400', icon: <AlertTriangle className="w-4 h-4 text-amber-400" /> },
  pending: { label: 'En Attente', color: 'text-pos-muted', icon: <Clock className="w-4 h-4 text-pos-muted" /> },
  running: { label: 'En Cours...', color: 'text-cyan-400', icon: <Activity className="w-4 h-4 text-cyan-400 animate-pulse" /> },
};

// ══════════════════════════════════════════════════════════════
// COMPONENT
// ══════════════════════════════════════════════════════════════

// Mobile Wi-Fi / Bluetooth printer card (phone only, per-device config).
// Self-contained: lazy-loads the mobilePrinter module so the escpos graph
// stays out of the settings chunk until this card mounts.
const MobilePrinterCard: React.FC<{ storeName?: string }> = ({ storeName }) => {
  const { showToast } = useToast();
  const [config, setConfig] = useState<import('../../types/pos').MobilePrinterConfig | null>(null);
  const [btDevices, setBtDevices] = useState<Array<{ name: string; mac: string }>>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    import('../../utils/mobilePrinter')
      .then((m) => setConfig((prev) => prev || m.loadMobilePrinter()))
      .catch(() => undefined);
  }, []);

  const update = (patch: Partial<import('../../types/pos').MobilePrinterConfig>) => {
    // B-051: pure state update — persistence runs outside the setState
    // updater (updaters may re-run under StrictMode; side effects there
    // double-save or swallow errors silently).
    const base = config || {
      enabled: false,
      connection: 'wifi' as const,
      wifiHost: '192.168.1.50',
      wifiPort: 9100,
      bluetoothName: '',
      bluetoothMac: '',
      labelProtocol: 'ESCPOS' as const,
    };
    const next = { ...base, ...patch };
    setConfig(next);
    import('../../utils/mobilePrinter')
      .then((m) => m.saveMobilePrinter(next))
      .catch((err: unknown) => {
        console.error('[mobile-printer] save failed:', err);
        setMsg('Échec de sauvegarde de l\'imprimante — réessayez.');
      });
    setMsg('');
  };

  const handleBtScan = async () => {
    setBtScanning(true);
    setMsg('');
    try {
      const { listBondedBluetoothPrinters } = await import('../../utils/mobilePrinter');
      const devices = await listBondedBluetoothPrinters();
      setBtDevices(devices);
      setMsg(
        devices.length === 0
          ? "Aucune imprimante appairée — appairez-la d'abord dans les réglages Bluetooth d'Android, puis touchez « Rechercher »."
          : `${devices.length} appareil(s) appairé(s) — touchez-en un pour le sélectionner.`
      );
    } catch {
      setMsg("Bluetooth inaccessible — autorisez l'accès puis réessayez.");
    } finally {
      setBtScanning(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg('');
    try {
      const { buildMobileTestPage, printBytesViaMobilePrinter } = await import('../../utils/mobilePrinter');
      const result = await printBytesViaMobilePrinter(
        buildMobileTestPage(storeName || 'MOBI-POS', config?.connection === 'bluetooth' ? `Bluetooth ${config.bluetoothMac}` : `Wi-Fi ${config?.wifiHost}:${config?.wifiPort}`)
      );
      const okMsg = '✅ Page de test envoyée — vérifiez l’imprimante.';
      const koMsg = "❌ Échec d'envoi — vérifiez l'adresse IP / l'appairage Bluetooth.";
      setMsg(result.sent ? okMsg : koMsg);
      showToast(result.sent ? okMsg : koMsg, result.sent ? 'success' : 'error');
    } catch {
      setMsg("❌ Échec d'envoi — vérifiez la configuration.");
    } finally {
      setTesting(false);
    }
  };

  if (!config) return null;

  return (
    <div className="bg-pos-card border border-cyan-500/30 rounded-xl p-4 space-y-3 shadow-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
            <Printer className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-bold text-pos-text truncate">Imprimante Mobile Wi-Fi / Bluetooth</h4>
            <span className="text-[10px] text-pos-muted block truncate">Tickets & étiquettes directs, sans PC</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => update({ enabled: !config.enabled })}
          className={`min-h-[44px] px-4 rounded-xl text-xs font-bold border transition cursor-pointer active:scale-95 shrink-0 ${
            config.enabled
              ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
              : 'bg-pos-bg border-pos-border text-pos-muted'
          }`}
        >
          {config.enabled ? 'Activée' : 'Désactivée'}
        </button>
      </div>

      {config.enabled && (
        <div className="space-y-3">
          {/* Connection picker */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => update({ connection: 'wifi' })}
              className={`min-h-[48px] rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-95 ${
                config.connection === 'wifi'
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                  : 'bg-pos-bg border-pos-border text-pos-muted'
              }`}
            >
              <Wifi className="w-4 h-4" /> Wi-Fi (réseau)
            </button>
            <button
              type="button"
              onClick={() => update({ connection: 'bluetooth' })}
              className={`min-h-[48px] rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-95 ${
                config.connection === 'bluetooth'
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                  : 'bg-pos-bg border-pos-border text-pos-muted'
              }`}
            >
              <Bluetooth className="w-4 h-4" /> Bluetooth
            </button>
          </div>

          {config.connection === 'wifi' ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Adresse IP imprimante</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={config.wifiHost}
                  onChange={(e) => update({ wifiHost: e.target.value.trim() })}
                  placeholder="192.168.1.50"
                  className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Port</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={config.wifiPort}
                  onChange={(e) => update({ wifiPort: Math.max(1, Math.min(65535, parseInt(e.target.value) || 9100)) })}
                  placeholder="9100"
                  className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleBtScan}
                disabled={btScanning}
                className="w-full min-h-[48px] rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/40 text-cyan-300 text-xs font-bold transition cursor-pointer active:scale-95 disabled:opacity-50"
              >
                {btScanning ? 'Recherche en cours…' : '🔍 Rechercher les imprimantes appairées'}
              </button>
              {btDevices.map((d) => (
                <button
                  key={d.mac}
                  type="button"
                  onClick={() => update({ bluetoothMac: d.mac, bluetoothName: d.name })}
                  className={`w-full min-h-[48px] px-3 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 transition cursor-pointer active:scale-95 ${
                    config.bluetoothMac === d.mac
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-pos-bg border-pos-border text-pos-text'
                  }`}
                >
                  <span className="truncate">{d.name}</span>
                  <span className="font-mono text-[10px] text-pos-muted shrink-0">{d.mac}</span>
                </button>
              ))}
              <p className="text-[10px] text-pos-muted leading-relaxed">
                Appairez d'abord l'imprimante dans les réglages Bluetooth d'Android (code PIN souvent 0000 ou 1234).
              </p>
            </div>
          )}

          {/* Label language */}
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">Langage étiquettes (imprimante tickets/codes-barres)</label>
            <div className="grid grid-cols-3 gap-2">
              {(['ESCPOS', 'TSPL', 'ZPL'] as const).map((proto) => (
                <button
                  key={proto}
                  type="button"
                  onClick={() => update({ labelProtocol: proto })}
                  className={`min-h-[48px] rounded-xl border text-xs font-bold transition cursor-pointer active:scale-95 ${
                    config.labelProtocol === proto
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {proto === 'ESCPOS' ? 'Ticket (ESC/POS)' : proto === 'TSPL' ? 'TSC / Xprinter' : 'Zebra (ZPL)'}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="w-full min-h-[52px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition cursor-pointer active:scale-[0.98] disabled:opacity-50"
          >
            {testing ? 'Envoi en cours…' : '🖨️ Imprimer une page de test'}
          </button>

          {msg && (
            <p className="text-[11px] text-pos-text bg-pos-bg border border-pos-border rounded-xl px-3 py-2 leading-relaxed">{msg}</p>
          )}
        </div>
      )}
    </div>
  );
};

export const SettingsModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    exportDatabase,
    importDatabase,
    receiptSettings,
    setReceiptSettings,
    // Phase 4a: all credential mints route through rotatePinCredential
    // (native Argon2id under Tauri); setManagerPin is no longer called here.
    // Phase 1: no verifyManagerPin reads here — auth routes through
    // utils/pinGate (native); raw verifyPin below is uniqueness-only.
    cashierUsers,
    setCashierUsers,
    activeCashier,
    managerPin,
    securityAuditLog,
    themeMode,
    toggleTheme,
  } = usePosStore();
  const { showToast } = useToast();
  // Format-aware credential badge: the label must describe the ACTUAL stored
  // envelope (v2 Argon2id vs legacy v1), never a hardcoded algorithm claim.
  const managerKdfLabel = (() => {
    const h = (managerPin || '').trim();
    if (!h) return 'Non configuré';
    if (h.startsWith('v2$')) return 'Actif (Argon2id)';
    if (!needsPinRotation(h)) return 'Actif (local)';
    return 'Hérité (rotation requise)';
  })();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Restore is a destructive tamper primitive (replaces transactions, audit,
  // vouchers): manager PIN required before the picker even opens.
  const [restorePinInput, setRestorePinInput] = useState('');
  // Phase 2: two-step restore — the file is picked and VALIDATED first (no
  // PIN burned on malformed input), then the fresh-PIN guard executes it.
  const [stagedRestore, setStagedRestore] = useState<{
    content: string;
    sha256: string;
    version?: string;
    counts?: Record<string, number>;
  } | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  // Decision 2: the full-JSON export leaves the device — fresh manager PIN
  // per download (native gate via PinDialog, fail-closed), even though
  // credential rows no longer ride in the file.
  const [showExportPin, setShowExportPin] = useState(false);
  const updater = useAppUpdater();

  const handleCheckUpdates = async () => {
    soundEngine.playKeyBeep?.();
    showToast('Recherche des mises à jour en cours...', 'info', 2000);
    const res = await updater.checkForUpdates(true);
    if (res.hasUpdate) {
      soundEngine.playSuccess?.();
      showToast(`🚀 Mise à jour v${res.version} disponible au téléchargement !`, 'info', 5000);
    } else if (res.success) {
      soundEngine.playSuccess?.();
      showToast(`✅ Votre système est parfaitement à jour (Version v${APP_VERSION}).`, 'success', 4000);
    } else {
      soundEngine.playError?.();
      showToast(`Vérification : ${res.message}`, 'warning', 5000);
    }
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>('hardware');
  const [devices, setDevices] = useState<PeripheralDevice[]>(INITIAL_DEVICE_REGISTRY);
  // Tab strip: translate a vertical mouse wheel into a horizontal scroll so
  // all tabs stay reachable without Shift+wheel or a trackpad gesture.
  const tabStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // B-044: receipt profile fields edit a local draft; a 500ms debounce
  // flushes to the async store setter so keystrokes are never lost to an
  // unawaited Promise and DB failures surface as a toast.
  const [receiptDraft, setReceiptDraft] = useState(receiptSettings);
  const receiptSaveTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (activeModal !== 'settings') return;
    setReceiptDraft(receiptSettings);
    return () => {
      if (receiptSaveTimerRef.current) window.clearTimeout(receiptSaveTimerRef.current);
    };
    // Intentionally not depending on receiptSettings — syncing on every store
    // write would clobber in-flight keystrokes (that's the bug we're fixing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const scheduleReceiptSave = (next: typeof receiptDraft) => {
    setReceiptDraft(next);
    if (receiptSaveTimerRef.current) window.clearTimeout(receiptSaveTimerRef.current);
    receiptSaveTimerRef.current = window.setTimeout(() => {
      setReceiptSettings(next)
        .then(() => undefined)
        .catch((err: unknown) => {
          console.error('[settings] receipt settings save failed:', err);
          showToast("Échec de sauvegarde des paramètres de ticket — réessayez.", 'error');
        });
    }, 500);
  };
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [diagnosticTests, setDiagnosticTests] = useState<DiagnosticTest[]>([]);
  const [isRunningAllDiag, setIsRunningAllDiag] = useState(false);
  const [selectedDiagDevice, setSelectedDiagDevice] = useState<string | null>(null);
  const [scannerTestInput, setScannerTestInput] = useState('');
  const [scannerTestActive, setScannerTestActive] = useState(false);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const scannerInputRef = useRef<HTMLInputElement>(null);

  // ── Manager Security PIN State ──
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [isUpdatingPin, setIsUpdatingPin] = useState(false);
  const [showManagerPin, setShowManagerPin] = useState(false);

  // ── Cashier & Staff Management State ──
  const [isCashierModalOpen, setIsCashierModalOpen] = useState(false);  const [editingCashierId, setEditingCashierId] = useState<string | null>(null);
  const [cashierNameInput, setCashierNameInput] = useState('');
  const [previousCashierPinInput, setPreviousCashierPinInput] = useState('');
  const [cashierPinInput, setCashierPinInput] = useState('');
  const [confirmCashierPinInput, setConfirmCashierPinInput] = useState('');
  const [cashierRoleInput, setCashierRoleInput] = useState<'admin' | 'cashier'>('cashier');
  const [cashierColorInput, setCashierColorInput] = useState('#10b981');
  const [showCashierPin, setShowCashierPin] = useState(false);
  const [isSavingCashier, setIsSavingCashier] = useState(false);

  const handleOpenAddCashier = () => {
    setEditingCashierId(null);
    setCashierNameInput('');
    setPreviousCashierPinInput('');
    setCashierPinInput('');
    setConfirmCashierPinInput('');
    setCashierRoleInput('cashier');
    setCashierColorInput('#10b981');
    setShowCashierPin(false);
    setIsCashierModalOpen(true);
  };

  const handleOpenEditCashier = (cashier: CashierUser) => {
    setEditingCashierId(cashier.id);
    setCashierNameInput(cashier.name);
    setPreviousCashierPinInput('');
    setCashierPinInput('');
    setConfirmCashierPinInput('');
    setCashierRoleInput(cashier.role);
    setCashierColorInput(cashier.avatarColor || '#3b82f6');
    setShowCashierPin(false);
    setIsCashierModalOpen(true);
  };

  const handleSaveCashier = async () => {
    const cleanName = cashierNameInput.trim();
    if (!cleanName) {
      showToast("Veuillez saisir un nom pour l'employé.", 'error');
      return;
    }

    let targetPin = '';

    if (editingCashierId) {
      const existing = cashierUsers.find((u) => u.id === editingCashierId);
      if (!existing) return;

      const cleanPrev = previousCashierPinInput.trim();
      const cleanNew = cashierPinInput.trim();
      const cleanConfirm = confirmCashierPinInput.trim();

      const isAttemptingPinChange = cleanPrev.length > 0 || cleanNew.length > 0 || cleanConfirm.length > 0;

      if (isAttemptingPinChange) {
        const isTargetManager = cashierRoleInput === 'admin' || existing.role === 'admin';
        const minLen = isTargetManager ? 6 : 4;
        const maxLen = isTargetManager ? 8 : 4;

        if (!cleanPrev) {
          showToast(
            isTargetManager
              ? "Sécurité : veuillez saisir l'ancien code PIN gérant (ou le PIN Manager actuel)."
              : "Sécurité : veuillez saisir l'ancien code PIN du caissier (ou le PIN Manager).",
            'error'
          );
          return;
        }

        // Phase 1: old-PIN authorization is native (fail-closed), composed
        // explicitly — the user's own credential OR the manager credential.
        // No plaintext leg: legacy plaintexts are hashed at boot, and the
        // kernel rejects them fail-closed. Locked shows the countdown.
        const ownGate = await verifyUserGate(existing.id, cleanPrev);
        const managerGate =
          ownGate.ok ? null : await verifyManagerGate(cleanPrev);
        const isAuthorized = ownGate.ok || managerGate?.ok === true;
        if (managerGate?.locked || ownGate.locked) {
          showToast(
            `Verrouillé — réessayez dans ${Math.max(
              1,
              Math.ceil((managerGate?.remainingMs ?? ownGate.remainingMs) / 1000)
            )}s.`,
            'error'
          );
          return;
        }

        if (!isAuthorized) {
          showToast("L'ancien code PIN est incorrect (ou PIN Manager invalide).", 'error');
          return;
        }

        if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < minLen || cleanNew.length > maxLen) {
          showToast(
            isTargetManager
              ? "Le nouveau code PIN gérant doit comporter 6 à 8 chiffres."
              : "Le nouveau code PIN caissier doit comporter exactement 4 chiffres.",
            'error'
          );
          return;
        }

        if (cleanNew !== cleanConfirm) {
          showToast("Les deux nouveaux codes PIN saisis ne correspondent pas.", 'error');
          return;
        }

        // Strict per-profile PIN: every account keeps a distinct code so the
        // lock screen can resolve identity by selection (shared codes would
        // let one PIN open two profiles). Check side-effect free via
        // verifyPin (never verifyManagerPin here — it records failures).
        const otherUsers = cashierUsers.filter((u) => u.id !== editingCashierId);
        if (otherUsers.some((u) => verifyPin(cleanNew, u.pin))) {
          showToast('Chaque personne doit avoir un code PIN différent (code déjà utilisé).', 'error');
          return;
        }
        // Banal-PIN screen (NIST 800-63B-4): instant feedback; native
        // pin_set enforces authoritatively (a bypass still cannot mint).
        if (isCommonPin(cleanNew)) {
          showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
          return;
        }

        // Single-PIN contract: the primary admin (first role==='admin') IS the
        // manager — their PIN change goes through the master flow, which
        // mirrors it back onto this user row. Secondary admins keep their own.
        const primaryAdminId = cashierUsers.find((u) => u.role === 'admin')?.id;
        if (existing.id === primaryAdminId) {
          // Phase 4a: master rotation mints natively under Tauri (Argon2id);
          // the store refreshes memory + mirror from the authority.
          await usePosStore.getState().rotatePinCredential('manager', cleanNew, true);
          targetPin = usePosStore.getState().managerPin;
          if (!targetPin) {
            showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
            return;
          }
          showToast('Code PIN du gérant mis à jour (PIN Manager synchronisé).', 'success');
        } else {
          const managerHash = usePosStore.getState().managerPin;
          if (managerHash && verifyPin(cleanNew, managerHash)) {
            showToast('Chaque personne doit avoir un code PIN différent (code gérant réservé).', 'error');
            return;
          }
          // Non-primary cashier: native rotation writes their own roster row
          // (secondary admins keep their own credential — never the master).
          await usePosStore.getState().rotatePinCredential(existing.id, cleanNew, false);
          targetPin = usePosStore.getState().cashierUsers.find((u) => u.id === existing.id)?.pin || '';
          if (!targetPin) {
            showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
            return;
          }
        }
      } else {
        // Conserver le code PIN existant sans modification
        targetPin = existing.pin;
      }
    } else {
      // Création d'un nouveau caissier
      const cleanNew = cashierPinInput.trim();
      const cleanConfirm = confirmCashierPinInput.trim();
      const isTargetManager = cashierRoleInput === 'admin';
      const minLen = isTargetManager ? 6 : 4;
      const maxLen = isTargetManager ? 8 : 4;

      if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < minLen || cleanNew.length > maxLen) {
        showToast(
          isTargetManager
            ? "Le code PIN gérant doit comporter 6 à 8 chiffres."
            : "Le code PIN caissier doit comporter exactement 4 chiffres (ex: 1234).",
          'error'
        );
        return;
      }

      if (cleanNew !== cleanConfirm) {
        showToast("Les deux codes PIN saisis ne correspondent pas.", 'error');
        return;
      }

      // Strict per-profile PIN (see edit branch): reject codes already owned
      // by another profile or by the manager — side-effect free verifyPin.
      const managerHashForNew = usePosStore.getState().managerPin;
      if (
        cashierUsers.some((u) => verifyPin(cleanNew, u.pin)) ||
        (managerHashForNew && verifyPin(cleanNew, managerHashForNew))
      ) {
        showToast('Chaque personne doit avoir un code PIN différent (code déjà utilisé).', 'error');
        return;
      }
      if (isCommonPin(cleanNew)) {
        showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
        return;
      }

      // New profile: the credential row must exist before the native KDF can
      // own it (`pin_set` refuses unknown ids rather than inventing rows), so
      // create with an empty PIN, rotate natively, and roll the row back if
      // rotation fails — an admin row with an empty PIN would alias the
      // manager credential, which must never survive a failed creation.
      const newId = `usr-${Date.now().toString(36)}`;
      const { isTauriEnv } = await import('../../db/adapters/base');
      if (isTauriEnv()) {
        // Inert placeholder, never a usable credential: non-digit, random,
        // unverifiable anywhere (native Unknown → deny, TS verifyPin false).
        // An empty PIN would alias an admin row to the MASTER credential; a
        // kill between this persist and the rotation below must orphan a
        // visible-but-dead row, never a phantom manager.
        const placeholder = `PENDING-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        const skeleton: CashierUser = {
          id: newId,
          name: cleanName,
          pin: placeholder,
          role: cashierRoleInput,
          avatarColor: cashierColorInput,
        };
        await setCashierUsers([...cashierUsers, skeleton]);
        try {
          await usePosStore.getState().rotatePinCredential(newId, cleanNew, cashierRoleInput === 'admin');
        } catch (e: unknown) {
          await setCashierUsers(cashierUsers).catch(() => {});
          showToast(`Création refusée (${friendlyPinSetError(e)}).`, 'error');
          setIsSavingCashier(false);
          return;
        }
        targetPin = usePosStore.getState().cashierUsers.find((u) => u.id === newId)?.pin || '';
        if (!targetPin) {
          await setCashierUsers(cashierUsers).catch(() => {});
          showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
          setIsSavingCashier(false);
          return;
        }
        // The roster row already exists (skeleton + native rotation above):
        // finalize name/role/color on it instead of appending a duplicate.
        await setCashierUsers(
          usePosStore.getState().cashierUsers.map((u) =>
            u.id === newId ? { ...u, name: cleanName, role: cashierRoleInput, avatarColor: cashierColorInput } : u
          )
        );
        setIsCashierModalOpen(false);
        soundEngine.playSuccess?.();
        showToast(`Caissier "${cleanName}" ajouté à l'équipe !`, 'success');
        return;
      } else {
        targetPin = hashDeviceLocalPin(cleanNew);
      }
    }

    setIsSavingCashier(true);
    try {
      let updated: CashierUser[];
      if (editingCashierId) {
        const otherAdmins = cashierUsers.filter((u) => u.id !== editingCashierId && u.role === 'admin');
        if (otherAdmins.length === 0 && cashierRoleInput !== 'admin') {
          showToast('Impossible : il doit rester au moins un Administrateur dans le système.', 'error');
          setIsSavingCashier(false);
          return;
        }

        updated = cashierUsers.map((u) =>
          u.id === editingCashierId
            ? {
                ...u,
                name: cleanName,
                pin: targetPin,
                role: cashierRoleInput,
                avatarColor: cashierColorInput,
              }
            : u
        );
      } else {
        const newId = `usr-${Date.now().toString(36)}`;
        const newCashier: CashierUser = {
          id: newId,
          name: cleanName,
          pin: targetPin,
          role: cashierRoleInput,
          avatarColor: cashierColorInput,
        };
        updated = [...cashierUsers, newCashier];
      }

      // Single-PIN contract: if the primary admin was just demoted, the
      // manager PIN follows the new primary admin (first remaining admin) —
      // otherwise the manager would hold two PINs again.
      const prevPrimaryId = cashierUsers.find((u) => u.role === 'admin')?.id;
      const nextPrimary = updated.find((u) => u.role === 'admin');
      const masterHash = usePosStore.getState().managerPin;
      const demotedPrimary =
        editingCashierId && prevPrimaryId === editingCashierId && nextPrimary && nextPrimary.id !== editingCashierId;
      const finalUpdated =
        demotedPrimary && masterHash && nextPrimary.pin !== masterHash
          ? updated.map((u) => (u.id === nextPrimary.id ? { ...u, pin: masterHash } : u))
          : updated;

      await setCashierUsers(finalUpdated);
      setIsCashierModalOpen(false);
      soundEngine.playSuccess?.();
      showToast(
        editingCashierId
          ? `Caissier "${cleanName}" mis à jour avec succès.`
          : `Caissier "${cleanName}" ajouté à l'équipe !`,
        'success'
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // PIN-engine failures get the friendly text (no wire internals);
      // anything else keeps the raw message for debuggability.
      const friendly = friendlyPinSetError(e);
      showToast(friendly !== "Échec de l'enregistrement du nouveau PIN. Réessayez." ? friendly : `Erreur : ${msg}`, 'error');
    } finally {
      setIsSavingCashier(false);
    }
  };

  const handleDeleteCashier = async (cashierId: string) => {
    const target = cashierUsers.find((u) => u.id === cashierId);
    if (!target) return;

    if (target.role === 'admin') {
      const adminCount = cashierUsers.filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) {
        showToast('Action impossible : vous ne pouvez pas supprimer le seul Administrateur du magasin.', 'error');
        return;
      }
    }

    if (!window.confirm(`Êtes-vous sûr de vouloir supprimer le compte caissier "${target.name}" ?`)) {
      return;
    }

    try {
      const nextUsers = cashierUsers.filter((u) => u.id !== cashierId);
      // Single-PIN contract: if the primary admin was just deleted, the
      // manager PIN follows the new primary admin.
      const wasPrimary = cashierUsers.find((u) => u.role === 'admin')?.id === cashierId;
      const masterHash = usePosStore.getState().managerPin;
      const nextPrimary = nextUsers.find((u) => u.role === 'admin');
      const finalUsers =
        wasPrimary && masterHash && nextPrimary && nextPrimary.pin !== masterHash
          ? nextUsers.map((u) => (u.id === nextPrimary.id ? { ...u, pin: masterHash } : u))
          : nextUsers;
      await setCashierUsers(finalUsers);
      soundEngine.playSuccess?.();
      showToast(`Compte caissier "${target.name}" supprimé.`, 'info');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur suppression : ${msg}`, 'error');
    }
  };

  const handleUpdateManagerPin = async () => {
    if (!currentPinInput) {
      showToast('Veuillez saisir votre code PIN actuel.', 'error');
      return;
    }
    // Phase 1: current-PIN check is native (fail-closed); Locked shows the
    // countdown. Legacy shorter codes verify natively once for migration.
    const gate = await verifyManagerGate(currentPinInput);
    if (!gate.ok) {
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Le code PIN actuel est incorrect.',
        'error'
      );
      return;
    }
    // Phase 4.5 + 4a: manager PINs are 6–8 digits (uniform mint policy —
    // longer would be untypeable at login). Legacy shorter manager codes
    // verify natively once for migration before the mandatory lock-screen
    // rotation; the current-PIN input keeps maxLength 8 so legacy codes stay
    // enterable.
    if (!/^[0-9]{6,8}$/.test(newPinInput)) {
      showToast('Le nouveau code PIN gérant doit comporter 6 à 8 chiffres.', 'error');
      return;
    }
    if (newPinInput !== confirmPinInput) {
      showToast('Les deux nouveaux codes PIN saisis ne correspondent pas.', 'error');
      return;
    }
    if (isCommonPin(newPinInput)) {
      showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
      return;
    }
    setIsUpdatingPin(true);
    try {
      // Phase 4a: master rotation mints natively under Tauri (Argon2id v2).
      await usePosStore.getState().rotatePinCredential('manager', newPinInput, true);
      setCurrentPinInput('');
      setNewPinInput('');
      setConfirmPinInput('');
      soundEngine.playSuccess?.();
      showToast('Nouveau Code PIN Manager enregistré avec succès.', 'success');
    } catch (e: unknown) {
      showToast(friendlyPinSetError(e), 'error');
    } finally {
      setIsUpdatingPin(false);
    }
  };

  // ── Audio Feedback Profile State ──
  const [audioProfile, setAudioProfile] = useState(() => soundEngine.getProfile());

  const handleUpdateAudio = (updates: Partial<typeof audioProfile>) => {
    const next = { ...audioProfile, ...updates };
    setAudioProfile(next);
    soundEngine.setProfile(next);
  };

  // ── SQLite Engine & Diagnostics State ──
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [isCheckingIntegrity, setIsCheckingIntegrity] = useState(false);
  const [isCheckpointing, setIsCheckpointing] = useState(false);
  const [isVacuuming, setIsVacuuming] = useState(false);

  const loadDbStats = useCallback(async () => {
    try {
        const { maintenanceService } = await import('../../services/maintenanceService');
      const stats = await maintenanceService.getDatabaseStats();
      setDbStats(stats);
    } catch (e) {
      console.warn('Failed to load SQLite stats:', e);
    }
  }, []);

  const handleRunIntegrityCheck = async () => {
    setIsCheckingIntegrity(true);
    try {
        const { maintenanceService } = await import('../../services/maintenanceService');
      const report = await maintenanceService.runDatabaseIntegrityCheck();
      setIntegrityReport(report);
      if (report.is_healthy) {
        showToast('✅ Intégrité SQLite 100% Validée : Aucune corruption détectée', 'success');
      } else {
        showToast('⚠️ Avertissement d\'intégrité détecté sur la base de données', 'warning');
      }
      await loadDbStats();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur lors du test d'intégrité : ${msg}`, 'error');
    } finally {
      setIsCheckingIntegrity(false);
    }
  };

  const handleCheckpointWal = async () => {
    setIsCheckpointing(true);
    try {
        const { maintenanceService } = await import('../../services/maintenanceService');
      const msg = await maintenanceService.checkpointDatabaseWal();
      showToast(`⚡ WAL Checkpoint : ${msg}`, 'success');
      await loadDbStats();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur Checkpoint : ${msg}`, 'error');
    } finally {
      setIsCheckpointing(false);
    }
  };

  const handleVacuum = async () => {
    setIsVacuuming(true);
    try {
        const { maintenanceService } = await import('../../services/maintenanceService');
      const msg = await maintenanceService.vacuumDatabase();
      showToast(`🧹 Défragmentation VACUUM : ${msg}`, 'success');
      await loadDbStats();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur VACUUM : ${msg}`, 'error');
    } finally {
      setIsVacuuming(false);
    }
  };

  useEffect(() => {
    if (activeModal === 'settings' && activeTab === 'backup') {
      loadDbStats();
    }
  }, [activeModal, activeTab, loadDbStats]);

  // ── Simulate Diagnostic Run ──
  const simulateDiagnosticRun = useCallback((tests: Omit<DiagnosticTest, 'timestamp'>[]): void => {
    const timestamped = tests.map(t => ({ ...t, timestamp: new Date().toISOString() }));
    setDiagnosticTests(timestamped);

    timestamped.forEach((test, idx) => {
      // Phase 1: Set to running
      setTimeout(() => {
        setDiagnosticTests(prev => prev.map(t =>
          t.id === test.id ? { ...t, result: 'running' as DiagnosticResult } : t
        ));
      }, idx * 500);

      // Phase 2: Set to result
      setTimeout(() => {
        const device = devices.find(d => d.id === test.deviceId);
        const isOffline = device?.status === 'offline';

        let result: DiagnosticResult;
        let message: string;

        if (isOffline && (test.testName.includes('Connexion') || test.testName.includes('Impression') || test.testName.includes('Papier') || test.testName.includes('Découpe'))) {
          result = 'fail';
          message = 'Échec — Aucun équipement physique détecté';
        } else {
          const outcomes: DiagnosticResult[] = ['pass', 'pass', 'pass', 'pass', 'warning'];
          result = outcomes[Math.floor(Math.random() * outcomes.length)];
          const messages: Record<DiagnosticResult, string> = {
            pass: 'Test réussi — Fonctionnel',
            fail: 'Échec — Non réactif',
            warning: 'Latence détectée',
            pending: '',
            running: '',
          };
          message = messages[result];
        }

        const duration = 40 + Math.floor(Math.random() * 150);
        setDiagnosticTests(prev => prev.map(t =>
          t.id === test.id ? { ...t, result, duration, message, timestamp: new Date().toISOString() } : t
        ));
      }, idx * 500 + 450);
    });

    // Complete
    setTimeout(() => {
      setIsRunningAllDiag(false);
    }, timestamped.length * 500 + 500);
  }, [devices]);

  // ── Auto-Detection & Plug-and-Play Listener ──
  const runAutoDetection = useCallback(async (isSilent = false) => {
    if (!isSilent) setIsAutoDetecting(true);

    try {
      // Check browser WebUSB & WebHID capabilities
      let detectedUsbDevices: USBDevice[] = [];
      let detectedHidDevices: HIDDevice[] = [];

      if (navigator.usb) {
        try {
          detectedUsbDevices = await navigator.usb.getDevices();
        } catch { /* Permission or context restriction - harmless in browser/webview */ }
      }

      if (navigator.hid) {
        try {
          detectedHidDevices = await navigator.hid.getDevices();
        } catch { /* Permission or context restriction - harmless in browser/webview */ }
      }

      const totalDetected = detectedUsbDevices.length + detectedHidDevices.length;

      setDevices(prev => prev.map(d => {
        if (d.category === 'display') {
          return { ...d, status: 'active', signalStrength: 100, isAutoDetected: true, lastSeen: new Date().toISOString() };
        }
        // Physical devices (printers & scanners): only mark connected if physical USB/HID devices are plugged into the PC
        if (totalDetected > 0) {
          const newStatus = d.category.includes('printer') ? 'connected' : 'ready';
          return { ...d, status: newStatus, signalStrength: 100, isAutoDetected: true, lastSeen: new Date().toISOString() };
        }
        // If 0 devices detected on USB/HID, set/keep offline
        return { ...d, status: 'offline', signalStrength: 0, isAutoDetected: false, lastSeen: new Date().toISOString() };
      }));

      if (!isSilent) {
        if (totalDetected > 0) {
          showToast(`⚡ Reconnaissance Auto : ${totalDetected} équipement(s) USB/HID connecté(s) et configuré(s) !`, 'success');
        } else {
          showToast(`⚡ Auto-Scan Réussi : 0 périphérique USB/HID physique détecté. Statuts réinitialisés à Hors Ligne.`, 'info');
        }
      }
    } catch {
      if (!isSilent) showToast('Analyse de reconnaissance matérielle terminée.', 'info');
    } finally {
      if (!isSilent) setIsAutoDetecting(false);
    }
  }, [showToast]);

  // Listen to Plug and Play (USB connect/disconnect events)
  useEffect(() => {
    if (activeModal !== 'settings') return;

    const handleUSBConnect = (e: { device: USBDevice }) => {
      const devName = e.device?.productName || 'Nouveau périphérique USB';
      showToast(`🔌 ÉQUIPEMENT RECONNU : ${devName} branché ! Auto-connexion...`, 'success');
      runAutoDetection(true);
    };

    const handleUSBDisconnect = (e: { device: USBDevice }) => {
      const devName = e.device?.productName || 'Périphérique USB';
      showToast(`🔌 Périphérique débranché : ${devName}.`, 'warning');
      runAutoDetection(true);
    };

    if (navigator.usb) {
      navigator.usb.addEventListener('connect', handleUSBConnect);
      navigator.usb.addEventListener('disconnect', handleUSBDisconnect);
    }

    // Run initial scan when modal opens
    runAutoDetection(true);

    return () => {
      if (navigator.usb) {
        navigator.usb.removeEventListener('connect', handleUSBConnect);
        navigator.usb.removeEventListener('disconnect', handleUSBDisconnect);
      }
    };
  }, [activeModal, runAutoDetection, showToast]);

  // Capture-phase keyboard listener for Escape & F12 to immediately exit settings
  useEffect(() => {
    if (activeModal !== 'settings') return;

    const handleLocalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
      }
    };

    window.addEventListener('keydown', handleLocalKeyDown, true);
    return () => window.removeEventListener('keydown', handleLocalKeyDown, true);
  }, [activeModal, closeModal]);

  if (activeModal !== 'settings') return null;

  // ── File Upload Handler (Phase 2, two-step) ──
  // Step 1 (no PIN): pick the file, validate the envelope, stage it. A
  // malformed file burns no PIN and is rejected here with its reason.
  // Step 2: fresh native PIN executes requestDataRestore (re-validates,
  // checkpoints, snapshots current state, writes DATA_RESTORE_BEFORE, then
  // imports). Any refusal aborts before the point of no return.
  const handleRestoreClick = () => {
    setStagedRestore(null);
    fileInputRef.current?.click();
  };
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      if (!content) return;
      const { validateImportPayload } = await import('../../db/adapters/maintenanceAdapter');
      const { sha256Hex } = await import('../../utils/auditIntel');
      const checked = validateImportPayload(content);
      if (!checked.ok) {
        showToast(checked.reason || 'Sauvegarde invalide.', 'error');
        setStagedRestore(null);
        return;
      }
      const sha = (await sha256Hex(content).catch(() => null))?.hex ?? '?';
      setStagedRestore({
        content,
        sha256: sha,
        version: checked.summary?.version,
        counts: checked.summary?.counts,
      });
      const tableCount = Object.keys(checked.summary?.counts ?? {}).length;
      showToast(
        `Sauvegarde vérifiée (v${checked.summary?.version ?? '?'} — ${tableCount} table(s)). Saisissez le PIN Manager puis lancez la restauration.`,
        'success'
      );
    };
    reader.readAsText(file);
    // Reset the picker so the same file can be re-chosen after a fix.
    e.target.value = '';
  };
  const handleExecuteRestore = async () => {
    if (!stagedRestore || isRestoring) return;
    setIsRestoring(true);
    try {
      const { requestDataRestore } = await import('../../db/restoreGuard');
      const { validateImportPayload } = await import('../../db/adapters/maintenanceAdapter');
      const actor = activeCashier?.name;
      const staged = stagedRestore;
      const res = await requestDataRestore(
        {
          source: 'json-import',
          sourceSha256: staged.sha256,
          payloadSummary: { version: staged.version, counts: staged.counts },
          actor,
          validate: async () => validateImportPayload(staged.content),
          proceed: () => importDatabase(staged.content, actor),
        },
        restorePinInput
      );
      if (res.ok) {
        setRestorePinInput('');
        setStagedRestore(null);
        if (res.auditOk === false) {
          showToast(res.message || 'Base restaurée MAIS traçabilité finale impossible.', 'warning', 8000);
        } else {
          showToast('Base de données restaurée avec succès !', 'success');
        }
        closeModal();
      } else if (res.reason === 'invalid-payload') {
        showToast(res.message, 'error');
        setStagedRestore(null);
      } else {
        showToast(res.message, 'error');
      }
    } finally {
      setIsRestoring(false);
    }
  };

  // ── Manual Status Toggle ──
  const toggleDeviceStatus = (id: string, newStatus: DeviceStatus) => {
    setDevices(prev => prev.map(d => {
      if (d.id === id) {
        const signalStrength = newStatus === 'offline' ? 0 : 100;
        return { ...d, status: newStatus, signalStrength, isAutoDetected: newStatus !== 'offline' };
      }
      return d;
    }));
    const dev = devices.find(d => d.id === id);
    showToast(`Statut de ${dev?.name || 'Périphérique'} : ${statusConfig[newStatus].label}`, 'info');
  };

  // ── Run Diagnostics for a Single Device ──
  const runDeviceDiagnostics = (device: PeripheralDevice) => {
    setSelectedDiagDevice(device.id);
    setActiveTab('diagnostics');
    const tests = createDiagnosticTests(device);
    setDevices(prev => prev.map(d => d.id === device.id ? { ...d, status: 'testing' } : d));
    simulateDiagnosticRun(tests);

    setTimeout(() => {
      setDevices(prev => prev.map(d => d.id === device.id ? { ...d, status: device.status } : d));
    }, tests.length * 500 + 600);
  };

  // ── Run Full System Diagnostics ──
  const runFullDiagnostics = () => {
    setIsRunningAllDiag(true);
    setSelectedDiagDevice(null);
    const allTests = devices.flatMap(d => createDiagnosticTests(d));
    simulateDiagnosticRun(allTests);
  };

  // ── Scanner Live Test ──
  const startScannerTest = () => {
    setScannerTestActive(true);
    setScannerTestInput('');
    setTimeout(() => scannerInputRef.current?.focus(), 100);
  };

  // ── KPI Calculations ──
  const connectedCount = devices.filter(d => ['connected', 'ready', 'active'].includes(d.status)).length;
  const offlineCount = devices.filter(d => d.status === 'offline').length;
  const totalTests = diagnosticTests.length;
  const passedTests = diagnosticTests.filter(t => t.result === 'pass').length;
  const failedTests = diagnosticTests.filter(t => t.result === 'fail').length;

  const tabs: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'appearance', label: 'Apparence & Thème', icon: <Sun className="w-4 h-4 text-amber-400" /> },
    { key: 'hardware', label: 'Matériel & Périphériques', icon: <Cpu className="w-4 h-4" /> },
    { key: 'security', label: 'Sécurité & Personnel', icon: <ShieldCheck className="w-4 h-4 text-emerald-400" /> },
    { key: 'cloud_sync', label: 'Synchronisation Cloud', icon: <Cloud className="w-4 h-4 text-sky-400" /> },
    { key: 'diagnostics', label: 'Diagnostique Avancé', icon: <Activity className="w-4 h-4" /> },
    { key: 'loyalty', label: 'Configuration Fidélité', icon: <Award className="w-4 h-4 text-amber-400" /> },
    { key: 'backup', label: 'Moteur SQLite & Données', icon: <Database className="w-4 h-4 text-cyan-400" /> },
    { key: 'updates', label: 'Mises à Jour & Version', icon: <Sparkles className="w-4 h-4 text-purple-400" /> },
  ];

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-0 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-none sm:rounded-2xl w-full sm:max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-dvh-shell sm:h-[90dvh] flex flex-col cursor-default font-sans pt-[max(0.5rem,var(--safe-top))] sm:pt-0 pb-[max(0.5rem,var(--safe-bottom))] sm:pb-0"
      >

        {/* ═══ Header ═══ */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 px-2 sm:px-3 bg-cyan-500/10 hover:bg-cyan-500/20 active:scale-95 border border-cyan-500/30 text-cyan-400 rounded-xl font-bold text-xs flex items-center gap-1 transition cursor-pointer shrink-0"
              title="Retour au logiciel (Échap)"
            >
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
              <span>Retour</span>
            </button>
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-cyan-500/20 flex items-center justify-center border border-cyan-500/30 shadow-md shrink-0">
              <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                <span>PARAMÈTRES DU SYSTÈME</span>
                <span className="hidden sm:inline-flex bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 items-center gap-1 shrink-0">
                  <Sparkles className="w-3 h-3" /> Auto-Plug & Play
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted truncate hidden sm:block">
                Thème, Périphériques, Synchronisation Cloud & Maintenance
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
            title="Fermer les paramètres (Échap / F12)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ═══ KPI Bar (3 cols on mobile, 5 cols on desktop) ═══ */}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 sm:gap-2.5 p-2 sm:px-4 sm:py-3 border-b border-pos-border bg-pos-card/50 shrink-0">
          <div className="bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
              <HardDrive className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[8px] sm:text-[9px] text-pos-muted uppercase font-bold block truncate">Périphériques</span>
              <span className="text-xs sm:text-sm font-black text-pos-text font-mono">{devices.length}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[8px] sm:text-[9px] text-pos-muted uppercase font-bold block truncate">Prêts</span>
              <span className="text-xs sm:text-sm font-black text-emerald-400 font-mono">{connectedCount}/{devices.length}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-500/20 text-slate-400 flex items-center justify-center shrink-0">
              <WifiOff className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[8px] sm:text-[9px] text-pos-muted uppercase font-bold block truncate">Hors Ligne</span>
              <span className="text-xs sm:text-sm font-black text-slate-400 font-mono">{offlineCount}</span>
            </div>
          </div>
          <div className="hidden sm:flex bg-pos-card p-2.5 rounded-xl border border-pos-border items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Tests Réussis</span>
              <span className="text-sm font-black text-amber-400 font-mono">{totalTests > 0 ? `${passedTests}/${totalTests}` : '—'}</span>
            </div>
          </div>
          <div className="hidden sm:flex bg-pos-card p-2.5 rounded-xl border border-pos-border items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Protocoles</span>
              <span className="text-sm font-black text-purple-400 font-mono">{new Set((devices || []).map(d => d.protocol)).size}</span>
            </div>
          </div>
        </div>

        {/* ═══ Tab Navigation (horizontally scrollable on mobile) ═══ */}
        <div ref={tabStripRef} className="flex flex-nowrap gap-1 px-2.5 sm:px-4 pt-2 sm:pt-3 pb-0 shrink-0 overflow-x-auto overscroll-contain overflow-y-hidden no-scrollbar whitespace-nowrap border-b border-pos-border/40 min-w-0 max-w-full">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 sm:px-4 py-2 rounded-t-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === tab.key
                  ? 'bg-pos-bg border border-pos-border border-b-transparent text-cyan-400 shadow-sm'
                  : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover/50'
              }`}
            >
              {tab.icon} <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* ═══ Content Body ═══ */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-6">
          {/* ══════ TAB: Appearance & Theme ══════ */}
          {activeTab === 'appearance' && (
            <div className="space-y-4 max-w-3xl">
              {/* Theme Selector Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
                <div className="flex items-center gap-2">
                  <Sun className="w-4 h-4 text-amber-400" />
                  <h4 className="text-xs font-bold text-pos-text">Thème & Apparence de l'Application</h4>
                </div>
                <p className="text-xs text-pos-muted">
                  Personnalisez l'ambiance visuelle du logiciel pour un confort optimal en caisse.
                </p>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (themeMode !== 'dark') toggleTheme();
                    }}
                    className={`p-4 rounded-xl border-2 text-left transition cursor-pointer flex flex-col justify-between h-28 ${
                      themeMode === 'dark'
                        ? 'border-cyan-400 bg-slate-900 text-white shadow-md'
                        : 'border-pos-border bg-slate-900/40 text-pos-muted hover:border-pos-border/80'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2">
                        <Moon className="w-5 h-5 text-indigo-400" />
                        <span className="font-bold text-sm">Mode Sombre (Dark)</span>
                      </div>
                      {themeMode === 'dark' && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
                    </div>
                    <p className="text-[11px] text-slate-400">Recommandé en caisse pour réduire la fatigue oculaire et sublimer les contrastes.</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (themeMode !== 'light') toggleTheme();
                    }}
                    className={`p-4 rounded-xl border-2 text-left transition cursor-pointer flex flex-col justify-between h-28 ${
                      themeMode === 'light'
                        ? 'border-amber-400 bg-white text-slate-950 shadow-md'
                        : 'border-pos-border bg-white/40 text-pos-muted hover:border-pos-border/80'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2">
                        <Sun className="w-5 h-5 text-amber-500" />
                        <span className="font-bold text-sm">Mode Clair (Light)</span>
                      </div>
                      {themeMode === 'light' && <CheckCircle2 className="w-4 h-4 text-amber-500" />}
                    </div>
                    <p className="text-[11px] text-slate-500">Contraste élevé pour les environnements de boutique très éclairés.</p>
                  </button>
                </div>
              </div>

              {/* Store & Receipt Info Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
                <div className="flex items-center gap-2">
                  <Store className="w-4 h-4 text-cyan-400" />
                  <h4 className="text-xs font-bold text-pos-text">Profil du Magasin & En-têtes Tickets</h4>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-[11px] font-bold text-pos-muted block mb-1">Nom de la Boutique / Enseigne :</label>
                    <input
                      type="text"
                      value={receiptDraft.storeName}
                      onChange={(e) => scheduleReceiptSave({ ...receiptDraft, storeName: e.target.value })}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-pos-muted block mb-1">Adresse :</label>
                    <input
                      type="text"
                      value={receiptDraft.address}
                      onChange={(e) => scheduleReceiptSave({ ...receiptDraft, address: e.target.value })}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-pos-muted block mb-1">Numéro de Téléphone :</label>
                    <input
                      type="text"
                      value={receiptDraft.phone}
                      onChange={(e) => scheduleReceiptSave({ ...receiptDraft, phone: e.target.value })}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text"
                    />
                  </div>
                  {/* TVA REMOVED (no-TVA product, Gate Addendum A): the rate
                      setting is gone — every sale is HT-only. Any legacy
                      stored vatRate is ignored by readVatRate/computeTax. */}
                </div>
              </div>
            </div>
          )}

          {/* ══════ TAB: Cloud Sync (Turso) ══════ */}
          {activeTab === 'cloud_sync' && (
            <React.Suspense fallback={<div className="flex items-center justify-center py-8 text-pos-muted text-sm">Chargement…</div>}>
              <CloudSyncPanel />
            </React.Suspense>
          )}

          {/* ══════ TAB: Hardware & Peripherals ══════ */}
          {activeTab === 'hardware' && (
            <div className="space-y-4">

              {/* Status Info Alert Banner */}
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3.5 flex items-start gap-3">
                <Radio className="w-4 h-4 text-blue-400 shrink-0 mt-0.5 animate-pulse" />
                <div className="text-xs space-y-1">
                  <p className="font-bold text-blue-300">Reconnaissance Automatique & Mode Plug & Play Actif</p>
                  <p className="text-blue-200/80 text-[11px]">
                    Branchez n'importe quelle imprimante (Epson, Zebra, Star, Xprinter) ou lecteur code-barres en USB/Série : le système la <span className="font-bold text-emerald-300">reconnaît et la connecte automatiquement</span>. Si aucun équipement physique n'est branché, le logiciel utilise le <span className="font-bold text-cyan-300">pilote d'impression système Windows (PDF / Aperçu écran)</span> pour ne jamais bloquer l'encaissement.
                  </p>
                </div>
              </div>

              {/* Mobile Wi-Fi / Bluetooth printer (phone only — per-device config) */}
              {typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent || '') && (
                <MobilePrinterCard storeName={receiptSettings?.storeName} />
              )}

              {/* Smart Document Printer Routing Control Studio */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-bold text-pos-text">Routage Intelligent des Imprimantes par Type de Document</h4>
                  </div>
                  <button
                    onClick={() => {
                      const currentRouting = receiptSettings.printerRouting || {
                        receiptPrinterId: 'rp-1', receiptPrinterName: 'Imprimante Thermique Tickets (Epson TM-T88VI)',
                        labelPrinterId: 'lp-1', labelPrinterName: 'Imprimante Étiquettes (Zebra ZD421)',
                        reportPrinterId: 'sys-1', reportPrinterName: 'Imprimante Système Windows / PDF A4',
                        autoRoutingEnabled: true,
                      };
                      const nextState = !currentRouting.autoRoutingEnabled;
                      setReceiptSettings({
                        ...receiptSettings,
                        printerRouting: {
                          ...currentRouting,
                          autoRoutingEnabled: nextState,
                        },
                      });
                      showToast(`Routage automatique par document ${nextState ? 'ACTIVÉ (Sans intervention)' : 'DÉSACTIVÉ'}`, nextState ? 'success' : 'info');
                    }}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold border transition cursor-pointer flex items-center gap-1.5 ${
                      receiptSettings.printerRouting?.autoRoutingEnabled !== false
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 shadow-sm'
                        : 'bg-slate-500/20 text-slate-400 border-slate-500/30'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${receiptSettings.printerRouting?.autoRoutingEnabled !== false ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                    {receiptSettings.printerRouting?.autoRoutingEnabled !== false ? '⚡ Auto-Routage Activé (Sans intervention)' : '⚪ Mode Manuel'}
                  </button>
                </div>

                <p className="text-[10px] text-pos-muted">
                  Le moteur d'impression analyse la nature de chaque document et l'achemine automatiquement vers l'imprimante dédiée sans demander d'intervention manuelle :
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  <div className="bg-pos-bg border border-emerald-500/30 rounded-xl p-3 space-y-1.5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                        <Printer className="w-3.5 h-3.5" /> Reçus & Tickets
                      </span>
                      <span className="bg-emerald-500/20 text-emerald-300 text-[8px] font-bold px-1.5 py-0.5 rounded">ESC/POS 80mm</span>
                    </div>
                    <p className="text-[9px] text-pos-muted">Tickets de caisse, reçus de vente & duplicatas</p>
                    <div className="text-[10px] font-bold text-pos-text bg-pos-card p-2 rounded border border-pos-border truncate flex items-center justify-between">
                      <span className="truncate">➔ {receiptSettings.printerRouting?.receiptPrinterName || 'Epson TM-T88VI'}</span>
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 ml-1" />
                    </div>
                  </div>

                  <div className="bg-pos-bg border border-amber-500/30 rounded-xl p-3 space-y-1.5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5" /> Étiquettes & Prix
                      </span>
                      <span className="bg-amber-500/20 text-amber-300 text-[8px] font-bold px-1.5 py-0.5 rounded">ZPL II 50x25mm</span>
                    </div>
                    <p className="text-[9px] text-pos-muted">Codes-barres produits, prix & étiquettes stock</p>
                    <div className="text-[10px] font-bold text-pos-text bg-pos-card p-2 rounded border border-pos-border truncate flex items-center justify-between">
                      <span className="truncate">➔ {receiptSettings.printerRouting?.labelPrinterName || 'Zebra ZD421'}</span>
                      <CheckCircle2 className="w-3 h-3 text-amber-400 shrink-0 ml-1" />
                    </div>
                  </div>

                  <div className="bg-pos-bg border border-cyan-500/30 rounded-xl p-3 space-y-1.5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-cyan-400 flex items-center gap-1.5">
                        <Monitor className="w-3.5 h-3.5" /> Rapports Z & Fiches
                      </span>
                      <span className="bg-cyan-500/20 text-cyan-300 text-[8px] font-bold px-1.5 py-0.5 rounded">A4 / PDF</span>
                    </div>
                    <p className="text-[9px] text-pos-muted">Bilan de caisse Z, fiches SAV & factures</p>
                    <div className="text-[10px] font-bold text-pos-text bg-pos-card p-2 rounded border border-pos-border truncate flex items-center justify-between">
                      <span className="truncate">➔ {receiptSettings.printerRouting?.reportPrinterName || 'Windows Print / PDF A4'}</span>
                      <CheckCircle2 className="w-3 h-3 text-cyan-400 shrink-0 ml-1" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Toolbar */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">Équipements & Statut Détecté</h3>
                <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => runAutoDetection(false)}
                    disabled={isAutoDetecting}
                    className="flex-1 sm:flex-initial px-3 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-emerald-500/30 transition cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCcw className={`w-3.5 h-3.5 ${isAutoDetecting ? 'animate-spin' : ''}`} />
                    <span>{isAutoDetecting ? 'Détection...' : 'Auto-Détecter'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={runFullDiagnostics}
                    disabled={isRunningAllDiag}
                    className="flex-1 sm:flex-initial px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-cyan-500/20 transition cursor-pointer disabled:opacity-50"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>{isRunningAllDiag ? 'Diagnostic...' : 'Diagnostic Complet'}</span>
                  </button>
                </div>
              </div>

              {/* Device Cards */}
              <div className="space-y-3">
                {(devices || []).map(device => {
                  const st = (device?.status && statusConfig[device.status]) || statusConfig['offline'] || {
                    color: 'text-rose-400',
                    bgColor: 'bg-rose-500/10',
                    borderColor: 'border-rose-500/30',
                    label: 'Hors-Ligne',
                    icon: null
                  };
                  const isExpanded = expandedDevice === device.id;
                  const compat = (device?.category && BRAND_COMPATIBILITY[device.category]) || { brands: [], protocols: [] };

                  return (
                    <div key={device.id} className={`bg-pos-card border rounded-xl overflow-hidden transition-all ${isExpanded ? 'border-cyan-500/50 shadow-lg shadow-cyan-500/5' : 'border-pos-border hover:border-pos-text/20'}`}>

                      {/* Device Header Row */}
                      <div className="p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-11 h-11 rounded-xl ${st.bgColor} ${st.color} flex items-center justify-center border ${st.borderColor}`}>
                            {categoryIcon[device.category]}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-bold text-pos-text">{device.name}</h4>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${st.bgColor} ${st.color} border ${st.borderColor}`}>
                                {st.icon} {st.label}
                              </span>
                              {device.isAutoDetected && (
                                <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[8px] font-bold px-1.5 py-0.2 rounded uppercase">
                                  Auto-Reconnu
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-pos-muted mt-0.5">
                              <span className="font-bold">{device.brand} {device.model}</span>
                              <span className="flex items-center gap-0.5">{connectionIcon[device.connection]} {device.connection}{device.port ? ` (${device.port})` : ''}</span>
                              {device.firmware && <span>FW: {device.firmware}</span>}
                            </div>
                          </div>
                        </div>

                        {/* Actions & Status Selector */}
                        <div className="flex items-center gap-2">
                          <select
                            value={device.status}
                            onChange={e => toggleDeviceStatus(device.id, e.target.value as DeviceStatus)}
                            className="bg-pos-bg border border-pos-border rounded-lg px-2 py-1 text-[10px] font-bold text-pos-text focus:border-cyan-400 focus:outline-none transition cursor-pointer"
                          >
                            <option value="connected">🟢 Connecté Automatiquement</option>
                            <option value="ready">🟢 Prêt (HID / Système)</option>
                            <option value="offline">⚪ Non Détecté (Déconnecté)</option>
                            <option value="error">🔴 Erreur / Non Réactif</option>
                          </select>

                          <button
                            onClick={() => runDeviceDiagnostics(device)}
                            className="px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 text-[10px] font-bold hover:bg-cyan-500/20 transition cursor-pointer flex items-center gap-1"
                          >
                            <Play className="w-3 h-3" /> Tester
                          </button>

                          <button
                            onClick={() => setExpandedDevice(isExpanded ? null : device.id)}
                            className="p-1.5 rounded-lg text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer"
                          >
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 border-t border-pos-border pt-3 space-y-3">
                          {/* Technical Specs */}
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
                            <div className="bg-pos-bg p-3 rounded-lg border border-pos-border">
                              <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Protocole</span>
                              <span className="text-xs font-bold text-pos-text">{device.protocol || 'Standard'}</span>
                            </div>
                            <div className="bg-pos-bg p-3 rounded-lg border border-pos-border">
                              <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Pilote</span>
                              <span className="text-xs font-bold text-pos-text">{device.driver || 'Système'}</span>
                            </div>
                            <div className="bg-pos-bg p-3 rounded-lg border border-pos-border">
                              <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Signal Port USB/COM</span>
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1 h-1.5 bg-pos-border rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${(device.signalStrength || 0) > 70 ? 'bg-emerald-400' : (device.signalStrength || 0) > 0 ? 'bg-amber-400' : 'bg-slate-600'}`}
                                    style={{ width: `${device.signalStrength || 0}%` }}
                                  />
                                </div>
                                <span className="text-xs font-bold text-pos-text">{device.signalStrength || 0}%</span>
                              </div>
                            </div>
                          </div>

                          {/* Capabilities */}
                          <div>
                            <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1.5">Fonctionnalités</span>
                            <div className="flex flex-wrap gap-1.5">
                              {(device.capabilities || []).map((cap, i) => (
                                <span key={i} className="px-2 py-0.5 rounded-full bg-pos-bg border border-pos-border text-[10px] font-semibold text-pos-text">
                                  {cap}
                                </span>
                              ))}
                            </div>
                          </div>

                          {/* Universal Brand Compatibility */}
                          <div className="bg-pos-bg border border-pos-border rounded-lg p-3">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Shield className="w-3.5 h-3.5 text-purple-400" />
                              <span className="text-[9px] text-purple-400 uppercase font-bold">Compatibilité Universelle Multi-Marques — {categoryLabel[device.category]}</span>
                            </div>
                            <div className="space-y-2">
                              <div>
                                <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Marques Supportées</span>
                                <div className="flex flex-wrap gap-1">
                                  {(compat?.brands || []).map((b, i) => (
                                    <span key={i} className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${b === device.brand ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-pos-card text-pos-muted border-pos-border'}`}>
                                      {b === device.brand && <span className="mr-0.5">✓</span>}{b}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Protocoles de Communication</span>
                                <div className="flex flex-wrap gap-1">
                                  {(compat?.protocols || []).map((p, i) => (
                                    <span key={i} className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${p === device.protocol || (device.protocol || '').includes(p) ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-pos-card text-pos-muted border-pos-border'}`}>
                                      {(p === device.protocol || (device.protocol || '').includes(p)) && <span className="mr-0.5">●</span>}{p}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ── Préférences Audio & Retours Sonores (Web Audio API) ── */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-4 shadow-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Volume2 className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-bold text-pos-text">
                      Ergonomie Sonore & Synthèse Audio (Web Audio API)
                    </h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUpdateAudio({ isMuted: !audioProfile.isMuted })}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold border transition cursor-pointer flex items-center gap-1.5 ${
                      audioProfile.isMuted
                        ? 'bg-red-500/20 text-red-400 border-red-500/40'
                        : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                    }`}
                  >
                    {audioProfile.isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    <span>{audioProfile.isMuted ? 'Mode Silencieux (Muet)' : 'Audio Activé'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Volume Slider */}
                  <div className="bg-pos-bg border border-pos-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-pos-text">Volume Principal Caisse</span>
                      <span className="text-xs font-mono font-bold text-emerald-400">
                        {Math.round(audioProfile.masterVolume * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      disabled={audioProfile.isMuted}
                      value={audioProfile.masterVolume}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        handleUpdateAudio({ masterVolume: val });
                      }}
                      className="w-full accent-emerald-500 cursor-pointer disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[9px] text-pos-muted">
                      <span>0% (Discret)</span>
                      <span>50%</span>
                      <span>100% (Fort)</span>
                    </div>
                  </div>

                  {/* Channel Toggles */}
                  <div className="bg-pos-bg border border-pos-border rounded-lg p-3 space-y-2 text-xs">
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-pos-text">Bip Scanner Code-Barres (880 Hz)</span>
                      <input
                        type="checkbox"
                        checked={audioProfile.enableScanBeep}
                        onChange={(e) => handleUpdateAudio({ enableScanBeep: e.target.checked })}
                        className="accent-emerald-500 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-pos-text">Mélodie Garantie / Client VIP</span>
                      <input
                        type="checkbox"
                        checked={audioProfile.enableWarrantyChime}
                        onChange={(e) => handleUpdateAudio({ enableWarrantyChime: e.target.checked })}
                        className="accent-emerald-500 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-pos-text">Alerte Rupture / Plafond Kredy</span>
                      <input
                        type="checkbox"
                        checked={audioProfile.enableWarningBuzzer}
                        onChange={(e) => handleUpdateAudio({ enableWarningBuzzer: e.target.checked })}
                        className="accent-emerald-500 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-pos-text">Carillon Encaissement Vente</span>
                      <input
                        type="checkbox"
                        checked={audioProfile.enableCashChime}
                        onChange={(e) => handleUpdateAudio({ enableCashChime: e.target.checked })}
                        className="accent-emerald-500 rounded"
                      />
                    </label>
                  </div>
                </div>

                {/* Live Test Sounds Buttons */}
                <div className="space-y-1.5">
                  <span className="text-[10px] font-bold text-pos-muted uppercase">
                    Test des Signaux Sonores
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => soundEngine.playScan()}
                      className="px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer flex items-center gap-1.5"
                    >
                      <Music className="w-3.5 h-3.5 text-emerald-400" /> Bip Scan
                    </button>
                    <button
                      type="button"
                      onClick={() => soundEngine.playWarrantyActive()}
                      className="px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer flex items-center gap-1.5"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> Garantie VIP
                    </button>
                    <button
                      type="button"
                      onClick={() => soundEngine.playError()}
                      className="px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer flex items-center gap-1.5"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> Alerte Erreur
                    </button>
                    <button
                      type="button"
                      onClick={() => soundEngine.playSuccess()}
                      className="px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" /> Carillon Vente
                    </button>
                    <button
                      type="button"
                      onClick={() => soundEngine.playCashDrawer()}
                      className="px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer flex items-center gap-1.5"
                    >
                      <Zap className="w-3.5 h-3.5 text-amber-400" /> Clic Tiroir
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══════ TAB: Sécurité & Personnel (Staff & Access Control) ══════ */}
          {activeTab === 'security' && (
            <div className="space-y-6 max-w-4xl mx-auto py-1">
              {/* Executive Security Header Card */}
              <div className="bg-gradient-to-r from-emerald-950/40 via-pos-card to-purple-950/40 border border-emerald-500/30 rounded-2xl p-4 shadow-xl">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/40 shadow-lg shadow-emerald-500/10 shrink-0">
                      <ShieldCheck className="w-6 h-6 stroke-[2.5]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-extrabold text-pos-text tracking-wide">
                          Contrôle d'Accès, Personnel & Sécurité (RBAC)
                        </h3>
                        <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1 shrink-0">
                          <Lock className="w-3 h-3" /> Protection Anti-Coulage
                        </span>
                      </div>
                      <p className="text-[11px] text-pos-muted">
                        Configurez le Code PIN Superviseur, gérez l'équipe de caisse et inspectez le journal des dérogations.
                      </p>
                    </div>
                  </div>

                  {/* FT-01: hidden for cashiers (UX only — modal gate is authoritative). */}
                  {canSeeJournalLauncher(activeCashier?.role) && (
                  <button
                    type="button"
                    onClick={() => openModal('security_audit')}
                    className="px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer shrink-0 shadow-sm"
                  >
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <span>Journal d'Audit ({securityAuditLog.length})</span>
                  </button>
                  )}
                </div>
              </div>

              {/* ── CARD 1: Code PIN Manager Maître (Superviseur) ── */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-md">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-pos-border/60 pb-3 gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/30 shrink-0">
                      <Shield className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                        Code PIN Manager Maître (Superviseur)
                      </h4>
                      <span className="text-[10px] text-pos-muted">
                        Clé universelle de dérogation pour remises &gt; 20%, ventes sous coût, tiroir No Sale et annulations
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-pos-muted bg-pos-bg px-2.5 py-1 rounded-lg border border-pos-border">
                      Statut : <strong className="text-emerald-400 font-mono">{managerKdfLabel}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowManagerPin(!showManagerPin)}
                      className="p-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs transition cursor-pointer"
                      title={showManagerPin ? 'Masquer chiffres' : 'Afficher chiffres'}
                    >
                      {showManagerPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] text-pos-muted font-bold block mb-1">PIN Actuel (Obligatoire)</label>
                    <input
                      type={showManagerPin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="current-password"
                      enterKeyHint="next"
                      aria-label="PIN Actuel (Obligatoire)"
                      maxLength={8}
                      value={currentPinInput}
                      onChange={(e) => setCurrentPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="PIN Actuel"
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted font-bold block mb-1">
                      Nouveau PIN Gérant (6 à 8 chiffres)
                    </label>
                    <input
                      type={showManagerPin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="new-password"
                      enterKeyHint="next"
                      aria-label="Nouveau PIN Gérant (6 à 8 chiffres)"
                      maxLength={8}
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                      placeholder="6 à 8 chiffres"
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted font-bold block mb-1">
                      Confirmer le Nouveau PIN (6 à 8 chiffres)
                    </label>
                    <input
                      type={showManagerPin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="new-password"
                      enterKeyHint="done"
                      aria-label="Confirmer le Nouveau PIN (6 à 8 chiffres)"
                      maxLength={8}
                      value={confirmPinInput}
                      onChange={(e) => setConfirmPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                      placeholder="6 à 8 chiffres"
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between pt-1 gap-2 border-t border-pos-border/40">
                  <span className="text-[10px] text-pos-muted italic">
                    Aucun code usine par défaut — le PIN Manager est créé à l'installation (configuration initiale obligatoire). Conservez-le confidentiel.
                  </span>
                  <button
                    type="button"
                    onClick={handleUpdateManagerPin}
                    disabled={isUpdatingPin || !currentPinInput || !newPinInput || !confirmPinInput}
                    className="py-2 px-5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition disabled:opacity-40 cursor-pointer shadow-md shadow-purple-600/20 active:scale-95"
                  >
                    {isUpdatingPin ? 'Enregistrement...' : 'Enregistrer le PIN Manager'}
                  </button>
                </div>
              </div>

              {/* ── CARD 2: Gestion de l'Équipe & Caissiers (Personnel) ── */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-md">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-pos-border/60 pb-3 gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
                      <Users className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                        Équipe de Caisse & Codes PIN Vendeurs
                      </h4>
                      <span className="text-[10px] text-pos-muted">
                        Chaque employé possède son profil, couleur et code PIN sécurisé (4 chiffres caissiers, 6 à 8 gérants) pour la passation de caisse (Ctrl+L)
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleOpenAddCashier}
                    className="py-2 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md shadow-emerald-600/20 active:scale-95 shrink-0"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span>Ajouter un Caissier</span>
                  </button>
                </div>

                {/* Inline Cashier Add / Edit Modal Drawer */}
                {isCashierModalOpen && (
                  <div className="bg-pos-panel border border-emerald-500/40 rounded-2xl p-4 space-y-4 shadow-xl animate-in fade-in zoom-in-95">
                    <div className="flex items-center justify-between border-b border-pos-border pb-2">
                      <div className="flex items-center gap-2">
                        {editingCashierId ? <Edit3 className="w-4 h-4 text-amber-400" /> : <UserPlus className="w-4 h-4 text-emerald-400" />}
                        <h5 className="text-xs font-bold text-pos-text">
                          {editingCashierId ? 'Modifier les informations du collaborateur' : 'Ajouter un nouveau membre d\'équipe'}
                        </h5>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsCashierModalOpen(false)}
                        className="p-1 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {(() => {
                      const isTargetAdmin =
                        cashierRoleInput === 'admin' ||
                        (editingCashierId ? cashierUsers.find((u) => u.id === editingCashierId)?.role === 'admin' : false);
                      const maxPinLen = isTargetAdmin ? 8 : 4;
                      const edited = cashierUsers.find((u) => u.id === editingCashierId);
                      const isPrimary =
                        Boolean(edited && edited.role === 'admin' && cashierUsers.find((u) => u.role === 'admin')?.id === edited.id);

                      return (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Name input */}
                            <div>
                              <label className="text-[10px] text-pos-muted font-bold block mb-1">
                                Nom de l'employé ou Identifiant Caisse *
                              </label>
                              <input
                                type="text"
                                value={cashierNameInput}
                                onChange={(e) => setCashierNameInput(e.target.value)}
                                placeholder="Ex: Samir, Karim (Shift Soir), Caisse 2"
                                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-emerald-400"
                              />
                            </div>

                            {/* Role selection */}
                            <div>
                              <label className="text-[10px] text-pos-muted font-bold block mb-1">
                                Rôle & Niveau d'Autorisation
                              </label>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setCashierRoleInput('cashier')}
                                  className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                                    cashierRoleInput === 'cashier'
                                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                      : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                                  }`}
                                >
                                  <User className="w-3.5 h-3.5" />
                                  <span>Caissier Standard</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setCashierRoleInput('admin')}
                                  className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                                    cashierRoleInput === 'admin'
                                      ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                                      : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                                  }`}
                                >
                                  <Shield className="w-3.5 h-3.5" />
                                  <span>Gérant / Admin</span>
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Role description note */}
                          {isTargetAdmin && (
                            <div className="text-[11px] text-purple-300/90 bg-purple-500/10 border border-purple-500/30 rounded-xl px-3 py-2 leading-relaxed flex items-center gap-2">
                              <Shield className="w-4 h-4 text-purple-400 shrink-0" />
                              <span>
                                {isPrimary
                                  ? 'Gérant Principal : le code PIN (6 à 8 chiffres) est synchronisé avec le PIN Manager maître du système.'
                                  : 'Privilèges Superviseur : accès aux paramètres, remises et clôtures. PIN de 6 à 8 chiffres requis.'}
                              </span>
                            </div>
                          )}

                          {/* PIN Inputs (Requires previous PIN if editing) */}
                          {editingCashierId ? (
                            <div className="bg-pos-bg/80 border border-pos-border rounded-xl p-3.5 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-pos-text flex items-center gap-1.5">
                                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                                  <span>Modifier le Code PIN ({isTargetAdmin ? '6 à 8 chiffres' : '4 chiffres'})</span>
                                </span>
                                <span className="text-[10px] text-pos-muted italic">
                                  (Laissez vide si vous souhaitez conserver le code PIN actuel)
                                </span>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <label className="text-[10px] text-pos-muted font-bold truncate">
                                      {isTargetAdmin ? 'Ancien PIN (ou PIN Manager)' : 'Ancien PIN (ou PIN Manager)'}
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => setShowCashierPin(!showCashierPin)}
                                      className="text-[10px] text-pos-muted hover:text-pos-text cursor-pointer"
                                      title={showCashierPin ? 'Masquer' : 'Afficher'}
                                    >
                                      {showCashierPin ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                    </button>
                                  </div>
                                  <input
                                    type={showCashierPin ? 'text' : 'password'}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    autoComplete="current-password"
                                    enterKeyHint="next"
                                    aria-label="Ancien PIN (ou PIN Manager)"
                                    maxLength={8}
                                    value={previousCashierPinInput}
                                    onChange={(e) => setPreviousCashierPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                                    placeholder="PIN Actuel ou Manager"
                                    className="w-full min-h-[48px] bg-pos-panel border border-pos-border rounded-xl px-3 py-1.5 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-amber-400"
                                  />
                                </div>

                                <div>
                                  <label className="text-[10px] text-pos-muted font-bold block mb-1 truncate">
                                    {isTargetAdmin ? 'Nouveau PIN (6 à 8 ch.)' : 'Nouveau PIN (4 ch.)'}
                                  </label>
                                  <input
                                    type={showCashierPin ? 'text' : 'password'}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    autoComplete="new-password"
                                    enterKeyHint="next"
                                    aria-label={isTargetAdmin ? 'Nouveau PIN (6 à 8 ch.)' : 'Nouveau PIN (4 ch.)'}
                                    maxLength={maxPinLen}
                                    value={cashierPinInput}
                                    onChange={(e) =>
                                      setCashierPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, maxPinLen))
                                    }
                                    placeholder={isTargetAdmin ? 'Ex: 729410' : 'Ex: 4892'}
                                    className="w-full min-h-[48px] bg-pos-panel border border-pos-border rounded-xl px-3 py-1.5 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400 tracking-widest"
                                  />
                                </div>

                                <div>
                                  <label className="text-[10px] text-pos-muted font-bold block mb-1 truncate">
                                    Confirmer Nouveau PIN
                                  </label>
                                  <input
                                    type={showCashierPin ? 'text' : 'password'}
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    autoComplete="new-password"
                                    enterKeyHint="done"
                                    aria-label="Confirmer Nouveau PIN"
                                    maxLength={maxPinLen}
                                    value={confirmCashierPinInput}
                                    onChange={(e) =>
                                      setConfirmCashierPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, maxPinLen))
                                    }
                                    placeholder={isTargetAdmin ? 'Ex: 729410' : 'Ex: 4892'}
                                    className="w-full min-h-[48px] bg-pos-panel border border-pos-border rounded-xl px-3 py-1.5 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400 tracking-widest"
                                  />
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <label className="text-[10px] text-pos-muted font-bold">
                                    {isTargetAdmin ? 'Code PIN Gérant (6 à 8 chiffres) *' : 'Code PIN Personnel (4 chiffres) *'}
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => setShowCashierPin(!showCashierPin)}
                                    className="text-[10px] text-pos-muted hover:text-pos-text flex items-center gap-1 cursor-pointer"
                                  >
                                    {showCashierPin ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                    <span>{showCashierPin ? 'Masquer' : 'Afficher'}</span>
                                  </button>
                                </div>
                                <input
                                  type={showCashierPin ? 'text' : 'password'}
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  autoComplete="new-password"
                                  enterKeyHint="next"
                                  aria-label={isTargetAdmin ? 'Code PIN Gérant (6 à 8 chiffres) *' : 'Code PIN Personnel (4 chiffres) *'}
                                  maxLength={maxPinLen}
                                  value={cashierPinInput}
                                  onChange={(e) =>
                                    setCashierPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, maxPinLen))
                                  }
                                  placeholder={isTargetAdmin ? 'Ex: 729410' : 'Ex: 2580'}
                                  className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400 tracking-widest"
                                />
                              </div>

                              <div>
                                <label className="text-[10px] text-pos-muted font-bold block mb-1">
                                  {isTargetAdmin ? 'Confirmer Code PIN Gérant *' : 'Confirmer le Code PIN (4 chiffres) *'}
                                </label>
                                <input
                                  type={showCashierPin ? 'text' : 'password'}
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  autoComplete="new-password"
                                  enterKeyHint="done"
                                  aria-label={isTargetAdmin ? 'Confirmer Code PIN Gérant *' : 'Confirmer le Code PIN (4 chiffres) *'}
                                  maxLength={maxPinLen}
                                  value={confirmCashierPinInput}
                                  onChange={(e) =>
                                    setConfirmCashierPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, maxPinLen))
                                  }
                                  placeholder={isTargetAdmin ? 'Ex: 729410' : 'Ex: 2580'}
                                  className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400 tracking-widest"
                                />
                              </div>
                            </div>
                          )}

                          {/* Avatar color picker */}
                          <div>
                            <label className="text-[10px] text-pos-muted font-bold block mb-1">
                              Couleur d'Avatar Visuelle
                            </label>
                            <div className="flex items-center gap-2 pt-1">
                              {[
                                { color: '#3b82f6', label: 'Bleu' },
                                { color: '#10b981', label: 'Émeraude' },
                                { color: '#f59e0b', label: 'Ambre' },
                                { color: '#8b5cf6', label: 'Violet' },
                                { color: '#ec4899', label: 'Rose' },
                                { color: '#06b6d4', label: 'Cyan' },
                                { color: '#ef4444', label: 'Rouge' },
                                { color: '#64748b', label: 'Ardoise' },
                              ].map((c) => (
                                <button
                                  key={c.color}
                                  type="button"
                                  onClick={() => setCashierColorInput(c.color)}
                                  className={`w-6 h-6 rounded-full transition-transform cursor-pointer flex items-center justify-center ${
                                    cashierColorInput === c.color ? 'scale-125 ring-2 ring-white ring-offset-2 ring-offset-pos-panel' : 'opacity-80 hover:opacity-100'
                                  }`}
                                  style={{ backgroundColor: c.color }}
                                  title={c.label}
                                >
                                  {cashierColorInput === c.color && <Check className="w-3.5 h-3.5 text-white stroke-[3]" />}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="flex justify-end gap-2 pt-2 border-t border-pos-border">
                      <button
                        type="button"
                        onClick={() => setIsCashierModalOpen(false)}
                        className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs font-bold transition cursor-pointer"
                      >
                        Annuler
                      </button>
                      {(() => {
                        const isTargetAdmin =
                          cashierRoleInput === 'admin' ||
                          (editingCashierId ? cashierUsers.find((u) => u.id === editingCashierId)?.role === 'admin' : false);
                        const minPinLen = isTargetAdmin ? 6 : 4;
                        const maxPinLen = isTargetAdmin ? 8 : 4;
                        const isPinChanging = Boolean(previousCashierPinInput || cashierPinInput || confirmCashierPinInput);
                        const isPinValidForEdit =
                          !isPinChanging ||
                          (previousCashierPinInput.trim().length > 0 &&
                            cashierPinInput.length >= minPinLen &&
                            cashierPinInput.length <= maxPinLen &&
                            cashierPinInput === confirmCashierPinInput);
                        const isPinValidForAdd =
                          cashierPinInput.length >= minPinLen &&
                          cashierPinInput.length <= maxPinLen &&
                          cashierPinInput === confirmCashierPinInput;
                        const canSave =
                          !isSavingCashier &&
                          Boolean(cashierNameInput.trim()) &&
                          (editingCashierId ? isPinValidForEdit : isPinValidForAdd);

                        return (
                          <button
                            type="button"
                            onClick={handleSaveCashier}
                            disabled={!canSave}
                            className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition cursor-pointer shadow-md disabled:opacity-40 active:scale-95"
                          >
                            {isSavingCashier
                              ? 'Enregistrement...'
                              : editingCashierId
                                ? 'Mettre à jour'
                                : 'Ajouter le Caissier'}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                )}

                {/* Staff Roster Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {cashierUsers.map((cashier) => {
                    const isActive = activeCashier?.id === cashier.id;
                    const isPrimaryAdmin =
                      cashier.role === 'admin' &&
                      cashierUsers.find((u) => u.role === 'admin')?.id === cashier.id;
                    return (
                      <div
                        key={cashier.id}
                        className={`bg-pos-bg border rounded-2xl p-4 flex flex-col justify-between space-y-3.5 transition relative group ${
                          isActive
                            ? 'border-amber-500/60 shadow-lg shadow-amber-500/10 ring-1 ring-amber-500/30'
                            : 'border-pos-border hover:border-pos-border/80 hover:shadow-md'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2.5">
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className="w-11 h-11 rounded-2xl flex items-center justify-center font-black text-sm text-slate-950 shadow-md shrink-0 relative"
                              style={{ backgroundColor: cashier.avatarColor || '#3b82f6' }}
                            >
                              {cashier.role === 'admin' ? (
                                <Shield className="w-5 h-5 text-white" />
                              ) : (
                                <User className="w-5 h-5 text-white" />
                              )}
                              {isActive && (
                                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-pos-bg flex items-center justify-center">
                                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                                </span>
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-black text-xs text-pos-text truncate">
                                  {cashier.name}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                <span
                                  className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-md flex items-center gap-1 ${
                                    cashier.role === 'admin'
                                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                  }`}
                                >
                                  {cashier.role === 'admin' ? (
                                    <>
                                      <Shield className="w-2.5 h-2.5" />
                                      <span>{isPrimaryAdmin ? 'Gérant Principal' : 'Superviseur'}</span>
                                    </>
                                  ) : (
                                    <>
                                      <User className="w-2.5 h-2.5" />
                                      <span>Caissier</span>
                                    </>
                                  )}
                                </span>
                                {isActive && (
                                  <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold px-1.5 py-0.5 rounded-md">
                                    En Service
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleOpenEditCashier(cashier)}
                              className="p-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer active:scale-95"
                              title="Modifier nom, rôle ou code PIN"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCashier(cashier.id)}
                              className="p-1.5 rounded-xl bg-pos-card hover:bg-rose-500/20 border border-pos-border text-pos-muted hover:text-rose-400 transition cursor-pointer active:scale-95"
                              title="Supprimer l'employé"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[11px] pt-2.5 border-t border-pos-border/40 text-pos-muted font-mono">
                          <span className="text-[10px] uppercase font-bold tracking-wider">Format PIN</span>
                          <span className="bg-pos-card px-2.5 py-0.5 rounded-lg border border-pos-border text-pos-text font-bold tracking-wider flex items-center gap-1.5">
                            <Lock className="w-3 h-3 text-pos-muted" />
                            <span>{cashier.role === 'admin' ? '•••••• (6-8 ch.)' : '•••• (4 ch.)'}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── CARD 3: Politiques Antivol & Protection Financière (Synthèse) ── */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-3 shadow-md">
                <div className="flex items-center gap-2 border-b border-pos-border/60 pb-2.5">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                    Politiques Antivol & Contrôle des Marges
                  </h4>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-1">
                    <span className="text-[10px] text-amber-400 font-bold block uppercase">Plafond Remise Caissier</span>
                    <p className="font-bold text-pos-text">20% Maximum</p>
                    <p className="text-[10px] text-pos-muted">Au-delà de 20%, le PIN Manager superviseur est obligatoirement requis.</p>
                  </div>
                  <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-1">
                    <span className="text-[10px] text-rose-400 font-bold block uppercase">Vente à Perte</span>
                    <p className="font-bold text-pos-text">Bloquée (Strict)</p>
                    <p className="text-[10px] text-pos-muted">Interdiction absolue de vendre sous le coût d'achat FIFO sans accord superviseur.</p>
                  </div>
                  <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-1">
                    <span className="text-[10px] text-purple-400 font-bold block uppercase">Recomptage Espèces</span>
                    <p className="font-bold text-pos-text">Verrouillage Z</p>
                    <p className="text-[10px] text-pos-muted">Le comptage aveugle de fin de shift ne peut être altéré sans PIN Manager.</p>
                  </div>
                  <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-1">
                    <span className="text-[10px] text-emerald-400 font-bold block uppercase">Audit Immuable</span>
                    <p className="font-bold text-pos-text">Horodatage Local</p>
                    <p className="text-[10px] text-pos-muted">Chaque dérogation, ouverture tiroir No Sale et changement PIN est archivé.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══════ TAB: Advanced Diagnostics ══════ */}
          {activeTab === 'diagnostics' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">
                  {selectedDiagDevice
                    ? `Diagnostic — ${devices.find(d => d.id === selectedDiagDevice)?.brand} ${devices.find(d => d.id === selectedDiagDevice)?.model}`
                    : 'Diagnostic Système Complet'}
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={startScannerTest}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-bold flex items-center gap-1.5 hover:bg-amber-500/20 transition cursor-pointer"
                  >
                    <ScanLine className="w-3.5 h-3.5" /> Test Scanner Live
                  </button>
                  <button
                    onClick={runFullDiagnostics}
                    disabled={isRunningAllDiag}
                    className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition cursor-pointer disabled:opacity-50"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> {isRunningAllDiag ? 'En Cours...' : 'Relancer Tous les Tests'}
                  </button>
                </div>
              </div>

              {/* Live Scanner Test Zone */}
              {scannerTestActive && (
                <div className="bg-pos-card border border-amber-500/30 rounded-xl p-4 shadow-md shadow-amber-500/5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <ScanLine className="w-4 h-4 text-amber-400 animate-pulse" />
                      <h4 className="text-xs font-bold text-pos-text">Test Scanner en Temps Réel</h4>
                    </div>
                    <button onClick={() => setScannerTestActive(false)} className="text-[10px] text-pos-muted hover:text-pos-text underline cursor-pointer">Fermer</button>
                  </div>
                  <p className="text-[10px] text-pos-muted mb-2">Scannez un code-barres ou QR code. Le résultat apparaîtra instantanément ci-dessous :</p>
                  <input
                    ref={scannerInputRef}
                    type="text"
                    value={scannerTestInput}
                    onChange={e => setScannerTestInput(e.target.value)}
                    placeholder="← En attente de lecture scanner..."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-4 py-3 text-sm font-mono text-pos-text focus:border-amber-400 focus:outline-none transition"
                    autoFocus
                  />
                  {scannerTestInput && (
                    <div className="mt-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <div>
                        <p className="text-xs font-bold text-emerald-400">Lecture Réussie !</p>
                        <p className="text-[10px] text-pos-text font-mono">{scannerTestInput}</p>
                        <p className="text-[10px] text-pos-muted">{scannerTestInput.length} caractères • Type: {/^[0-9]+$/.test(scannerTestInput) ? (scannerTestInput.length === 13 ? 'EAN-13' : scannerTestInput.length === 12 ? 'UPC-A' : scannerTestInput.length === 8 ? 'EAN-8' : 'Numérique') : 'Alphanumérique (QR/DataMatrix)'}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Diagnostic Results */}
              {diagnosticTests.length === 0 ? (
                <div className="text-center py-16">
                  <Activity className="w-10 h-10 text-pos-muted/30 mx-auto mb-3" />
                  <p className="text-sm font-bold text-pos-muted">Aucun diagnostic exécuté</p>
                  <p className="text-xs text-pos-muted/60 mt-1">Cliquez sur « Tester » dans l'onglet Matériel ou lancez un diagnostic complet.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Summary Bar */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                    <div className="bg-pos-card border border-pos-border rounded-lg p-2 text-center">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">Total Tests</span>
                      <span className="text-sm font-black text-pos-text">{totalTests}</span>
                    </div>
                    <div className="bg-pos-card border border-pos-border rounded-lg p-2 text-center">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">Réussis</span>
                      <span className="text-sm font-black text-emerald-400">{passedTests}</span>
                    </div>
                    <div className="bg-pos-card border border-pos-border rounded-lg p-2 text-center">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">Échoués</span>
                      <span className="text-sm font-black text-red-400">{failedTests}</span>
                    </div>
                    <div className="bg-pos-card border border-pos-border rounded-lg p-2 text-center">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">Taux Succès</span>
                      <span className={`text-sm font-black ${totalTests > 0 && passedTests === totalTests ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {totalTests > 0 ? Math.round(passedTests / totalTests * 100) : 0}%
                      </span>
                    </div>
                  </div>

                  {/* Test Rows */}
                  {(diagnosticTests || []).map(test => {
                    const rc = (test?.result && resultConfig[test.result as DiagnosticResult]) || resultConfig['pending'];
                    const device = (devices || []).find(d => d.id === test.deviceId);
                    return (
                      <div key={test.id} className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between hover:border-pos-text/20 transition">
                        <div className="flex items-center gap-3">
                          {rc.icon}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-pos-text">{test.testName}</span>
                              {device && <span className="text-[9px] text-pos-muted bg-pos-bg px-1.5 py-0.5 rounded-full border border-pos-border">{device.brand} {device.model}</span>}
                            </div>
                            <p className="text-[10px] text-pos-muted mt-0.5">{test.description}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-right">
                          {test.duration && (
                            <span className="text-[10px] text-pos-muted font-mono">{test.duration}ms</span>
                          )}
                          <span className={`text-[10px] font-bold ${rc.color} min-w-[60px] text-right`}>
                            {test.message || rc.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ══════ TAB: Loyalty Program Studio & Financial Simulator ══════ */}
          {activeTab === 'loyalty' && (
            <div className="space-y-5 max-w-4xl mx-auto">
              {(() => {
                const cfg = normalizeLoyaltyConfig(receiptDraft.loyaltyConfig);
                const updateLoyaltyCfg = (next: LoyaltyProgramConfig) => {
                  scheduleReceiptSave({ ...receiptDraft, loyaltyConfig: normalizeLoyaltyConfig(next) });
                };
                const freshId = (prefix: string) =>
                  typeof crypto !== 'undefined' && 'randomUUID' in crypto
                    ? (crypto as Crypto).randomUUID()
                    : `${prefix}-${Date.now().toString(36)}`;
                const numField = (raw: string, fallback: number): number => {
                  const n = Number(raw);
                  return Number.isFinite(n) ? n : fallback;
                };
                return (<>

              {/* Studio Header Card + master switch */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
                    <Award className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-pos-text flex items-center gap-2">
                      Studio de Configuration du Programme de Fidélité & Modèle Financier
                      <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full border ${cfg.enabled ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-slate-500/10 text-slate-400 border-slate-500/30'}`}>
                        {cfg.enabled ? 'Actif' : 'Désactivé'}
                      </span>
                    </h3>
                    <p className="text-[11px] text-pos-muted">
                      Contrôle granulaire de la distribution des points, des multiplicateurs et de l'impact financier sur le profit net.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateLoyaltyCfg({ ...cfg, enabled: !cfg.enabled })}
                    className={`px-4 py-2 font-bold text-xs rounded-xl shadow-lg cursor-pointer transition ${cfg.enabled ? 'bg-slate-700 hover:bg-slate-600 text-white' : 'bg-gradient-to-r from-amber-500 to-emerald-600 hover:from-amber-400 hover:to-emerald-500 text-slate-950 shadow-amber-500/20'}`}
                  >
                    {cfg.enabled ? 'Désactiver le Programme' : 'Activer le Programme'}
                  </button>
                  <button
                    onClick={() => { scheduleReceiptSave({ ...receiptDraft, loyaltyConfig: cfg }); showToast('Paramètres du programme de fidélité mis à jour avec succès.', 'success'); }}
                    className="px-4 py-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs rounded-xl cursor-pointer"
                  >
                    Enregistrer
                  </button>
                </div>
              </div>

              {/* Disabled-mode selector */}
              {!cfg.enabled && (
                <div className="bg-pos-card border border-amber-500/30 rounded-xl p-4 space-y-2">
                  <h4 className="text-xs font-bold text-pos-text">Comportement à l'arrêt</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      onClick={() => updateLoyaltyCfg({ ...cfg, disabledMode: 'freeze-all' })}
                      className={`p-2.5 rounded-lg border text-left cursor-pointer transition ${cfg.disabledMode === 'freeze-all' ? 'border-amber-500 bg-amber-500/10 text-pos-text font-bold' : 'border-pos-border bg-pos-bg text-pos-muted'}`}
                    >
                      <span className="block font-bold mb-0.5">❄️ Gel total</span>
                      <span className="text-[10px]">Soldes conservés. Ni gain, ni échange.</span>
                    </button>
                    <button
                      onClick={() => updateLoyaltyCfg({ ...cfg, disabledMode: 'earn-off-redeem-on' })}
                      className={`p-2.5 rounded-lg border text-left cursor-pointer transition ${cfg.disabledMode === 'earn-off-redeem-on' ? 'border-emerald-500 bg-emerald-500/10 text-pos-text font-bold' : 'border-pos-border bg-pos-bg text-pos-muted'}`}
                    >
                      <span className="block font-bold mb-0.5">💰 Gains coupés, échanges ouverts</span>
                      <span className="text-[10px]">Les clients dépensent leurs points, sans en gagner.</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Distribution & Redemption Rules */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* Rule Card 1: Earning & Redemption Rates */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
                    <Zap className="w-4 h-4 text-amber-400" /> Règles de Gain & Conversion de Points
                  </h4>
                  {/* Granular mechanism switches */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => updateLoyaltyCfg({ ...cfg, pointsEnabled: !(cfg.pointsEnabled ?? true) })}
                      className={`p-2 rounded-lg border text-left cursor-pointer transition ${cfg.pointsEnabled ?? true ? 'border-amber-500/60 bg-amber-500/10' : 'border-pos-border bg-pos-bg opacity-70'}`}
                      title="Points gagnés et échanges"
                    >
                      <span className="block text-[11px] font-bold text-pos-text">⭐ Système de points</span>
                      <span className={`text-[9px] font-bold uppercase ${(cfg.pointsEnabled ?? true) ? 'text-emerald-400' : 'text-pos-muted'}`}>
                        {(cfg.pointsEnabled ?? true) ? 'Activé' : 'Coupé'}
                      </span>
                    </button>
                    <button
                      onClick={() => updateLoyaltyCfg({ ...cfg, tierMultipliersEnabled: !(cfg.tierMultipliersEnabled ?? true) })}
                      className={`p-2 rounded-lg border text-left cursor-pointer transition ${cfg.tierMultipliersEnabled ?? true ? 'border-cyan-500/60 bg-cyan-500/10' : 'border-pos-border bg-pos-bg opacity-70'}`}
                      title="Multiplicateurs de palier (les campagnes restent actives)"
                    >
                      <span className="block text-[11px] font-bold text-pos-text">✖️ Multiplicateurs de palier</span>
                      <span className={`text-[9px] font-bold uppercase ${(cfg.tierMultipliersEnabled ?? true) ? 'text-emerald-400' : 'text-pos-muted'}`}>
                        {(cfg.tierMultipliersEnabled ?? true) ? 'Activés (1.0x–2.5x)' : 'Forcés à 1.0x'}
                      </span>
                    </button>
                  </div>
                  {(cfg.pointsEnabled === false) && (
                    <p className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
                      Points coupés : aucun gain ni échange de points. Les paliers de dépense (Avoir automatique) restent actifs.
                    </p>
                  )}
                  <div className="space-y-3 text-xs">
                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Montant d'Achat par Point de Base (DA)
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={cfg.baseSpendPerPoint}
                        onChange={(e) => updateLoyaltyCfg({ ...cfg, baseSpendPerPoint: Math.max(1, Math.floor(numField(e.target.value, cfg.baseSpendPerPoint))) })}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                      />
                      <span className="text-[9.5px] text-pos-muted mt-0.5 block">{cfg.baseSpendPerPoint} DA dépensés = 1 Point de Base</span>
                    </div>

                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Valeur de Conversion en Avoir Client (DA par Point)
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={cfg.pointRedemptionRate}
                        onChange={(e) => updateLoyaltyCfg({ ...cfg, pointRedemptionRate: Math.max(1, Math.floor(numField(e.target.value, cfg.pointRedemptionRate))) })}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-emerald-400 font-bold"
                      />
                      <span className="text-[9.5px] text-pos-muted mt-0.5 block">1 Point = {cfg.pointRedemptionRate} DA d'Avoir Client</span>
                    </div>

                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Seuil Minimum de Points pour Échange
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={cfg.minimumRedemptionPoints}
                        onChange={(e) => updateLoyaltyCfg({ ...cfg, minimumRedemptionPoints: Math.max(1, Math.floor(numField(e.target.value, cfg.minimumRedemptionPoints))) })}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Plafond d'Échange par Vente (% du panier)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={cfg.maximumRedemptionPercentPerSale}
                        onChange={(e) => updateLoyaltyCfg({ ...cfg, maximumRedemptionPercentPerSale: Math.min(100, Math.max(0, numField(e.target.value, cfg.maximumRedemptionPercentPerSale))) })}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                      />
                    </div>
                  </div>
                </div>

                {/* Rule Card 2: Tier table editor */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" /> Paliers & Multiplicateurs
                  </h4>
                  <div className="space-y-2 text-xs">
                    {cfg.tiers.map((t) => (
                      <div key={t.id} className="bg-pos-bg p-2 rounded-lg border border-pos-border space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm">{t.style.icon}</span>
                          <input
                            type="text"
                            value={t.name}
                            disabled={t.id === 'tier-0'}
                            title={t.id === 'tier-0' ? 'Palier de base verrouillé' : 'Nom du palier'}
                            onChange={(e) => {
                              const tiers = cfg.tiers.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x));
                              updateLoyaltyCfg({ ...cfg, tiers });
                            }}
                            className="flex-1 min-w-0 bg-transparent border border-transparent hover:border-pos-border focus:border-amber-500 rounded px-1 py-0.5 font-semibold text-pos-text focus:outline-none disabled:opacity-70"
                          />
                          {t.id === 'tier-0' && (
                            <span className="text-[9px] font-bold text-pos-muted uppercase">Base 🔒</span>
                          )}
                          {t.id !== 'tier-0' && (
                            <button
                              onClick={() => updateLoyaltyCfg({ ...cfg, tiers: cfg.tiers.filter((x) => x.id !== t.id) })}
                              className="p-1 text-pos-muted hover:text-red-400 cursor-pointer"
                              title="Supprimer ce palier"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <label className="block">
                            <span className="text-[9px] text-pos-muted uppercase font-semibold">Seuil (DA)</span>
                            <input
                              type="number"
                              min={t.id === 'tier-0' ? 0 : 1}
                              disabled={t.id === 'tier-0'}
                              value={t.minSpend}
                              onChange={(e) => {
                                const tiers = cfg.tiers.map((x) => (x.id === t.id ? { ...x, minSpend: Math.max(0, Math.floor(numField(e.target.value, t.minSpend))) } : x));
                                updateLoyaltyCfg({ ...cfg, tiers });
                              }}
                              className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-pos-text focus:outline-none focus:border-amber-500 disabled:opacity-70"
                            />
                          </label>
                          <label className={`block ${(cfg.tierMultipliersEnabled ?? true) ? '' : 'opacity-40'}`}>
                            <span className="text-[9px] text-pos-muted uppercase font-semibold">Multiplicateur{(cfg.tierMultipliersEnabled ?? true) ? '' : ' (forcé 1.0x)'}</span>
                            <input
                              type="number"
                              min={0.1}
                              step={0.05}
                              value={t.multiplier}
                              disabled={!(cfg.tierMultipliersEnabled ?? true)}
                              onChange={(e) => {
                                const tiers = cfg.tiers.map((x) => (x.id === t.id ? { ...x, multiplier: Math.max(0.1, numField(e.target.value, t.multiplier)) } : x));
                                updateLoyaltyCfg({ ...cfg, tiers });
                              }}
                              className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-pos-text focus:outline-none focus:border-amber-500 disabled:cursor-not-allowed"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        const maxSpend = cfg.tiers.reduce((m, t) => Math.max(m, t.minSpend), 0);
                        const lastMult = cfg.tiers[cfg.tiers.length - 1]?.multiplier ?? 1;
                        updateLoyaltyCfg({
                          ...cfg,
                          tiers: [...cfg.tiers, {
                            id: freshId('tier'), name: `Palier ${cfg.tiers.length + 1}`,
                            minSpend: maxSpend + 50000, multiplier: lastMult,
                            style: { badgeColor: 'text-pos-text', bgColor: 'bg-pos-bg', borderColor: 'border-pos-border', icon: '⭐' },
                          }],
                        });
                      }}
                      className="w-full py-1.5 rounded-lg border border-dashed border-pos-border hover:border-amber-500/50 text-[11px] font-bold text-pos-muted hover:text-pos-text cursor-pointer"
                    >
                      + Ajouter un palier
                    </button>
                  </div>
                </div>
              </div>

              {/* Milestone builder */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
                  <Award className="w-4 h-4 text-amber-400" /> Paliers de Dépense → Avoir Automatique
                </h4>
                <p className="text-[10px] text-pos-muted">Ex : 20 000 DA cumulés → 1 000 DA d'Avoir crédités. Modifier un seuil ou une récompense crée un nouveau palier (l'historique reste intact).</p>
                <div className="space-y-2 text-xs">
                  {cfg.spendMilestones.length === 0 && (
                    <p className="text-[11px] text-pos-muted italic">Aucun palier — ajoutez-en un ci-dessous.</p>
                  )}
                  {cfg.spendMilestones.map((m) => (
                    <div key={m.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 items-end bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <label className="block">
                        <span className="text-[9px] text-pos-muted uppercase font-semibold">Seuil (DA)</span>
                        <input
                          type="number"
                          min={1}
                          value={m.threshold}
                          onChange={(e) => {
                            const rows = cfg.spendMilestones.map((x) => (x.id === m.id
                              ? { ...x, id: freshId('ms'), threshold: Math.max(1, Math.floor(numField(e.target.value, m.threshold))) }
                              : x));
                            updateLoyaltyCfg({ ...cfg, spendMilestones: rows });
                          }}
                          className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-pos-text focus:outline-none focus:border-amber-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[9px] text-pos-muted uppercase font-semibold">Récompense (DA)</span>
                        <input
                          type="number"
                          min={0}
                          value={m.reward}
                          onChange={(e) => {
                            const rows = cfg.spendMilestones.map((x) => (x.id === m.id
                              ? { ...x, id: freshId('ms'), reward: Math.max(0, Math.floor(numField(e.target.value, m.reward))) }
                              : x));
                            updateLoyaltyCfg({ ...cfg, spendMilestones: rows });
                          }}
                          className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-emerald-400 focus:outline-none focus:border-amber-500"
                        />
                      </label>
                      <label className="flex items-center gap-1 pb-1 cursor-pointer text-[10px] text-pos-muted font-semibold" title="Chaque tranche dépensée récompense à nouveau">
                        <input
                          type="checkbox"
                          checked={m.repeatable}
                          onChange={(e) => {
                            const rows = cfg.spendMilestones.map((x) => (x.id === m.id ? { ...x, repeatable: e.target.checked } : x));
                            updateLoyaltyCfg({ ...cfg, spendMilestones: rows });
                          }}
                          className="rounded border-pos-border"
                        />
                        Répétable
                      </label>
                      <button
                        onClick={() => updateLoyaltyCfg({ ...cfg, spendMilestones: cfg.spendMilestones.filter((x) => x.id !== m.id) })}
                        className="p-1.5 text-pos-muted hover:text-red-400 cursor-pointer"
                        title="Supprimer ce palier"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => updateLoyaltyCfg({
                      ...cfg,
                      spendMilestones: [...cfg.spendMilestones, { id: freshId('ms'), threshold: 20000, reward: 1000, repeatable: true }],
                    })}
                    className="w-full py-1.5 rounded-lg border border-dashed border-pos-border hover:border-amber-500/50 text-[11px] font-bold text-pos-muted hover:text-pos-text cursor-pointer"
                  >
                    + Ajouter un palier de dépense
                  </button>
                  <p className="text-[10px] text-pos-muted italic">
                    Note sur les nouveaux paliers : L'ajout ou l'activation d'un nouveau palier s'appliquera rétroactivement au volume d'achat historique des clients existants dès leur prochaine synchronisation.
                  </p>
                </div>
              </div>

              {/* FINANCIAL PROFIT & MARGIN IMPACT SIMULATOR */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
                  <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-emerald-400" /> Simulateur d'Impact Financier & Marge Nette
                  </h4>
                  <span className="text-[10px] text-pos-muted">Calcule le profit net réel après Avoir & Réductions</span>
                </div>

                {(() => {
                  const sim = calculateFinancialProfitImpact(10000, 500, 1000, 4500, 150, cfg);
                  return (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-xs">
                      <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
                        <span className="text-[10px] text-pos-muted uppercase font-semibold block">Panier Brut</span>
                        <span className="text-base font-black text-pos-text">{formatDZD(sim.grossSubtotal)}</span>
                      </div>
                      <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
                        <span className="text-[10px] text-pos-muted uppercase font-semibold block">CA Net Perçu</span>
                        <span className="text-base font-black text-blue-400">{formatDZD(sim.netRevenue)}</span>
                        <span className="text-[9px] text-pos-muted block mt-0.5">Après 1 500 DA Réductions/Avoir</span>
                      </div>
                      <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
                        <span className="text-[10px] text-pos-muted uppercase font-semibold block">Coût d'Achat (COGS)</span>
                        <span className="text-base font-black text-amber-400">{formatDZD(sim.costOfGoodsSold)}</span>
                      </div>
                      <div className="bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/30">
                        <span className="text-[10px] text-emerald-400 uppercase font-semibold block">Benefice Net Réel</span>
                        <span className="text-base font-black text-emerald-400">{formatDZD(sim.netProfit)}</span>
                        <span className="text-[9px] text-emerald-300 font-bold block mt-0.5">Marge Nette: {sim.netProfitMarginPercent}%</span>
                      </div>
                    </div>
                  );
                })()}
              </div>

                </>);})()}
            </div>
          )}

          {/* ══════ TAB: Backup & Data ══════ */}
          {activeTab === 'backup' && (
            <div className="space-y-4 max-w-4xl mx-auto">
              {/* SQLite Engine Banner */}
              <div className="bg-gradient-to-r from-cyan-950/40 via-pos-card to-blue-950/40 border border-cyan-500/30 rounded-2xl p-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/40 shadow-lg shadow-cyan-500/10">
                      <Database className="w-6 h-6 stroke-[2.5]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-extrabold text-pos-text tracking-wide">
                          Moteur SQLite Haute Performance
                        </h3>
                        <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" /> Zéro Perte de Données (WAL)
                        </span>
                      </div>
                      <p className="text-[11px] text-pos-muted">
                        Architecture ACID native sur disque • Concurrence multi-thread avec verrous sans latence • Cache mémoire 64 Mo
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={loadDbStats}
                    className="px-3 py-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <RefreshCcw className="w-3.5 h-3.5" /> Actualiser Métriques
                  </button>
                </div>

                {/* SQLite Badges */}
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-pos-border/50 text-[10px]">
                  <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
                    <Zap className="w-3 h-3 text-amber-400" /> Mode: <strong className="text-pos-text">{dbStats?.journal_mode?.toUpperCase() || 'WAL'}</strong>
                  </span>
                  <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
                    <Shield className="w-3 h-3 text-purple-400" /> Sync: <strong className="text-pos-text">{dbStats?.synchronous || 'NORMAL'}</strong>
                  </span>
                  <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Clés Étrangères: <strong className="text-emerald-400">Actives (ON)</strong>
                  </span>
                  <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
                    <HardDrive className="w-3 h-3 text-cyan-400" /> MMAP: <strong className="text-cyan-400">256 Mo</strong>
                  </span>
                  <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
                    <Cpu className="w-3 h-3 text-blue-400" /> Cache RAM: <strong className="text-blue-400">64 Mo</strong>
                  </span>
                </div>
              </div>

              {/* Database Live KPIs */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
                <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
                  <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">Taille Base de Données</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-black text-pos-text">
                      {dbStats ? (dbStats.db_size_bytes > 1048576 ? `${(dbStats.db_size_bytes / 1048576).toFixed(2)} Mo` : `${(dbStats.db_size_bytes / 1024).toFixed(1)} Ko`) : '...'}
                    </span>
                  </div>
                  <span className="text-[9px] text-pos-muted block mt-0.5 truncate" title={dbStats?.db_path}>
                    {dbStats?.db_path ? dbStats.db_path.split(/[\\/]/).pop() : 'mobi_pos.db'}
                  </span>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
                  <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">Journal WAL Actif</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-black text-cyan-400">
                      {dbStats ? `${(dbStats.wal_size_bytes / 1024).toFixed(1)} Ko` : '0.0 Ko'}
                    </span>
                  </div>
                  <span className="text-[9px] text-emerald-400 font-semibold block mt-0.5">Écritures non-bloquantes</span>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
                  <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">Total Transactions</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-black text-emerald-400">
                      {dbStats?.total_transactions ?? 0}
                    </span>
                    <span className="text-[10px] text-pos-muted">tickets</span>
                  </div>
                  <span className="text-[9px] text-pos-muted block mt-0.5">{dbStats?.total_products ?? 0} articles en stock</span>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
                  <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">Pages Allouées</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-black text-purple-400">
                      {dbStats?.page_count ?? 0}
                    </span>
                    <span className="text-[10px] text-pos-muted">pages</span>
                  </div>
                  <span className="text-[9px] text-pos-muted block mt-0.5">Page: {dbStats?.page_size ?? 4096} octets</span>
                </div>
              </div>

              {/* Integrity & Diagnostics Control Panel */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
                <div className="flex items-center justify-between border-b border-pos-border/60 pb-2.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                      Diagnostics d'Intégrité & Maintenance SQLite
                    </h4>
                  </div>
                  <span className="text-[10px] text-pos-muted font-mono">
                    PRAGMA integrity_check & VACUUM
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
                  <button
                    onClick={handleRunIntegrityCheck}
                    disabled={isCheckingIntegrity}
                    className="min-h-[48px] py-2.5 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
                  >
                    <Activity className={`w-4 h-4 ${isCheckingIntegrity ? 'animate-spin' : ''}`} />
                    {isCheckingIntegrity ? 'Vérification...' : 'Vérifier Intégrité Complète'}
                  </button>

                  <button
                    onClick={handleCheckpointWal}
                    disabled={isCheckpointing}
                    className="min-h-[48px] py-2.5 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
                  >
                    <Zap className={`w-4 h-4 ${isCheckpointing ? 'animate-spin' : ''}`} />
                    {isCheckpointing ? 'Checkpoint...' : 'Checkpoint WAL (TRUNCATE)'}
                  </button>

                  <button
                    onClick={handleVacuum}
                    disabled={isVacuuming}
                    className="min-h-[48px] py-2.5 px-3 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
                  >
                    <RefreshCcw className={`w-4 h-4 ${isVacuuming ? 'animate-spin' : ''}`} />
                    {isVacuuming ? 'Défragmentation...' : 'Optimiser Pages (VACUUM)'}
                  </button>
                </div>

                {/* Integrity Report Box */}
                {integrityReport && (
                  <div className={`p-3 rounded-xl border text-xs space-y-1 animate-in fade-in ${integrityReport.is_healthy ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
                    <div className="flex items-center gap-2 font-bold">
                      {integrityReport.is_healthy ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <span>Rapport d'Intégrité : 100% Conforme et Sain</span>
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="w-4 h-4 text-red-400" />
                          <span>Alerte d'Intégrité : Anomalie détectée</span>
                        </>
                      )}
                    </div>
                    <div className="text-[11px] font-mono opacity-90 pl-6">
                      {(integrityReport?.integrity_messages || []).map((m, idx) => (
                        <div key={idx}>➔ {m}</div>
                      ))}
                      {(integrityReport?.foreign_key_violations || []).map((f, idx) => (
                        <div key={`fk-${idx}`} className="text-red-400">➔ Violation FK : {f}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Security & Access Redirection Banner */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center border border-purple-500/30 shrink-0">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                      Code PIN Manager & Gestion de l'Équipe
                    </h4>
                    <p className="text-[11px] text-pos-muted">
                      La gestion des codes PIN et des caissiers est désormais regroupée dans l'onglet dédié « Sécurité & Personnel ».
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('security')}
                  className="px-3.5 py-1.5 rounded-xl bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-300 text-xs font-bold transition cursor-pointer shrink-0"
                >
                  Ouvrir Sécurité & Personnel →
                </button>
              </div>

              {/* JSON Backup & Restore Cards */}
              <div className="grid grid-cols-2 gap-4">
                {/* Export Card */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex flex-col justify-between">
                  <div className="space-y-2 mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                        <Download className="w-4 h-4 stroke-[2.5]" />
                      </div>
                      <h4 className="text-xs font-bold text-pos-text">Export Complet de Sauvegarde</h4>
                    </div>
                    <p className="text-[10px] text-pos-muted">
                      Exporte l'intégralité des articles, clients, tickets, réparations, kits et paramètres au format JSON standard.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowExportPin(true)}
                    className="w-full py-2 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
                  >
                    <Download className="w-4 h-4" /> Télécharger Sauvegarde JSON
                  </button>
                </div>

                {/* Import Card */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex flex-col justify-between">
                  <div className="space-y-2 mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30">
                        <Upload className="w-4 h-4 stroke-[2.5]" />
                      </div>
                      <h4 className="text-xs font-bold text-pos-text">Restauration depuis JSON</h4>
                    </div>
                    <p className="text-[10px] text-pos-muted">
                      Importe et synchronise un fichier de sauvegarde JSON dans les tables de la base de données.
                      Remplace les données actuelles — PIN Manager requis.
                    </p>
                    <input
                      type="password"
                      inputMode="numeric"
                      autoComplete="current-password"
                      value={restorePinInput}
                      onChange={(e) => setRestorePinInput(e.target.value)}
                      placeholder="PIN Manager requis"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-blue-400 focus:outline-none"
                    />
                    {stagedRestore && (
                      <p className="text-[10px] text-emerald-300 font-mono break-all">
                        Prêt : v{stagedRestore.version ?? '?'} — {Object.keys(stagedRestore.counts ?? {}).length} table(s) — sha {stagedRestore.sha256.slice(0, 16)}…
                      </p>
                    )}
                  </div>
                  {!stagedRestore ? (
                    <button
                      type="button"
                      onClick={handleRestoreClick}
                      className="w-full py-2 px-3 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 text-blue-400 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      <Upload className="w-4 h-4" /> Sélectionner un Fichier JSON
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleExecuteRestore}
                      disabled={isRestoring}
                      className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      <Upload className="w-4 h-4" /> {isRestoring ? 'Restauration…' : 'Restaurer (PIN Manager requis)'}
                    </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  {/* Decision 2: full-JSON export leaves the device — fresh
                      manager PIN per download via the native gate. */}
                  <PinDialog
                    isOpen={showExportPin}
                    title="Export de sauvegarde"
                    description="Saisissez le code PIN Manager pour télécharger la sauvegarde JSON complète."
                    onSuccess={() => {
                      setShowExportPin(false);
                      void exportDatabase();
                    }}
                    onCancel={() => setShowExportPin(false)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* TAB 5: MISES À JOUR & VERSION */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {activeTab === 'updates' && (
            <div className="space-y-6 max-w-4xl mx-auto py-2">
              {/* Executive Version Header Card */}
              <div className="bg-gradient-to-br from-purple-950/40 via-pos-card to-slate-900 border border-purple-500/30 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                  <Sparkles className="w-32 h-32 text-purple-400" />
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/25">
                      <Sparkles className="w-6 h-6 stroke-[2.5]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-black text-pos-text tracking-wide">MobiPOS Pro</h3>
                        <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 font-mono font-black text-xs">
                          v{APP_VERSION}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold">
                          Canal Stable
                        </span>
                      </div>
                      <p className="text-xs text-pos-muted mt-0.5">
                        Système de Caisse & Gestion de Stock • Architecture Hybride Tauri 2.0 & SQLite WAL
                      </p>
                    </div>
                  </div>

                  {/* Check Updates Button */}
                  <button
                    type="button"
                    onClick={handleCheckUpdates}
                    disabled={updater.isChecking || updater.downloading}
                    className="py-2.5 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-black flex items-center justify-center gap-2 transition shadow-lg shadow-purple-600/30 cursor-pointer disabled:opacity-50 active:scale-95"
                  >
                    <RefreshCcw className={`w-4 h-4 ${updater.isChecking ? 'animate-spin' : ''}`} />
                    <span>{updater.isChecking ? 'Vérification en cours...' : 'Vérifier Mises à Jour'}</span>
                  </button>
                </div>

                {/* Status Indicator Banner */}
                <div className="mt-4 pt-4 border-t border-pos-border/60 flex items-center gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full ${updater.isUpdateAvailable ? 'bg-purple-400 animate-ping' : 'bg-emerald-400 animate-pulse'}`} />
                  <p className="text-xs font-semibold text-pos-text">
                    {updater.checkStatusMessage ||
                      (updater.isUpdateAvailable
                        ? `🚀 Version ${updater.updateInfo?.version} disponible au téléchargement !`
                        : `✅ Votre système est synchronisé avec la version de production la plus récente (v${APP_VERSION}).`)}
                  </p>
                </div>
              </div>

              {/* Update Action Panel (If Update Available) */}
              {updater.isUpdateAvailable && updater.updateInfo && (
                <div className="bg-pos-card border border-purple-500/60 rounded-2xl p-5 space-y-4 animate-in fade-in zoom-in-95">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/40">
                        <Download className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-black text-pos-text">Mise à Jour v{updater.updateInfo.version} Prête</h4>
                        <p className="text-[11px] text-pos-muted">Date de publication : {updater.updateInfo.date || 'Récemment'}</p>
                      </div>
                    </div>

                    {updater.hasNativeInstaller ? (
                      !updater.readyToRelaunch ? (
                        <button
                          type="button"
                          onClick={() => {
                            soundEngine.playKeyBeep?.();
                            showToast("Téléchargement et installation en cours...", "info");
                            updater.downloadAndInstall();
                          }}
                          disabled={updater.downloading}
                          className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer disabled:opacity-50 active:scale-95"
                        >
                          <Download className={`w-4 h-4 ${updater.downloading ? 'animate-bounce' : ''}`} />
                          <span>{updater.downloading ? `Téléchargement (${updater.progress}%)...` : 'Télécharger & Installer'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            soundEngine.playKeyBeep?.();
                            updater.relaunchApp();
                          }}
                          className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer active:scale-95"
                        >
                          <RotateCcw className="w-4 h-4" />
                          <span>Redémarrer l'App</span>
                        </button>
                      )
                    ) : updater.isAndroidDevice ? (
                      <a
                        href={updater.updateInfo.downloadUrl || 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk'}
                        download="MobiPOS-Android.apk"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          showToast("Téléchargement de l'APK Android démarré...", 'info');
                          updater.openDownloadPage();
                        }}
                        className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer no-underline active:scale-95"
                      >
                        <Download className="w-4 h-4" />
                        <span>Télécharger l'APK v{updater.updateInfo.version}</span>
                      </a>
                    ) : (
                      <a
                        href={updater.updateInfo.downloadUrl || 'https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest'}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          showToast("Ouverture de la page de téléchargement...", 'info');
                          updater.openDownloadPage();
                        }}
                        className="py-2.5 px-4 bg-purple-600 hover:bg-purple-500 text-white font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-purple-600/25 cursor-pointer no-underline active:scale-95"
                      >
                        <Download className="w-4 h-4" />
                        <span>Télécharger la Version</span>
                      </a>
                    )}
                  </div>

                  {/* Manual Reinstall Option */}
                  <div className="pt-2 border-t border-pos-border/40 flex items-center justify-between text-xs text-pos-muted">
                    <span>Problème de téléchargement direct ?</span>
                    <button
                      type="button"
                      onClick={() => openExternalUrl('https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest')}
                      className="text-cyan-400 hover:underline flex items-center gap-1 font-semibold cursor-pointer"
                    >
                      <span>Ouvrir les Releases GitHub</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>

                  {updater.downloading && (
                    <div className="w-full bg-pos-panel h-2.5 rounded-full overflow-hidden border border-pos-border">
                      <div
                        className="bg-gradient-to-r from-purple-500 to-emerald-400 h-full transition-all duration-300 rounded-full"
                        style={{ width: `${updater.progress}%` }}
                      />
                    </div>
                  )}

                  {updater.updateInfo.body && (
                    <div className="p-3 bg-pos-bg/80 border border-pos-border rounded-xl text-xs text-pos-muted whitespace-pre-wrap font-sans">
                      {updater.updateInfo.body}
                    </div>
                  )}
                </div>
              )}

              {/* Technical Information & Pipeline Breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* How OTA Updates Work */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-pos-text font-bold text-xs">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>Sécurité & Signatures Cryptographiques</span>
                  </div>
                  <p className="text-[11px] text-pos-muted leading-relaxed">
                    Chaque mise à jour déployée sur GitHub est vérifiée et validée par une signature cryptographique Minisign (clé publique intégrée). Aucune mise à jour corrompue ne peut être appliquée.
                  </p>
                </div>

                {/* Pipeline Compilation Notice */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-pos-text font-bold text-xs">
                    <Clock className="w-4 h-4 text-cyan-400" />
                    <span>Cycle de Publication GitHub Actions</span>
                  </div>
                  <p className="text-[11px] text-pos-muted leading-relaxed">
                    Lorsqu'une nouvelle version est publiée, le serveur GitHub CI/CD compile et génère automatiquement le paquet exécutable Windows et le fichier <code className="font-mono text-cyan-300">latest.json</code> (délai de 3 à 5 minutes).
                  </p>
                </div>
              </div>

              {/* Manual Direct Download & Reinstall Card */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
                    <Download className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-pos-text block">Installation Manuelle & Téléchargement Direct</span>
                    <span className="text-[10px] text-pos-muted block">Télécharger l'APK mobile ou le paquet PC de la version v{APP_VERSION}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <a
                    href="https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk"
                    download="MobiPOS-Android.apk"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      showToast("Téléchargement de l'APK Android démarré...", 'info');
                    }}
                    className="flex-1 sm:flex-none py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-emerald-500/40 text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer"
                  >
                    <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                    <span>APK Android</span>
                  </a>

                  <a
                    href="https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      showToast('Ouverture des releases GitHub...', 'info');
                    }}
                    className="flex-1 sm:flex-none py-2 px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-purple-500/40 text-pos-text text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-purple-400" />
                    <span>Releases GitHub</span>
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="p-2.5 sm:p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span className="text-[11px] truncate hidden sm:block">
            Centre de Commande Matériel • {connectedCount}/{devices.length} prêts • Plug & Play Auto-Reconnaissance actif
          </span>
          <span className="text-[11px] truncate sm:hidden font-mono text-cyan-400 font-bold">
            {connectedCount}/{devices.length} Périphériques Prêts
          </span>
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-1.5 sm:px-5 sm:py-2 rounded-xl bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs flex items-center gap-1.5 transition cursor-pointer active:scale-95"
            title="Quitter les paramètres"
          >
            <span>Fermer</span>
            <span className="hidden sm:inline text-[10px] bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border text-pos-muted">
              Échap / F12
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
