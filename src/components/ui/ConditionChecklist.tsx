import React from 'react';
import {
  CHASSIS_DAMAGE_LABELS,
  CHASSIS_DAMAGE_ORDER,
  DEVICE_LOCK_LABELS,
  DEVICE_LOCK_ORDER,
  SCREEN_CONDITION_LABELS,
  SCREEN_CONDITION_ORDER,
  hasDeviceLock,
  intakeDamageSeverity,
  type ChassisDamage,
  type DeviceLockType,
  type IntakeDamageAssessment,
  type ScreenCondition,
} from '../../types/pos';
import { ShieldAlert, Droplets, Lock, Check } from 'lucide-react';

/** An empty, explicit constat — never `undefined` (which means "not assessed"). */
export const EMPTY_DAMAGE: IntakeDamageAssessment = {
  screenCondition: undefined,
  chassisDamage: ['none'],
  liquidIndicatorTripped: false,
  deviceLock: { type: 'none' },
};

export interface ConditionChecklistProps {
  value: IntakeDamageAssessment;
  onChange: (next: IntakeDamageAssessment) => void;
  /** Amber (intake) or emerald (exit) framing. */
  tone?: 'intake' | 'exit';
  readOnly?: boolean;
  className?: string;
}

const chipBase =
  'min-h-[44px] sm:min-h-[36px] px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg border text-left text-xs sm:text-sm font-medium flex items-center gap-2 transition cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60';
const chipOff = 'bg-pos-card border-pos-border text-pos-muted';
/** Amber while the customer is present (intake), emerald on the exit PV. */
const chipOn = (tone: 'intake' | 'exit'): string =>
  tone === 'exit'
    ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
    : 'bg-amber-500/10 border-amber-500/50 text-amber-800 dark:text-amber-300';

/** Section eyebrow — the single heading treatment shared by every fieldset. */
const legendCls = 'text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted';

/**
 * The physical-damage matrix. Every control is a real `<button type="button">`
 * so it is Tab-reachable and toggles on Space/Enter natively — no div
 * role="checkbox" keyboard emulation. Mobile stacks one control per row
 * (44px tall, full width) to stay inside the one-handed thumb zone; desktop
 * uses a responsive grid so a 1366×768 till shows no empty space.
 */
