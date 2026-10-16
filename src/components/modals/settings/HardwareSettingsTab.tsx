import React, { useState, useEffect, useRef } from 'react';
import {
  Cpu, Printer, Barcode, Monitor, HardDrive, Zap, RefreshCcw, CheckCircle2,
  AlertTriangle, XCircle, Clock, Usb, Bluetooth, Wifi, Radio, Server,
  Sparkles, Tag, Layers, ChevronDown, ChevronUp, Music
} from 'lucide-react';
import type { ReceiptSettings, DiscoveredDevice, PrinterRoutingConfig } from '../../../types/pos';
import { scanHardwareDevices, openCashDrawer, updateCustomerDisplayVfd } from '../../../api/hardware';
import { directPrintRawReceipt } from '../../../utils/escpos';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';

interface HardwareSettingsTabProps {
  receiptDraft: ReceiptSettings;
  scheduleReceiptSave: (next: ReceiptSettings) => void;
}

export const HardwareSettingsTab: React.FC<HardwareSettingsTabProps> = ({
  receiptDraft,
  scheduleReceiptSave,
}) => {
  const { showToast } = useToast();
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);

  // VFD Test State
  const [vfdPort, setVfdPort] = useState<string>('COM1');
  const [vfdLine1, setVfdLine1] = useState<string>('MOBI-POS SYSTEM');
  const [vfdLine2, setVfdLine2] = useState<string>('TOTAL: 0.00 DA');
  const [isVfdTesting, setIsVfdTesting] = useState<boolean>(false);

  // Mobile Printer Config Card State
  const [mobileConfig, setMobileConfig] = useState<import('../../../types/pos').MobilePrinterConfig | null>(null);
  const [btDevices, setBtDevices] = useState<Array<{ name: string; mac: string }>>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [mobileTesting, setMobileTesting] = useState(false);
  const [mobileMsg, setMobileMsg] = useState('');

  // Scanner test input
  const [scannerTestInput, setScannerTestInput] = useState<string>('');
  const [scannerLog, setScannerLog] = useState<Array<{ barcode: string; time: string }>>([]);

  const currentRouting: PrinterRoutingConfig = receiptDraft.printerRouting || {
    receiptPrinterId: 'default',
    receiptPrinterName: receiptDraft.printerName || 'Imprimante Reçu Standard',
    labelPrinterId: 'default',
    labelPrinterName: 'Imprimante Étiquettes Standard',
    reportPrinterId: 'default',
    reportPrinterName: 'Imprimante Rapports Standard',
    autoRoutingEnabled: true,
  };

  const updateRouting = (patch: Partial<PrinterRoutingConfig>) => {
    const nextRouting: PrinterRoutingConfig = { ...currentRouting, ...patch };
    scheduleReceiptSave({
      ...receiptDraft,
      printerRouting: nextRouting,
      printerName: nextRouting.receiptPrinterName || receiptDraft.printerName,
    });
  };

  const handleScanHardware = async () => {
    setIsScanning(true);
    try {
      const list = await scanHardwareDevices<DiscoveredDevice>();
      setDiscoveredDevices(list || []);
      setLastScanTime(new Date().toLocaleTimeString('fr-FR'));
      showToast(`Scan matériel terminé : ${(list || []).length} périphérique(s) identifié(s).`, 'success');
    } catch (err) {
      console.error('[Hardware Scan Failed]', err);
      showToast('Scan matériel impossible ou non supporté sur ce système.', 'info');
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const runScan = async () => {
      try {
        const list = await scanHardwareDevices<DiscoveredDevice>();
        if (!cancelled) {
          setDiscoveredDevices(list || []);
          setLastScanTime(new Date().toLocaleTimeString('fr-FR'));
        }
      } catch (err) {
        console.error('[Hardware Scan Failed]', err);
      }
    };
    void runScan();
    import('../../../utils/mobilePrinter')
      .then((m) => {
        if (!cancelled) setMobileConfig(m.loadMobilePrinter());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTestCashDrawer = async () => {
    try {
      const printer = currentRouting.receiptPrinterName || receiptDraft.printerName || 'default';
      await openCashDrawer(printer);
      soundEngine.playCashDrawer?.();
      showToast('Commande d’ouverture du tiroir-caisse envoyée !', 'success');
    } catch (err) {
      console.error('[Cash Drawer Error]', err);
      soundEngine.playCashDrawer?.();
      showToast('Signal tiroir envoyé (simulation audio).', 'info');
    }
  };

  const handleTestPrintReceipt = async () => {
    try {
      const printer = currentRouting.receiptPrinterName || receiptDraft.printerName || 'default';
      const sampleText = `\n================================\n   ${receiptDraft.storeName || 'MOBI-POS'}\n   TEST D'IMPRESSION RECU\n================================\nDate: ${new Date().toLocaleString('fr-FR')}\nImprimante: ${printer}\nFormat: ${receiptDraft.paperWidth || '80mm'}\nStatut: OPERATIONNEL\n\n\n\n\n`;
      const encoder = new TextEncoder();
      await directPrintRawReceipt(encoder.encode(sampleText));
      showToast(`Page de test envoyée à l'imprimante reçu (${printer}).`, 'success');
    } catch (err) {
      console.error('[Test Print Error]', err);
      showToast("Erreur lors de l'envoi du test d'impression.", 'error');
    }
  };

  const handleTestVfd = async () => {
    setIsVfdTesting(true);
    try {
      await updateCustomerDisplayVfd(vfdPort, vfdLine1, vfdLine2);
      showToast(`Lignes VFD envoyées sur le port ${vfdPort}.`, 'success');
    } catch (err) {
      console.error('[VFD Error]', err);
      showToast(`Échec de communication série VFD sur ${vfdPort}.`, 'warning');
    } finally {
      setIsVfdTesting(false);
    }
  };

  const handleBtScan = async () => {
    setBtScanning(true);
    setMobileMsg('');
    try {
      const { listBondedBluetoothPrinters } = await import('../../../utils/mobilePrinter');
      const devices = await listBondedBluetoothPrinters();
      setBtDevices(devices);
      setMobileMsg(
        devices.length === 0
          ? "Aucune imprimante appairée — appairez-la d'abord dans les réglages Bluetooth d'Android."
          : `${devices.length} appareil(s) Bluetooth détecté(s).`
      );
    } catch {
      setMobileMsg("Bluetooth inaccessible — autorisez l'accès puis réessayez.");
    } finally {
      setBtScanning(false);
    }
  };

  const handleMobileTest = async () => {
    setMobileTesting(true);
    setMobileMsg('');
    try {
      const { buildMobileTestPage, printBytesViaMobilePrinter } = await import('../../../utils/mobilePrinter');
      const target = mobileConfig?.connection === 'bluetooth' ? `Bluetooth ${mobileConfig.bluetoothMac}` : `Wi-Fi ${mobileConfig?.wifiHost}:${mobileConfig?.wifiPort}`;
      const result = await printBytesViaMobilePrinter(buildMobileTestPage(receiptDraft.storeName || 'MOBI-POS', target));
      const okMsg = '✅ Page de test envoyée — vérifiez l’imprimante mobile.';
      const koMsg = "❌ Échec d'envoi — vérifiez l'adresse IP / l'appairage.";
      setMobileMsg(result.sent ? okMsg : koMsg);
      showToast(result.sent ? okMsg : koMsg, result.sent ? 'success' : 'error');
    } catch {
      setMobileMsg("❌ Échec d'envoi — vérifiez la configuration.");
    } finally {
      setMobileTesting(false);
    }
  };

  const updateMobileConfig = (patch: Partial<import('../../../types/pos').MobilePrinterConfig>) => {
    const base = mobileConfig || {
      enabled: false,
      connection: 'wifi' as const,
      wifiHost: '192.168.1.50',
      wifiPort: 9100,
      bluetoothName: '',
      bluetoothMac: '',
      labelProtocol: 'ESCPOS' as const,
    };
    const next = { ...base, ...patch };
    setMobileConfig(next);
    import('../../../utils/mobilePrinter')
      .then((m) => m.saveMobilePrinter(next))
      .catch(console.error);
  };

  return (
    <div className="space-y-4 max-w-4xl">
      {/* ── Auto-Discovery & Detected Hardware ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <h4 className="text-xs font-bold text-pos-text">Périphériques Détectés & Ports Matériels</h4>
          </div>
          <div className="flex items-center gap-2">
            {lastScanTime && (
              <span className="text-[10px] text-pos-muted">Dernier scan : {lastScanTime}</span>
            )}
            <button
              type="button"
              onClick={handleScanHardware}
              disabled={isScanning}
              className="px-3 py-1.5 rounded-lg bg-pos-panel hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-1.5 transition cursor-pointer active:scale-95 disabled:opacity-50"
            >
              <RefreshCcw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-emerald-400' : ''}`} />
              <span>{isScanning ? 'Scan en cours...' : 'Actualiser'}</span>
            </button>
          </div>
        </div>

        {discoveredDevices.length === 0 ? (
          <div className="p-4 rounded-xl bg-pos-bg border border-pos-border text-center text-pos-muted text-xs">
            {isScanning ? (
              <span className="flex items-center justify-center gap-2">
                <RefreshCcw className="w-4 h-4 animate-spin text-emerald-400" />
                Détection des imprimantes spooler et ports série en cours...
              </span>
            ) : (
              <span>Aucun périphérique matériel dédié n'est actuellement branché ou détecté par le système.</span>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            {discoveredDevices.map((dev) => (
              <div
                key={dev.id}
                className="p-3 rounded-xl bg-pos-bg border border-pos-border flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-pos-panel border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                    {dev.isUsb ? <Usb className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0">
                    <h5 className="text-xs font-bold text-pos-text truncate">{dev.name}</h5>
                    <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                      <span className="font-semibold text-emerald-400 uppercase">{dev.category}</span>
                      <span>•</span>
                      <span className="font-mono">{dev.portOrQueue}</span>
                    </div>
                  </div>
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  Prêt
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Printer Routing Configuration Card ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-4 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-cyan-400" />
            <h4 className="text-xs font-bold text-pos-text">Routage Intelligent des Imprimantes</h4>
          </div>
          <label className="flex items-center gap-2 text-xs text-pos-muted cursor-pointer">
            <input
              type="checkbox"
              checked={currentRouting.autoRoutingEnabled}
              onChange={(e) => updateRouting({ autoRoutingEnabled: e.target.checked })}
              className="rounded border-pos-border text-cyan-500 focus:ring-0"
            />
            <span className="font-bold text-pos-text">Routage Automatique</span>
          </label>
        </div>
        <p className="text-[11px] text-pos-muted">
          Assignez chaque type de document à son imprimante dédiée (Ticket de caisse thermique, Étiquettes code-barres, Factures & Rapports A4).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          {/* Receipt Printer */}
          <div className="p-3.5 rounded-xl bg-pos-bg border border-pos-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Printer className="w-3.5 h-3.5 text-purple-400" /> Imprimante Tickets
              </span>
              <span className="text-[9px] font-mono font-bold text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">
                80/58mm
              </span>
            </div>
            <input
              type="text"
              value={currentRouting.receiptPrinterName || ''}
              onChange={(e) => updateRouting({ receiptPrinterName: e.target.value })}
              placeholder="ex: POS-80, TM-T88VI, Default"
              className="w-full bg-pos-panel border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-bold focus:border-purple-400 focus:outline-none"
            />
            <div className="flex gap-1.5 pt-1">
              <button
                type="button"
                onClick={handleTestPrintReceipt}
                className="flex-1 py-1 px-2 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-[10px] font-bold text-purple-300 transition cursor-pointer"
              >
                Test Reçu
              </button>
              <button
                type="button"
                onClick={handleTestCashDrawer}
                className="py-1 px-2 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-[10px] font-bold text-amber-300 transition cursor-pointer flex items-center gap-1"
                title="Tester ouverture tiroir-caisse"
              >
                <Zap className="w-3 h-3 text-amber-400" /> Tiroir
              </button>
            </div>
          </div>

          {/* Label Printer */}
          <div className="p-3.5 rounded-xl bg-pos-bg border border-pos-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-emerald-400" /> Imprimante Étiquettes
              </span>
              <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                TSPL / ZPL
              </span>
            </div>
            <input
              type="text"
              value={currentRouting.labelPrinterName || ''}
              onChange={(e) => updateRouting({ labelPrinterName: e.target.value })}
              placeholder="ex: TSC-TE200, Zebra ZD421"
              className="w-full bg-pos-panel border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-bold focus:border-emerald-400 focus:outline-none"
            />
            <p className="text-[10px] text-pos-muted pt-1">
              Utilisée pour l'impression de codes-barres et étiquettes prix.
            </p>
          </div>

          {/* Report Printer */}
          <div className="p-3.5 rounded-xl bg-pos-bg border border-pos-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" /> Imprimante Rapports
              </span>
              <span className="text-[9px] font-mono font-bold text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                A4 / Bureau
              </span>
            </div>
            <input
              type="text"
              value={currentRouting.reportPrinterName || ''}
              onChange={(e) => updateRouting({ reportPrinterName: e.target.value })}
              placeholder="ex: HP LaserJet, Canon LBP"
              className="w-full bg-pos-panel border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-bold focus:border-cyan-400 focus:outline-none"
            />
            <p className="text-[10px] text-pos-muted pt-1">
              Utilisée pour les factures A4, bons de commande et rapports Z.
            </p>
          </div>
        </div>
      </div>

      {/* ── Customer Display (VFD) Card ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Monitor className="w-4 h-4 text-blue-400" />
            <h4 className="text-xs font-bold text-pos-text">Afficheur Client Série (VFD 2×20)</h4>
          </div>
          <span className="text-[10px] font-mono font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
            9600 8N1
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">Port Série / COM :</label>
            <input
              type="text"
              value={vfdPort}
              onChange={(e) => setVfdPort(e.target.value)}
              placeholder="ex: COM1, COM3, /dev/ttyUSB0"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono font-bold focus:border-blue-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">Ligne 1 (Max 20 car.) :</label>
            <input
              type="text"
              maxLength={20}
              value={vfdLine1}
              onChange={(e) => setVfdLine1(e.target.value)}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-blue-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">Ligne 2 (Max 20 car.) :</label>
            <div className="flex gap-2">
              <input
                type="text"
                maxLength={20}
                value={vfdLine2}
                onChange={(e) => setVfdLine2(e.target.value)}
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleTestVfd}
                disabled={isVfdTesting}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shrink-0 transition active:scale-95 cursor-pointer disabled:opacity-50"
              >
                {isVfdTesting ? '...' : 'Envoyer'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile Companion Wi-Fi & Bluetooth Printer Card ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-amber-400" />
            <h4 className="text-xs font-bold text-pos-text">Imprimante Mobile Android (Wi-Fi & Bluetooth)</h4>
          </div>
          <label className="flex items-center gap-2 text-xs text-pos-muted cursor-pointer">
            <input
              type="checkbox"
              checked={mobileConfig?.enabled ?? false}
              onChange={(e) => updateMobileConfig({ enabled: e.target.checked })}
              className="rounded border-pos-border text-amber-500 focus:ring-0"
            />
            <span className="font-bold text-pos-text">Activer Impression Mobile</span>
          </label>
        </div>

        {mobileConfig?.enabled && (
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateMobileConfig({ connection: 'wifi' })}
                className={`py-2 px-3 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  mobileConfig.connection === 'wifi'
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                    : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <Wifi className="w-3.5 h-3.5" /> <span>Réseau Wi-Fi (TCP:9100)</span>
              </button>
              <button
                type="button"
                onClick={() => updateMobileConfig({ connection: 'bluetooth' })}
                className={`py-2 px-3 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  mobileConfig.connection === 'bluetooth'
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                    : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <Bluetooth className="w-3.5 h-3.5" /> <span>Bluetooth SPP / RFCOMM</span>
              </button>
            </div>

            {mobileConfig.connection === 'wifi' ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Adresse IP de l'imprimante :</label>
                  <input
                    type="text"
                    value={mobileConfig.wifiHost || ''}
                    onChange={(e) => updateMobileConfig({ wifiHost: e.target.value })}
                    placeholder="192.168.1.50"
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Port TCP :</label>
                  <input
                    type="number"
                    value={mobileConfig.wifiPort || 9100}
                    onChange={(e) => updateMobileConfig({ wifiPort: parseInt(e.target.value) || 9100 })}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-pos-muted font-bold">Appareils Bluetooth Appairés :</span>
                  <button
                    type="button"
                    onClick={handleBtScan}
                    disabled={btScanning}
                    className="text-xs text-amber-400 font-bold hover:underline cursor-pointer"
                  >
                    {btScanning ? 'Recherche...' : 'Rechercher les imprimantes'}
                  </button>
                </div>
                {btDevices.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {btDevices.map((dev) => (
                      <button
                        key={dev.mac}
                        type="button"
                        onClick={() => updateMobileConfig({ bluetoothName: dev.name, bluetoothMac: dev.mac })}
                        className={`p-2 rounded-lg border text-left text-xs transition cursor-pointer ${
                          mobileConfig.bluetoothMac === dev.mac
                            ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                            : 'bg-pos-bg border-pos-border text-pos-text hover:bg-pos-panel'
                        }`}
                      >
                        <div className="truncate">{dev.name}</div>
                        <div className="text-[10px] text-pos-muted font-mono">{dev.mac}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-pos-muted">{mobileMsg}</span>
              <button
                type="button"
                onClick={handleMobileTest}
                disabled={mobileTesting}
                className="py-1.5 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition cursor-pointer active:scale-95 disabled:opacity-50"
              >
                {mobileTesting ? 'Envoi...' : 'Tester Imprimante Mobile'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Audio Feedback & Sound FX Card ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-purple-400" />
          <h4 className="text-xs font-bold text-pos-text">Effets Sonores & Retours Audio</h4>
        </div>
        <p className="text-[11px] text-pos-muted">
          Testez les signaux sonores émis lors de la saisie au clavier, la lecture code-barres et l'encaissement.
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => soundEngine.playKeyBeep?.()}
            className="px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-text font-medium transition cursor-pointer"
          >
            Bip Clavier
          </button>
          <button
            type="button"
            onClick={() => soundEngine.playSuccess?.()}
            className="px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-emerald-300 font-medium transition cursor-pointer flex items-center gap-1"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Vente Réussie
          </button>
          <button
            type="button"
            onClick={() => soundEngine.playError?.()}
            className="px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-red-300 font-medium transition cursor-pointer flex items-center gap-1"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> Alerte Erreur
          </button>
          <button
            type="button"
            onClick={() => soundEngine.playCashDrawer?.()}
            className="px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-amber-300 font-medium transition cursor-pointer flex items-center gap-1"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" /> Clic Tiroir
          </button>
        </div>
      </div>
    </div>
  );
};
