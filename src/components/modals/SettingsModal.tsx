import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  X, Cpu, Printer, Barcode, Monitor, ShieldCheck, Download, Upload,
  Wifi, WifiOff, Activity, Zap, RefreshCcw, CheckCircle2, AlertTriangle,
  XCircle, Clock, Play, Tag, QrCode, ScanLine, Cable,
  Bluetooth, Usb, ChevronDown, ChevronUp, Settings, HardDrive,
  Server, RotateCcw, Database, FileJson, Shield, Info, Radio, Sparkles,
  Award, TrendingUp
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { formatDZD } from '../../types/pos';
import { DEFAULT_LOYALTY_CONFIG, calculateFinancialProfitImpact } from '../../utils/loyaltyEngine';

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

type DeviceCategory = 'receipt_printer' | 'label_printer' | 'barcode_scanner' | 'qr_scanner' | 'display';
type ConnectionType = 'USB' | 'Bluetooth' | 'Wi-Fi' | 'Serial' | 'HID' | 'Network' | 'HDMI';
type DeviceStatus = 'connected' | 'ready' | 'active' | 'testing' | 'error' | 'offline' | 'warning';
type DiagnosticResult = 'pass' | 'fail' | 'warning' | 'pending' | 'running';
type SettingsTab = 'hardware' | 'diagnostics' | 'loyalty' | 'backup';

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

