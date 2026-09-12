/**
 * Decoupled Audio Event Bus.
 * Eliminates direct dependencies between domain state reducers / slices
 * and the Web Audio DOM API per rules.md R1.5 and R1.6.
 */

export type AudioEventName = 'scan' | 'success' | 'error' | 'keyBeep' | 'cashDrawer';

type AudioEventListener = () => void;

class AudioEventBus {
  private listeners: Map<AudioEventName, Set<AudioEventListener>> = new Map();

  public on(event: AudioEventName, listener: AudioEventListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  public emit(event: AudioEventName): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) return;

    eventListeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.warn(`[audioBus] Error executing listener for event "${event}":`, err);
      }
    });
  }
}

export const audioBus = new AudioEventBus();
