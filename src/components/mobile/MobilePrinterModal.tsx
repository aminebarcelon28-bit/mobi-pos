import React, { useState, useCallback } from 'react';
import {
  Printer,
  Wifi,
  Bluetooth,
  Save,
  X,
  PlayCircle,
  RotateCw,
} from 'lucide-react';
import {
  loadMobilePrinter,
  saveMobilePrinter,
  printBytesViaMobilePrinter,
  listBondedBluetoothPrinters,
  type BondedBtDevice,
} from '../../utils/mobilePrinter';
import type { MobilePrinterConfig, MobileLabelProtocol } from '../../types/pos';
import { EscPosBuilder } from '../../utils/escpos';
import { soundEngine } from '../../utils/audioFeedback';
import { useToast } from '../ui/Toast';
import { useTranslation, Bdi } from '../../i18n';
import { useRegisterMobileBackHandler } from '../../hooks/useMobileBackNavigation';

interface MobilePrinterModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MobilePrinterModal: React.FC<MobilePrinterModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [config, setConfig] = useState<MobilePrinterConfig>(loadMobilePrinter);
  const [bondedDevices, setBondedDevices] = useState<BondedBtDevice[]>([]);
  const [isScanningBt, setIsScanningBt] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  useRegisterMobileBackHandler(isOpen, onClose, 'mobile-printer');

  // Reload config whenever modal opens
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setConfig(loadMobilePrinter());
    }
  }


  const handleScanBluetooth = useCallback(async () => {
    soundEngine.playKeyBeep?.();
    setIsScanningBt(true);
    try {
      const devices = await listBondedBluetoothPrinters();
      setBondedDevices(devices);
      if (devices.length > 0) {
        showToast(`${devices.length} appareil(s) Bluetooth détecté(s)`, 'info');
      } else {
        showToast('Aucun appareil Bluetooth associé dans les paramètres Android.', 'info');
      }
    } catch (err) {
      console.warn('[MobilePrinterModal] Bluetooth scan failed:', err);
      showToast('Impossible de lire les périphériques Bluetooth.', 'warning');
    } finally {
      setIsScanningBt(false);
    }
  }, [showToast]);

  const handleSave = () => {
    soundEngine.playSuccess?.();
    saveMobilePrinter(config);
    showToast('Configuration imprimante enregistrée avec succès !', 'success');
    onClose();
  };

  const handleTestPrint = async () => {
    soundEngine.playKeyBeep?.();
    setIsTesting(true);
    try {
      const builder = new EscPosBuilder()
        .init()
        .align('center')
        .bold(true)
        .doubleHeight(true)
        .text('MobiPOS THERMAL TEST')
        .newline()
        .doubleHeight(false)
        .bold(false)
        .text('--- Impression Mobile Directe ---')
        .newline()
        .text(`Date : ${new Date().toLocaleString('fr-FR')}`)
        .newline()
        .text(`Mode : ${config.connection.toUpperCase()} | Port : ${config.wifiPort}`)
        .newline(2)
        .bold(true)
        .text('CONNEXION ET IMPRESSION VALIDEES')
        .newline(3)
        .cut();

      const bytes = builder.build();
      // Temporarily save to ensure current settings are used by test
      saveMobilePrinter(config);
      const res = await printBytesViaMobilePrinter(bytes);

      if (res.sent) {
        soundEngine.playSuccess?.();
        showToast('Ticket test envoyé avec succès à l\'imprimante !', 'success');
      } else if (res.reason === 'disabled') {
        showToast('Activez l\'option "Impression directe mobile" pour tester.', 'warning');
      } else {
        soundEngine.playError?.();
        showToast(`Échec du test : ${res.reason || 'Erreur inconnue'}`, 'error');
      }
    } catch (err) {
      console.error('[MobilePrinterModal] Test print failed:', err);
      soundEngine.playError?.();
      showToast('Échec de communication avec l\'imprimante.', 'error');
    } finally {
      setIsTesting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-printer-title"
        aria-describedby="mobile-printer-description"
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-3xl w-full max-w-lg overflow-hidden flex flex-col shadow-2xl animate-in slide-in-from-bottom-5 max-h-[90dvh]"
      >
        {/* M3 Drag Handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 sm:hidden shrink-0" aria-hidden="true" />

        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-pos-border/60 flex items-center justify-between shrink-0 bg-pos-card">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0">
              <Printer className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="mobile-printer-title" className="text-sm sm:text-base font-black text-pos-text truncate">
                {t.printer.modalTitle}
              </h2>
              <p id="mobile-printer-description" className="text-[11px] text-pos-muted truncate">
                {t.printer.modalSubtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t.printer.closeAria}
            className="min-h-[48px] min-w-[48px] rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-center text-pos-muted hover:text-pos-text cursor-pointer transition"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Modal Content — scrollable */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4">
          {/* Main Direct Printing Toggle */}
          <div className="p-3.5 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-between gap-3">
            <div>
              <span className="font-bold text-xs text-pos-text block">
                {t.printer.directPrintingTitle}
              </span>
              <span className="text-[11px] text-pos-muted block">
                {t.printer.directPrintingDesc}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={`min-h-[48px] px-4 rounded-xl font-bold text-xs cursor-pointer transition active:scale-95 ${
                config.enabled
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
              }`}
            >
              {config.enabled ? t.printer.enabledBadge : t.printer.disabledBadge}
            </button>
          </div>

          {config.enabled && (
            <>
              {/* Connection Type Tabs (Wi-Fi vs Bluetooth) */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-wider text-pos-muted">
                  {t.printer.connectionTypeLabel}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setConfig((prev) => ({ ...prev, connection: 'wifi' }))}
                    className={`min-h-[48px] px-3 rounded-xl border flex items-center justify-center gap-2 font-bold text-xs cursor-pointer transition active:scale-98 ${
                      config.connection === 'wifi'
                        ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-800 dark:text-cyan-300 shadow-xs'
                        : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    <Wifi className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{t.printer.wifiTab}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConfig((prev) => ({ ...prev, connection: 'bluetooth' }));
                      if (bondedDevices.length === 0) void handleScanBluetooth();
                    }}
                    className={`min-h-[48px] px-3 rounded-xl border flex items-center justify-center gap-2 font-bold text-xs cursor-pointer transition active:scale-98 ${
                      config.connection === 'bluetooth'
                        ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-800 dark:text-indigo-300 shadow-xs'
                        : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    <Bluetooth className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{t.printer.bluetoothTab}</span>
                  </button>
                </div>
              </div>

              {/* Wi-Fi Configuration Parameters */}
              {config.connection === 'wifi' && (
                <div className="p-3.5 rounded-2xl bg-pos-card border border-pos-border space-y-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold text-pos-text block">
                      {t.printer.printerIpLabel}
                    </label>
                    <input
                      type="text"
                      dir="ltr"
                      value={config.wifiHost}
                      onChange={(e) => setConfig((prev) => ({ ...prev, wifiHost: e.target.value }))}
                      placeholder={t.printer.printerIpPlaceholder}
                      className="w-full min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-bold text-pos-text block">
                      {t.printer.tcpPortLabel}
                    </label>
                    <input
                      type="number"
                      dir="ltr"
                      value={config.wifiPort}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          wifiPort: parseInt(e.target.value, 10) || 9100,
                        }))
                      }
                      placeholder="9100"
                      className="w-full min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>
              )}

              {/* Bluetooth Configuration Parameters */}
              {config.connection === 'bluetooth' && (
                <div className="p-3.5 rounded-2xl bg-pos-card border border-pos-border space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] font-bold text-pos-text">
                      {t.printer.bondedBluetoothTitle}
                    </label>
                    <button
                      type="button"
                      onClick={handleScanBluetooth}
                      disabled={isScanningBt}
                      className="min-h-[48px] px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-[11px] font-bold text-pos-text flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <RotateCw
                        className={`w-3.5 h-3.5 ${isScanningBt ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{t.common.refresh}</span>
                    </button>
                  </div>

                  {bondedDevices.length > 0 ? (
                    <div className="space-y-1.5 max-h-36 overflow-y-auto">
                      {bondedDevices.map((dev) => (
                        <button
                          key={dev.mac}
                          type="button"
                          onClick={() =>
                            setConfig((prev) => ({
                              ...prev,
                              bluetoothName: dev.name,
                              bluetoothMac: dev.mac,
                            }))
                          }
                          className={`w-full min-h-[48px] px-3 rounded-xl border text-start flex items-center justify-between text-xs cursor-pointer transition ${
                            config.bluetoothMac === dev.mac
                              ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-800 dark:text-indigo-300 font-bold'
                              : 'bg-pos-panel border-pos-border text-pos-text hover:bg-pos-hover'
                          }`}
                        >
                          <span className="truncate">{dev.name}</span>
                          <span className="font-mono text-[10px] text-pos-muted shrink-0 ms-2">
                            <Bdi>{dev.mac}</Bdi>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-pos-muted bg-pos-panel/60 p-2.5 rounded-xl border border-pos-border/40">
                      {t.printer.bluetoothPairingHint}
                    </p>
                  )}

                  <div className="space-y-1 pt-1">
                    <label className="text-[11px] font-bold text-pos-text block">
                      {t.printer.manualMacLabel}
                    </label>
                    <input
                      type="text"
                      dir="ltr"
                      value={config.bluetoothMac}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          bluetoothMac: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder={t.printer.manualMacPlaceholder}
                      className="w-full min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-indigo-400"
                    />
                  </div>
                </div>
              )}

              {/* Protocol selector */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-wider text-pos-muted">
                  {t.printer.protocolLabel}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['ESCPOS', 'TSPL', 'ZPL'] as MobileLabelProtocol[]).map((proto) => (
                    <button
                      key={proto}
                      type="button"
                      onClick={() => setConfig((prev) => ({ ...prev, labelProtocol: proto }))}
                      className={`min-h-[48px] px-2 rounded-xl border font-bold text-xs cursor-pointer transition active:scale-95 ${
                        config.labelProtocol === proto
                          ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-800 dark:text-emerald-300'
                          : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      <Bdi>{proto}</Bdi>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="p-4 sm:p-5 pb-[max(1rem,var(--safe-bottom))] sm:pb-5 border-t border-pos-border/60 bg-pos-card flex flex-col sm:flex-row gap-2 shrink-0">
          <button
            type="button"
            disabled={!config.enabled || isTesting}
            onClick={handleTestPrint}
            className="flex-1 min-h-[48px] rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border active-press text-pos-text font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PlayCircle className="w-4 h-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            <span>{isTesting ? t.printer.sendingTestTicket : t.printer.testTicketButton}</span>
          </button>

          <button
            type="button"
            onClick={handleSave}
            className="flex-1 min-h-[48px] rounded-xl bg-emerald-500 hover:bg-emerald-400 active-press text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-md shadow-emerald-500/20 transition cursor-pointer"
          >
            <Save className="w-4 h-4" aria-hidden="true" />
            <span>{t.common.save}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