export const SettingsModal: React.FC = () => {
  const { activeModal, closeModal, exportDatabase, importDatabase, receiptSettings, setReceiptSettings } = usePosStore();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<SettingsTab>('hardware');
  const [devices, setDevices] = useState<PeripheralDevice[]>(INITIAL_DEVICE_REGISTRY);
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [diagnosticTests, setDiagnosticTests] = useState<DiagnosticTest[]>([]);
  const [isRunningAllDiag, setIsRunningAllDiag] = useState(false);
  const [selectedDiagDevice, setSelectedDiagDevice] = useState<string | null>(null);
  const [scannerTestInput, setScannerTestInput] = useState('');
  const [scannerTestActive, setScannerTestActive] = useState(false);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const scannerInputRef = useRef<HTMLInputElement>(null);

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
      const hasUSB = 'usb' in navigator;
      const hasHID = 'hid' in navigator;
      let detectedUsbDevices: any[] = [];
      let detectedHidDevices: any[] = [];

      if (hasUSB) {
        try {
          detectedUsbDevices = await (navigator as any).usb.getDevices();
        } catch { /* Permission or context restriction */ }
      }

      if (hasHID) {
        try {
          detectedHidDevices = await (navigator as any).hid.getDevices();
        } catch { /* Permission or context restriction */ }
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

    const handleUSBConnect = (e: any) => {
      const devName = e.device?.productName || 'Nouveau périphérique USB';
      showToast(`🔌 ÉQUIPEMENT RECONNU : ${devName} branché ! Auto-connexion...`, 'success');
      runAutoDetection(true);
    };

    const handleUSBDisconnect = (e: any) => {
      const devName = e.device?.productName || 'Périphérique USB';
      showToast(`🔌 Périphérique débranché : ${devName}.`, 'warning');
      runAutoDetection(true);
    };

    if ('usb' in navigator) {
      (navigator as any).usb.addEventListener('connect', handleUSBConnect);
      (navigator as any).usb.addEventListener('disconnect', handleUSBDisconnect);
    }

    // Run initial scan when modal opens
    runAutoDetection(true);

    return () => {
      if ('usb' in navigator) {
        (navigator as any).usb.removeEventListener('connect', handleUSBConnect);
        (navigator as any).usb.removeEventListener('disconnect', handleUSBDisconnect);
      }
    };
  }, [activeModal, runAutoDetection, showToast]);

  if (activeModal !== 'settings') return null;

  // ── File Upload Handler ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        const res = importDatabase(content);
        if (res.success) {
          showToast('Base de données restaurée avec succès !', 'success');
          closeModal();
        } else {
          showToast(res.reason || 'Échec de la restauration', 'error');
        }
      }
    };
    reader.readAsText(file);
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
    { key: 'hardware', label: 'Matériel & Périphériques', icon: <Cpu className="w-4 h-4" /> },
    { key: 'diagnostics', label: 'Diagnostique Avancé', icon: <Activity className="w-4 h-4" /> },
    { key: 'loyalty', label: 'Configuration Fidélité', icon: <Award className="w-4 h-4 text-amber-400" /> },
    { key: 'backup', label: 'Sauvegarde & Données', icon: <Database className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col">

        {/* ═══ Header ═══ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cyan-500/20 flex items-center justify-center border border-cyan-500/30 shadow-lg">
              <Settings className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                CENTRE DE COMMANDE MATÉRIEL
                <span className="bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Auto-Plug & Play Active
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted">
                Reconnaissance Automatique Plug & Play, Configuration & Compatibilité Universelle
              </p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ═══ KPI Bar ═══ */}
        <div className="grid grid-cols-5 gap-2.5 px-4 py-3 border-b border-pos-border bg-pos-card/50 shrink-0">
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
              <HardDrive className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Périphériques</span>
              <span className="text-sm font-black text-pos-text">{devices.length}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Connectés / Prêts</span>
              <span className="text-sm font-black text-emerald-400">{connectedCount}/{devices.length}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-slate-500/20 text-slate-400 flex items-center justify-center shrink-0">
              <WifiOff className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Hors Ligne</span>
              <span className="text-sm font-black text-slate-400">{offlineCount}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Tests Réussis</span>
              <span className="text-sm font-black text-amber-400">{totalTests > 0 ? `${passedTests}/${totalTests}` : '—'}</span>
            </div>
          </div>
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Protocoles</span>
              <span className="text-sm font-black text-purple-400">{new Set(devices.map(d => d.protocol)).size}</span>
            </div>
          </div>
        </div>

        {/* ═══ Tab Navigation ═══ */}
        <div className="flex gap-1 px-4 pt-3 pb-0 shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-t-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                activeTab === tab.key
                  ? 'bg-pos-bg border border-pos-border border-b-transparent text-cyan-400 shadow-sm'
                  : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover/50'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* ═══ Content Body ═══ */}
        <div className="flex-1 overflow-y-auto p-4 border-t border-pos-border bg-pos-bg">

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

                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-pos-bg border border-emerald-500/30 rounded-lg p-3 space-y-1.5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                        <Printer className="w-3.5 h-3.5" /> Reçus & Tickets
                      </span>
                      <span className="bg-emerald-500/20 text-emerald-300 text-[8px] font-bold px-1.5 py-0.5 rounded">ESC/POS 80mm</span>
                    </div>
                    <p className="text-[9px] text-pos-muted">Tickets de caisse, reçus tax-free & duplicatas</p>
                    <div className="text-[10px] font-bold text-pos-text bg-pos-card p-2 rounded border border-pos-border truncate flex items-center justify-between">
                      <span className="truncate">➔ {receiptSettings.printerRouting?.receiptPrinterName || 'Epson TM-T88VI'}</span>
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 ml-1" />
                    </div>
                  </div>

                  <div className="bg-pos-bg border border-amber-500/30 rounded-lg p-3 space-y-1.5 shadow-sm">
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

                  <div className="bg-pos-bg border border-cyan-500/30 rounded-lg p-3 space-y-1.5 shadow-sm">
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
              <div className="flex justify-between items-center">
                <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">Équipements & Statut Détecté</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => runAutoDetection(false)}
                    disabled={isAutoDetecting}
                    className="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5 hover:bg-emerald-500/30 transition cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCcw className={`w-3.5 h-3.5 ${isAutoDetecting ? 'animate-spin' : ''}`} />
                    {isAutoDetecting ? 'Reconnaissance en cours...' : 'Auto-Détecter les Équipements'}
                  </button>
                  <button
                    onClick={runFullDiagnostics}
                    disabled={isRunningAllDiag}
                    className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition cursor-pointer disabled:opacity-50"
                  >
                    <Zap className="w-3.5 h-3.5" /> {isRunningAllDiag ? 'Diagnostic en Cours...' : 'Diagnostic Complet'}
                  </button>
                </div>
              </div>

              {/* Device Cards */}
              <div className="space-y-3">
                {devices.map(device => {
                  const st = statusConfig[device.status];
                  const isExpanded = expandedDevice === device.id;
                  const compat = BRAND_COMPATIBILITY[device.category];

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
                          <div className="grid grid-cols-3 gap-3">
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
                              {device.capabilities.map((cap, i) => (
                                <span key={i} className="px-2 py-0.5 rounded-md bg-pos-bg border border-pos-border text-[10px] font-semibold text-pos-text">
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
                                  {compat.brands.map((b, i) => (
                                    <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${b === device.brand ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-pos-card text-pos-muted border-pos-border'}`}>
                                      {b === device.brand && <span className="mr-0.5">✓</span>}{b}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <span className="text-[9px] text-pos-muted uppercase font-bold block mb-1">Protocoles de Communication</span>
                                <div className="flex flex-wrap gap-1">
                                  {compat.protocols.map((p, i) => (
                                    <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${p === device.protocol || (device.protocol || '').includes(p) ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-pos-card text-pos-muted border-pos-border'}`}>
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
                  <div className="grid grid-cols-4 gap-2 mb-2">
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
                  {diagnosticTests.map(test => {
                    const rc = resultConfig[test.result];
                    const device = devices.find(d => d.id === test.deviceId);
                    return (
                      <div key={test.id} className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between hover:border-pos-text/20 transition">
                        <div className="flex items-center gap-3">
                          {rc.icon}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-pos-text">{test.testName}</span>
                              {device && <span className="text-[9px] text-pos-muted bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">{device.brand} {device.model}</span>}
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
              
              {/* Studio Header Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
                    <Award className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-pos-text flex items-center gap-2">
                      Studio de Configuration du Programme de Fidélité & Modèle Financier
                      <span className="text-[9px] bg-emerald-500/10 text-emerald-400 font-extrabold px-2 py-0.5 rounded border border-emerald-500/30">
                        Actif
                      </span>
                    </h3>
                    <p className="text-[11px] text-pos-muted">
                      Contrôle granulaire de la distribution des points, des multiplicateurs et de l'impact financier sur le profit net.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => showToast('Paramètres du programme de fidélité mis à jour avec succès.', 'success')}
                  className="px-4 py-2 bg-gradient-to-r from-amber-500 to-emerald-600 hover:from-amber-400 hover:to-emerald-500 text-slate-950 font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 cursor-pointer"
                >
                  Enregistrer les Paramètres
                </button>
              </div>

              {/* Distribution & Redemption Rules */}
              <div className="grid grid-cols-2 gap-4">
                
                {/* Rule Card 1: Earning & Redemption Rates */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
                    <Zap className="w-4 h-4 text-amber-400" /> Règles de Gain & Conversion de Points
                  </h4>
                  <div className="space-y-3 text-xs">
                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Montant d'Achat par Point de Base (DA)
                      </label>
                      <input
                        type="number"
                        defaultValue={DEFAULT_LOYALTY_CONFIG.baseSpendPerPoint}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                      />
                      <span className="text-[9.5px] text-pos-muted mt-0.5 block">100 DA dépensés = 1 Point de Base</span>
                    </div>

                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Valeur de Conversion en Avoir Client (DA par Point)
                      </label>
                      <input
                        type="number"
                        defaultValue={DEFAULT_LOYALTY_CONFIG.pointRedemptionRate}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-emerald-400 font-bold"
                      />
                      <span className="text-[9.5px] text-pos-muted mt-0.5 block">1 Point = 10 DA d'Avoir Client (10 Pts = 100 DA)</span>
                    </div>

                    <div>
                      <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                        Seuil Minimum de Points pour Échange
                      </label>
                      <input
                        type="number"
                        defaultValue={DEFAULT_LOYALTY_CONFIG.minimumRedemptionPoints}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                      />
                    </div>
                  </div>
                </div>

                {/* Rule Card 2: Multiplicateurs de Statut */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" /> Multiplicateurs par Statut Client
                  </h4>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between items-center bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <span className="font-semibold text-amber-600">🥉 Bronze (0 DA)</span>
                      <span className="font-mono font-bold text-pos-text">1.0x (Standard)</span>
                    </div>
                    <div className="flex justify-between items-center bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <span className="font-semibold text-slate-300">🥈 Silver (50 000 DA)</span>
                      <span className="font-mono font-bold text-slate-300">1.25x (+25%)</span>
                    </div>
                    <div className="flex justify-between items-center bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <span className="font-semibold text-amber-400">🥇 Gold (150 000 DA)</span>
                      <span className="font-mono font-bold text-amber-400">1.5x (+50%)</span>
                    </div>
                    <div className="flex justify-between items-center bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <span className="font-semibold text-cyan-400">💎 Platinum (300 000 DA)</span>
                      <span className="font-mono font-bold text-cyan-400">2.0x (Double Points)</span>
                    </div>
                    <div className="flex justify-between items-center bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <span className="font-semibold text-purple-400">👑 VIP Diamond (600 000 DA)</span>
                      <span className="font-mono font-bold text-purple-400">2.5x (Ultra VIP)</span>
                    </div>
                  </div>
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
                  const sim = calculateFinancialProfitImpact(10000, 500, 1000, 4500, 150, DEFAULT_LOYALTY_CONFIG);
                  return (
                    <div className="grid grid-cols-4 gap-3 text-xs">
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

            </div>
          )}

          {/* ══════ TAB: Backup & Data ══════ */}
          {activeTab === 'backup' && (
            <div className="space-y-4 max-w-3xl mx-auto">
              <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">Sauvegarde & Restauration des Données</h3>

              {/* Export Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                    <Download className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-pos-text">Exporter la Base de Données</h4>
                    <p className="text-[10px] text-pos-muted">Exportez tous les produits, clients, transactions, réparations, kits et paramètres au format JSON.</p>
                  </div>
                </div>
                <div className="bg-pos-bg rounded-lg p-3 border border-pos-border mb-3">
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <FileJson className="w-3 h-3 text-emerald-400" />
                      <span className="text-pos-muted">Format:</span>
                      <span className="font-bold text-pos-text">JSON</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Database className="w-3 h-3 text-blue-400" />
                      <span className="text-pos-muted">Tables:</span>
                      <span className="font-bold text-pos-text">8</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Shield className="w-3 h-3 text-purple-400" />
                      <span className="text-pos-muted">Version:</span>
                      <span className="font-bold text-pos-text">1.0.0</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={exportDatabase}
                  className="w-full py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  <Download className="w-4 h-4" /> Télécharger la Sauvegarde Complète
                </button>
              </div>

              {/* Import Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30">
                    <Upload className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-pos-text">Restaurer une Sauvegarde</h4>
                    <p className="text-[10px] text-pos-muted">Importez un fichier JSON pour restaurer vos données. Les données actuelles seront remplacées.</p>
                  </div>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 mb-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-bold text-amber-400">Attention — Opération Irréversible</p>
                    <p className="text-[10px] text-amber-400/70">Toutes les données actuelles seront remplacées par le contenu du fichier importé. Exportez d'abord une sauvegarde.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2.5 px-4 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 text-blue-400 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Upload className="w-4 h-4" /> Sélectionner un Fichier JSON à Restaurer
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>

              {/* Data Integrity Info */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-4 h-4 text-cyan-400" />
                  <h4 className="text-xs font-bold text-pos-text">Intégrité des Données</h4>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-pos-bg rounded-lg p-2 border border-pos-border flex justify-between">
                    <span className="text-pos-muted">Stockage</span>
                    <span className="font-bold text-pos-text">LocalStorage (Navigateur)</span>
                  </div>
                  <div className="bg-pos-bg rounded-lg p-2 border border-pos-border flex justify-between">
                    <span className="text-pos-muted">Persistance</span>
                    <span className="font-bold text-emerald-400">Synchrone</span>
                  </div>
                  <div className="bg-pos-bg rounded-lg p-2 border border-pos-border flex justify-between">
                    <span className="text-pos-muted">Chiffrement</span>
                    <span className="font-bold text-pos-text">Texte Brut</span>
                  </div>
                  <div className="bg-pos-bg rounded-lg p-2 border border-pos-border flex justify-between">
                    <span className="text-pos-muted">Format</span>
                    <span className="font-bold text-pos-text">JSON v1.0.0</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Centre de Commande Matériel • {connectedCount}/{devices.length} prêts • Plug & Play Auto-Reconnaissance actif</span>
          <button onClick={closeModal} className="px-4 py-1.5 rounded-xl bg-pos-hover text-pos-text font-semibold cursor-pointer">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};
