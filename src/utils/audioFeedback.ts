/**
 * Professional Volume-Modulated Web Audio Feedback Synthesizer for POS Terminals
 * Author: Principal Systems Architect
 * Operates with pure Web Audio API oscillators: 0ms latency, zero external audio assets.
 */

export interface AudioSettingsProfile {
  masterVolume: number; // 0.0 to 1.0 (e.g. 0.7 = 70%)
  isMuted: boolean;
  enableScanBeep: boolean;
  enableWarrantyChime: boolean;
  enableWarningBuzzer: boolean;
  enableCashChime: boolean;
}

const STORAGE_KEY = 'mobi_pos_audio_profile';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private profile: AudioSettingsProfile = {
    masterVolume: 0.7,
    isMuted: false,
    enableScanBeep: true,
    enableWarrantyChime: true,
    enableWarningBuzzer: true,
    enableCashChime: true,
  };

  constructor() {
    this.loadProfile();
  }

  private loadProfile(): void {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        this.profile = { ...this.profile, ...JSON.parse(saved) };
      }
    } catch {}
  }

  private saveProfile(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profile));
    } catch {}
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        this.ctx = new AudioCtxClass();
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    return this.ctx;
  }

  /**
   * Clamped Gain Calculation: O(1) mathematical bounds checking
   * Prevents audio clipping and distortion on physical POS speakers.
   */
  private getEffectiveGain(baseGain: number): number {
    if (this.profile.isMuted) return 0;
    const clampedVolume = Math.max(0, Math.min(1, this.profile.masterVolume));
    return Math.max(0, Math.min(1, baseGain * clampedVolume));
  }

  public getProfile(): AudioSettingsProfile {
    return { ...this.profile };
  }

  public setProfile(updates: Partial<AudioSettingsProfile>): void {
    this.profile = { ...this.profile, ...updates };
    this.saveProfile();
  }

  public toggleMute(): boolean {
    this.profile.isMuted = !this.profile.isMuted;
    this.saveProfile();
    return this.profile.isMuted;
  }

  public setSoundEnabled(enabled: boolean): void {
    this.profile.isMuted = !enabled;
    this.saveProfile();
  }

  public isEnabled(): boolean {
    return !this.profile.isMuted;
  }

  /**
   * 1. Standard Barcode Scan (Crisp High-Frequency Beep: 880 Hz / 60ms)
   */
  public playScan(): void {
    if (!this.profile.enableScanBeep || this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.15);
      if (vol === 0) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.05);

      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.06);
    } catch {}
  }

  /**
   * 2. Warranty Active / VIP Customer Verified (Melodic Rising Two-Tone: 587 Hz -> 880 Hz)
   */
  public playWarrantyActive(): void {
    if (!this.profile.enableWarrantyChime || this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.2);
      if (vol === 0) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880.0, now + 0.07); // A5

      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.18);
    } catch {}
  }

  /**
   * 3. Warning Alert: Warranty Expired / Debt Over-Limit / Stock Rupture (Low Tone: 220 Hz)
   */
  public playError(): void {
    if (!this.profile.enableWarningBuzzer || this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.25);
      if (vol === 0) return;

      const now = ctx.currentTime;
      [280, 220].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);

        gain.gain.setValueAtTime(vol, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.12);
      });
    } catch {}
  }

  /**
   * 4. Cash Sale Completed / Checkout Chime (1200 Hz Harmonic Bell)
   */
  public playSuccess(): void {
    if (!this.profile.enableCashChime || this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.2);
      if (vol === 0) return;

      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 arpeggio

      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + index * 0.05);

        gain.gain.setValueAtTime(vol, now + index * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.05 + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + index * 0.05);
        osc.stop(now + index * 0.05 + 0.22);
      });
    } catch {}
  }

  /**
   * 5. Cash Drawer Open Metallic Pulse
   */
  public playCashDrawer(): void {
    if (this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.15);
      if (vol === 0) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.08);

      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.09);
    } catch {}
  }

  /**
   * 6. Soft Keypad Feedback
   */
  public playKeyBeep(): void {
    if (this.profile.isMuted) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const vol = this.getEffectiveGain(0.05);
      if (vol === 0) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);

      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    } catch {}
  }
}

export const soundEngine = new SoundEngine();
export const AudioFeedbackEngine = soundEngine;
