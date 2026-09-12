/**
 * Ambient type declarations for browser extensions and native desktop APIs.
 * Eliminates forbidden `any` usage per rules.md R6.1.
 */

interface Window {
  webkitAudioContext?: typeof AudioContext;
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

interface USBDevice {
  productName?: string;
  vendorId?: number;
  productId?: number;
}

interface HIDDevice {
  productName?: string;
  vendorId?: number;
  productId?: number;
}

interface Navigator {
  usb?: {
    getDevices(): Promise<USBDevice[]>;
    addEventListener(type: 'connect' | 'disconnect', listener: (event: { device: USBDevice }) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', listener: (event: { device: USBDevice }) => void): void;
  };
  hid?: {
    getDevices(): Promise<HIDDevice[]>;
    addEventListener(type: 'connect' | 'disconnect', listener: (event: { device: HIDDevice }) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', listener: (event: { device: HIDDevice }) => void): void;
  };
}
