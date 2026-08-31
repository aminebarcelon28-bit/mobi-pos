import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { DiscoveredDevice } from '../types/pos';
import type { BindingResult } from '../utils/autoHardwareBinder';
import { AutoHardwareBinder } from '../utils/autoHardwareBinder';
import { MobilePosRoutingEngine } from '../utils/mobilePosRoutingEngine';
import { useToast } from '../components/ui/Toast';

export function useAutoDetectedHardware() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [activeBindings, setActiveBindings] = useState<BindingResult>({});
  const { showToast } = useToast();

  const hasInitializedRef = useRef<boolean>(false);

  const processDeviceList = useCallback(
    (newDevices: DiscoveredDevice[]) => {
      setDevices(newDevices);
      const bindings = AutoHardwareBinder.evaluateAndBind(newDevices, (msg, t) =>
        showToast(msg, t || 'info')
      );
      MobilePosRoutingEngine.autoConfigureProfile(newDevices);
      setActiveBindings(bindings);
    },
    [showToast]
  );

  const fetchInitialDevices = useCallback(async () => {
    try {
      setIsScanning(true);
      const list = await invoke<DiscoveredDevice[]>('hardware_scan_devices');
      processDeviceList(list || []);
    } catch (err) {
      console.warn('[HAL Auto-Detect] Initial hardware scan fallback:', err);
    } finally {
      setIsScanning(false);
    }
  }, [processDeviceList]);

  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      fetchInitialDevices();
    }

    let unlistenFn: (() => void) | undefined;
    const setupListener = async () => {
      try {
        unlistenFn = await listen<DiscoveredDevice[]>('hardware://device-list-updated', (event) => {
          processDeviceList(event.payload);
        });
      } catch (e) {
        console.warn('Failed to attach hardware hotplug listener:', e);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [fetchInitialDevices, processDeviceList]);

  return {
    devices,
    activeBindings,
    thermalPrinters: devices.filter((d) => d.category === 'thermalPrinter'),
    labelPrinters: devices.filter((d) => d.category === 'labelPrinter'),
    serialPorts: devices.filter(
      (d) => d.category === 'customerVfdDisplay' || d.category === 'genericSerial'
    ),
    isScanning,
    refreshManual: fetchInitialDevices,
  };
}