export const ConditionChecklist: React.FC<ConditionChecklistProps> = ({
  value,
  onChange,
  tone = 'intake',
  readOnly = false,
  className = '',
}) => {
  const severity = intakeDamageSeverity(value);
  const accentRing =
    severity === 'major'
      ? 'border-rose-500/50'
      : severity === 'minor'
        ? 'border-amber-500/40'
        : 'border-emerald-500/40';

  const setScreen = (next: ScreenCondition) => {
    if (readOnly) return;
    onChange({ ...value, screenCondition: next });
  };

  const toggleChassis = (next: ChassisDamage) => {
    if (readOnly) return;
    const current: ChassisDamage[] = value.chassisDamage?.length ? value.chassisDamage : ['none'];
    let chassisDamage: ChassisDamage[];
    if (next === 'none') {
      chassisDamage = ['none'];
    } else if (current.includes(next)) {
      chassisDamage = current.filter((c) => c !== next);
      if (chassisDamage.length === 0) chassisDamage = ['none'];
    } else {
      chassisDamage = [...current.filter((c) => c !== 'none'), next];
    }
    onChange({ ...value, chassisDamage });
  };

  const setLock = (type: DeviceLockType) => {
    if (readOnly) return;
    // The raw lock code is NEVER stored — only the fact that one exists.
    onChange({
      ...value,
      deviceLock: type === 'none' ? { type: 'none' } : { type, provided: true },
    });
  };

  const setLiquid = (tripped: boolean) => {
    if (readOnly) return;
    onChange({ ...value, liquidIndicatorTripped: tripped });
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Screen condition — single-select chips */}
      <fieldset className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2">
        <legend className={`${legendCls} flex items-center gap-1.5 px-1`}>
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
          État de l&apos;écran
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SCREEN_CONDITION_ORDER.map((cond) => {
            const on = value.screenCondition === cond;
            const major = cond !== 'intact' && cond !== 'scratched';
            return (
              <button
                key={cond}
                type="button"
                disabled={readOnly}
                aria-pressed={on}
                onClick={() => setScreen(cond)}
                className={`${chipBase} ${on ? (major ? 'bg-rose-500/10 border-rose-500/50 text-rose-700 dark:text-rose-300' : chipOn(tone)) : chipOff}`}
              >
                {on ? (
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-current shrink-0" aria-hidden="true" />
                )}
                {SCREEN_CONDITION_LABELS[cond]}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Chassis — multi-select (none exclusive) */}
      <fieldset className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2">
        <legend className={legendCls}>
          État du châssis / coque
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {CHASSIS_DAMAGE_ORDER.map((dmg) => {
            const on = (value.chassisDamage || []).includes(dmg);
            const major = dmg === 'bent_frame' || dmg === 'cracked_back';
            return (
              <button
                key={dmg}
                type="button"
                disabled={readOnly}
                aria-pressed={on}
                onClick={() => toggleChassis(dmg)}
                className={`${chipBase} ${on ? (major ? 'bg-rose-500/10 border-rose-500/50 text-rose-700 dark:text-rose-300' : chipOn(tone)) : chipOff}`}
              >
                {on ? (
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-current shrink-0" aria-hidden="true" />
                )}
                {CHASSIS_DAMAGE_LABELS[dmg]}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Liquid + lock */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2">
          <p className={`${legendCls} flex items-center gap-1.5`}>
            <Droplets className="w-3.5 h-3.5 text-cyan-400 shrink-0" aria-hidden="true" />
            Indicateur liquide
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={!value.liquidIndicatorTripped}
              onClick={() => setLiquid(false)}
              className={`${chipBase} justify-center !text-center ${
                !value.liquidIndicatorTripped
                  ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
                  : chipOff
              }`}
            >
              Non déclenché
            </button>
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={Boolean(value.liquidIndicatorTripped)}
              onClick={() => setLiquid(true)}
              className={`${chipBase} justify-center !text-center ${
                value.liquidIndicatorTripped
                  ? 'bg-rose-500/10 border-rose-500/50 text-rose-700 dark:text-rose-300'
                  : chipOff
              }`}
            >
              Déclenché
            </button>
          </div>
        </div>

        <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2">
          <p className={`${legendCls} flex items-center gap-1.5`}>
            <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
            Verrouillage de l&apos;appareil
          </p>
          <div className="grid grid-cols-2 gap-2">
            {DEVICE_LOCK_ORDER.map((type) => {
              const on = value.deviceLock?.type === type;
              const risky = type !== 'none';
              return (
                <button
                  key={type}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={on}
                  onClick={() => setLock(type)}
                  title={
                    on && value.deviceLock?.provided
                      ? `${DEVICE_LOCK_LABELS[type]} — code fourni (valeur non conservée)`
                      : DEVICE_LOCK_LABELS[type]
                  }
                  className={`${chipBase} !text-center ${
                    on
                      ? risky
                        ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
                        : 'bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
                      : chipOff
                  }`}
                >
                  {DEVICE_LOCK_LABELS[type]}
                </button>
              );
            })}
          </div>
          {hasDeviceLock(value.deviceLock) && (
            <p className="text-[10px] text-amber-400 font-semibold">
              Code de verrouillage fourni par le client — valeur NON conservée (usage interne uniquement).
            </p>
          )}
        </div>
      </div>

      <div className={`rounded-xl border bg-pos-card px-3 py-2 ${accentRing}`}>
        <label className="text-[11px] text-pos-muted block mb-1 font-semibold">
          Note interne sur les dommages préexistants (imprimée sur la fiche atelier uniquement)
        </label>
        <textarea
          rows={2}
          value={value.preExistingNotes || ''}
          disabled={readOnly}
          onChange={(e) => onChange({ ...value, preExistingNotes: e.target.value })}
          placeholder="Ex: coin inférieur droit enfoncé, constaté avant remise…"
          className="w-full min-h-[64px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs text-pos-text focus:border-amber-400 focus:outline-none disabled:opacity-60"
        />
      </div>
    </div>
  );
};

export default ConditionChecklist;