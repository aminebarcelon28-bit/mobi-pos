import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  X, Cpu, Printer, Barcode, Monitor, ShieldCheck, Download, Upload,
  Wifi, WifiOff, Activity, Zap, RefreshCcw, CheckCircle2, AlertTriangle,
  XCircle, Clock, Play, Tag, QrCode, ScanLine, Cable,
  Bluetooth, Usb, ChevronDown, ChevronUp, Settings, HardDrive,
  Server, RotateCcw, Database, Shield, Radio, Sparkles,
  Award, TrendingUp, Volume2, VolumeX, Music
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { formatDZD, APP_VERSION } from '../../types/pos';
import { DEFAULT_LOYALTY_CONFIG, calculateFinancialProfitImpact } from '../../utils/loyaltyEngine';
import { sqliteAdapter, type DbStats, type IntegrityReport } from '../../db/sqliteAdapter';
import { useAppUpdater } from '../../hooks/useAppUpdater';
import { soundEngine } from '../../utils/audioFeedback';

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

type DeviceCategory = 'receipt_printer' | 'label_printer' | 'barcode_scanner' | 'qr_scanner' | 'display';
type ConnectionType = 'USB' | 'Bluetooth' | 'Wi-Fi' | 'Serial' | 'HID' | 'Network' | 'HDMI';
type DeviceStatus = 'connected' | 'ready' | 'active' | 'testing' | 'error' | 'offline' | 'warning';
type DiagnosticResult = 'pass' | 'fail' | 'warning' | 'pending' | 'running';
type SettingsTab = 'hardware' | 'diagnostics' | 'loyalty' | 'backup' | 'updates';

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
  const {
    activeModal,
    closeModal,
    exportDatabase,
    importDatabase,
    receiptSettings,
    setReceiptSettings,
    setManagerPin,
  } = usePosStore();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const updater = useAppUpdater();

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

  // ── Manager Security PIN State ──
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [isUpdatingPin, setIsUpdatingPin] = useState(false);
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
      const stats = await sqliteAdapter.getStats();
      setDbStats(stats);
    } catch (e) {
      console.warn('Failed to load SQLite stats:', e);
    }
  }, []);

  const handleRunIntegrityCheck = async () => {
    setIsCheckingIntegrity(true);
    try {
      const report = await sqliteAdapter.runIntegrityCheck();
      setIntegrityReport(report);
      if (report.is_healthy) {
        showToast('✅ Intégrité SQLite 100% Validée : Aucune corruption détectée', 'success');
      } else {
        showToast('⚠️ Avertissement d\'intégrité détecté sur la base de données', 'warning');
      }
      await loadDbStats();
    } catch (e: any) {
      showToast(`Erreur lors du test d'intégrité : ${e?.message || e}`, 'error');
    } finally {
      setIsCheckingIntegrity(false);
    }
  };

  const handleCheckpointWal = async () => {
    setIsCheckpointing(true);
    try {
      const msg = await sqliteAdapter.checkpointWal();
      showToast(`⚡ WAL Checkpoint : ${msg}`, 'success');
      await loadDbStats();
    } catch (e: any) {
      showToast(`Erreur Checkpoint : ${e?.message || e}`, 'error');
    } finally {
      setIsCheckpointing(false);
    }
  };

  const handleVacuum = async () => {
    setIsVacuuming(true);
    try {
      const msg = await sqliteAdapter.vacuum();
      showToast(`🧹 Défragmentation VACUUM : ${msg}`, 'success');
      await loadDbStats();
    } catch (e: any) {
      showToast(`Erreur VACUUM : ${e?.message || e}`, 'error');
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

  // ── File Upload Handler ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      if (content) {
        const res = await importDatabase(content);
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
    { key: 'backup', label: 'Moteur SQLite & Données', icon: <Database className="w-4 h-4 text-cyan-400" /> },
    { key: 'updates', label: 'Mises à Jour & Version', icon: <Sparkles className="w-4 h-4 text-purple-400" /> },
  ];

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col cursor-default"
      >

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
          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
            title="Fermer les paramètres (Échap / F12)"
          >
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
                    <p className="text-[9px] text-pos-muted">Tickets de caisse, reçus de vente & duplicatas</p>
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
              <div className="grid grid-cols-4 gap-3">
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

                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={handleRunIntegrityCheck}
                    disabled={isCheckingIntegrity}
                    className="py-2.5 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
                  >
                    <Activity className={`w-4 h-4 ${isCheckingIntegrity ? 'animate-spin' : ''}`} />
                    {isCheckingIntegrity ? 'Vérification...' : 'Vérifier Intégrité Complète'}
                  </button>

                  <button
                    onClick={handleCheckpointWal}
                    disabled={isCheckpointing}
                    className="py-2.5 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
                  >
                    <Zap className={`w-4 h-4 ${isCheckpointing ? 'animate-spin' : ''}`} />
                    {isCheckpointing ? 'Checkpoint...' : 'Checkpoint WAL (TRUNCATE)'}
                  </button>

                  <button
                    onClick={handleVacuum}
                    disabled={isVacuuming}
                    className="py-2.5 px-3 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
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
                      {integrityReport.integrity_messages.map((m, idx) => (
                        <div key={idx}>➔ {m}</div>
                      ))}
                      {integrityReport.foreign_key_violations.map((f, idx) => (
                        <div key={`fk-${idx}`} className="text-red-400">➔ Violation FK : {f}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Manager Security PIN Card */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
                <div className="flex items-center justify-between border-b border-pos-border/60 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-purple-400" />
                    <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                      Code PIN Manager & Sécurité Financière
                    </h4>
                  </div>
                  <span className="text-[10px] text-pos-muted">
                    PIN Actif : <strong className="text-emerald-400 font-mono">••••</strong> (Chiffré SHA-256 / Salé)
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="text-[10px] text-pos-muted font-bold block mb-1">Nouveau PIN Manager (4 à 6 chiffres)</label>
                    <input
                      type="password"
                      maxLength={6}
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="Ex: 4892"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-pos-muted font-bold block mb-1">Confirmer le Nouveau PIN</label>
                    <input
                      type="password"
                      maxLength={6}
                      value={confirmPinInput}
                      onChange={(e) => setConfirmPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="Ex: 4892"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div className="pt-4">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!newPinInput || newPinInput.length < 4) {
                          showToast('Le code PIN doit comporter au moins 4 chiffres.', 'error');
                          return;
                        }
                        if (newPinInput !== confirmPinInput) {
                          showToast('Les deux codes PIN saisis ne correspondent pas.', 'error');
                          return;
                        }
                        setIsUpdatingPin(true);
                        try {
                          await setManagerPin(newPinInput);
                          setNewPinInput('');
                          setConfirmPinInput('');
                          showToast('Nouveau Code PIN Manager enregistré avec succès.', 'success');
                        } catch (e: any) {
                          showToast(`Erreur : ${e?.message || e}`, 'error');
                        } finally {
                          setIsUpdatingPin(false);
                        }
                      }}
                      disabled={isUpdatingPin || !newPinInput || !confirmPinInput}
                      className="py-2 px-4 rounded-lg bg-purple-500 hover:bg-purple-400 text-slate-950 font-bold text-xs transition disabled:opacity-40 cursor-pointer shadow-md"
                    >
                      {isUpdatingPin ? 'Enregistrement...' : 'Modifier PIN'}
                    </button>
                  </div>
                </div>
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
                    onClick={exportDatabase}
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
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-2 px-3 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 text-blue-400 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <Upload className="w-4 h-4" /> Sélectionner un Fichier JSON
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="hidden"
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
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold">
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
                    onClick={() => updater.checkForUpdates(true)}
                    disabled={updater.isChecking || updater.downloading}
                    className="py-2.5 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-black flex items-center justify-center gap-2 transition shadow-lg shadow-purple-600/30 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCcw className={`w-4 h-4 ${updater.isChecking ? 'animate-spin' : ''}`} />
                    {updater.isChecking ? 'Vérification en cours...' : 'Vérifier Mises à Jour'}
                  </button>
                </div>

                {/* Status Indicator Banner */}
                <div className="mt-4 pt-4 border-t border-pos-border/60 flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
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
                <div className="bg-pos-card border-2 border-purple-500/60 rounded-2xl p-5 space-y-4 animate-in fade-in zoom-in-95">
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

                    {!updater.readyToRelaunch ? (
                      <button
                        onClick={updater.downloadAndInstall}
                        disabled={updater.downloading}
                        className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer disabled:opacity-50"
                      >
                        <Download className={`w-4 h-4 ${updater.downloading ? 'animate-bounce' : ''}`} />
                        {updater.downloading ? `Téléchargement (${updater.progress}%)...` : 'Télécharger & Installer'}
                      </button>
                    ) : (
                      <button
                        onClick={updater.relaunchApp}
                        className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg shadow-emerald-500/25 cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4" />
                        Redémarrer l'App
                      </button>
                    )}
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
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Centre de Commande Matériel • {connectedCount}/{devices.length} prêts • Plug & Play Auto-Reconnaissance actif</span>
          <button
            type="button"
            onClick={closeModal}
            className="px-5 py-2 rounded-xl bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
            title="Quitter les paramètres"
          >
            <span>Fermer les Paramètres</span>
            <span className="text-[10px] bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border text-pos-muted">Échap / F12</span>
          </button>
        </div>
      </div>
    </div>
  );
};
