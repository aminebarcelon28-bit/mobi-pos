import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Fingerprint,
  Globe,
  History,
  Link2,
  Monitor,
  ScrollText,
  ShieldCheck,
  Signature,
  UserCheck,
  Wifi,
  X,
} from 'lucide-react';
import {
  CANONICAL_RULES_LABEL,
  ORIGIN_LABEL,
  SIGNATURE_LABEL,
  SIGNATURE_SCOPE_LABEL,
  computeAuditSignature,
  describeAuditTime,
  extractEntityRefs,
  formatFingerprint,
  formatSignature,
  parseAuditPayload,
  parseAuditTimestamp,
  readDeviceFingerprint,
  resolveActorMeta,
  classifySeverity,
  getActionCategory,
  signaturePreimage,
} from '../../utils/auditIntel';
import type { SecurityAuditLogEntry } from '../../types/pos';
import { AuditSeverityChip } from './AuditSeverityChip';
import { AuditDiffList } from './AuditDiffList';

interface AuditInspectionDrawerProps {
  entry: SecurityAuditLogEntry | null;
  onClose: () => void;
  /** Current terminal identity, used to backfill legacy rows. */
  session: { deviceId: string; ipAddress: string } | null;
  onEntityNavigate: (entityId: string, entityType: string) => void;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label={copied ? `${label} copié` : `Copier ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_600);
        } catch {
          // Clipboard is unavailable over plain http and in some WebViews;
          // the value stays selectable on screen either way.
        }
      }}
      className="p-1.5 rounded-md text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-pos-ok" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-pos-muted flex-1">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Deep-inspection slide-over.
 *
 * The table row gives the *what*; this panel answers the questions an auditor
 * actually asks during a review: what exactly was in the payload, what field
 * changed and from which value, who was the actor, which terminal and network
 * origin, and does the row still hash to its recorded signature.
 */
export const AuditInspectionDrawer: React.FC<AuditInspectionDrawerProps> = ({
  entry,
  onClose,
  session,
  onEntityNavigate,
}) => {
  const [signatureState, setSignatureState] = useState<{ id: string; hash: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fingerprint = useMemo(() => readDeviceFingerprint(), []);
  const when = useMemo(() => (entry ? parseAuditTimestamp(entry.timestamp) : new Date()), [entry]);
  // Raw-bytes-first forensics: `timeDesc` carries the exact stored string plus
  // the kind (ISO / legacy wall-clock / missing). The parsed `when` above is
  // kept ONLY for actor session-tag derivation and sorting — it is never
  // presented as the event date for dateless rows.
  const timeDesc = useMemo(
    () => (entry ? describeAuditTime(entry.timestamp) : null),
    [entry],
  );
  const actor = useMemo(
    () => (entry ? resolveActorMeta(entry, session, fingerprint, when) : null),
    [entry, session, fingerprint, when],
  );
  const payload = useMemo(
    () => (entry ? parseAuditPayload(entry.details, entry.action) : null),
    [entry],
  );
  const refs = useMemo(() => (entry ? extractEntityRefs(entry.details) : []), [entry]);
  const severity = useMemo(
    () => (entry ? classifySeverity(entry.action, entry.details, entry.requiresPin) : 'audit'),
    [entry],
  );
  const category = useMemo(() => (entry ? getActionCategory(entry.action) : null), [entry]);
  // The exact bytes the digest is derived from. Shown behind a disclosure so it
  // stays available for independent recomputation without crowding the panel.
  const canonical = useMemo(() => (entry ? signaturePreimage(entry) : ''), [entry]);

  // The digest is async (WebCrypto). Keying the result by row id means a row
  // switch shows a neutral "calcul…" via the id mismatch below, instead of
  // clearing the state from an effect.
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    void computeAuditSignature(entry).then((hash) => {
      if (!cancelled) setSignatureState({ id: entry.id, hash });
    });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const signature = signatureState && entry && signatureState.id === entry.id ? signatureState.hash : null;

  // Escape closes, and focus moves into the panel so the drawer is usable
  // without a pointer.
  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const id = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(id);
    };
  }, [entry, onClose]);

  if (!entry || !actor || !payload || !timeDesc) return null;

  const isLegacyTime = timeDesc.kind === 'legacy-wall';
  const isSkewed = timeDesc.clockSkewed;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        type="button"
        aria-label="Fermer l'inspection"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] cursor-default"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Inspection de l'événement d'audit ${entry.action}`}
        className="relative w-full sm:w-[520px] max-w-full h-full bg-pos-panel border-l border-pos-border shadow-2xl flex flex-col focus:outline-none pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0 audit-drawer-in"
      >
        {/* Header */}
        <div className="flex items-start gap-2.5 p-3.5 border-b border-pos-border bg-pos-card shrink-0">
          <div className="w-8 h-8 rounded-xl bg-pos-warn/15 border border-pos-warn/30 flex items-center justify-center shrink-0">
            <ScrollText className="w-4 h-4 text-pos-warn" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-bold text-pos-text leading-snug break-words">
              {entry.action}
            </h3>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <AuditSeverityChip severity={severity} category={category?.label} size="xs" />
              {entry.requiresPin && (
                <span className="pos-micro-badge pos-micro-badge--warn" title="Action soumise à validation PIN">
                  PIN validé
                </span>
              )}
              {/* FT-06/C + F4 provenance: imported/peer rows are unverified
                  history — labelled here, never as chained evidence. Absent
                  (legacy) reads as local. */}
              {(entry.source ?? 'local') === 'imported' && (
                <span
                  className="pos-micro-badge pos-micro-badge--info"
                  title="Ligne importée d'une sauvegarde : horodatage d'origine conservé, sans chaînage natif — historique non vérifié"
                >
                  Importé
                </span>
              )}
              {(entry.source ?? 'local') === 'peer' && (
                <span
                  className="pos-micro-badge pos-micro-badge--info"
                  title="Ligne reçue d'un autre terminal : sans chaînage local — historique non vérifié"
                >
                  Pair
                </span>
              )}
              {isLegacyTime && (
                <span
                  className="pos-micro-badge pos-micro-badge--warn"
                  title={`Date d'origine inconnue (format hérité "${timeDesc.raw}") — ne pas attribuer à aujourd'hui`}
                >
                  <History className="w-2.5 h-2.5" aria-hidden="true" /> Date inconnue (hérité)
                </span>
              )}
              {isSkewed && (
                <span
                  className="pos-micro-badge pos-micro-badge--warn"
                  title={timeDesc.title}
                >
                  <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" /> Horloge décalée
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 cursor-pointer transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3.5 space-y-5">
          <Section
            icon={<UserCheck className="w-3.5 h-3.5 text-pos-ok" />}
            title="Acteur & authentification"
          >
            <dl className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="col-span-2 bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide">Utilisateur</dt>
                <dd className="text-pos-text font-semibold break-words mt-0.5">{entry.user || '—'}</dd>
              </div>
              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide">Niveau</dt>
                <dd className="text-pos-text font-semibold mt-0.5">
                  {entry.requiresPin ? 'Manager — PIN' : 'Opérateur'}
                </dd>
              </div>
              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide">Preuve</dt>
                <dd className="text-pos-text font-semibold mt-0.5">
                  {entry.requiresPin ? 'Code PIN saisi' : 'Aucune validation'}
                </dd>
              </div>
            </dl>
          </Section>

          <Section
            icon={<Monitor className="w-3.5 h-3.5 text-pos-info" />}
            title="Terminal & réseau"
          >
            <dl className="space-y-2 text-[11px]">
              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                    <Monitor className="w-2.5 h-2.5" /> Terminal / Device ID
                  </dt>
                  <dd className="font-mono text-pos-text break-all mt-0.5">{actor.deviceId}</dd>
                  <dd className="text-pos-muted text-[9px] mt-0.5">{ORIGIN_LABEL[actor.deviceOrigin]}</dd>
                </div>
                <CopyButton value={actor.deviceId} label="le device id" />
              </div>

              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                    <Wifi className="w-2.5 h-2.5" /> Adresse IP
                  </dt>
                  <dd className="font-mono text-pos-text break-all mt-0.5">{actor.ipAddress}</dd>
                  <dd className="text-pos-muted text-[9px] mt-0.5">{ORIGIN_LABEL[actor.ipOrigin]}</dd>
                </div>
                <CopyButton value={actor.ipAddress} label="l'adresse IP" />
              </div>

              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                  <Fingerprint className="w-2.5 h-2.5" /> Empreinte du poste
                </dt>
                <dd className="text-pos-text mt-0.5 break-words">{formatFingerprint(actor.fingerprint)}</dd>
                <dd className="text-pos-muted text-[9px] mt-0.5 break-all font-mono">
                  Tag de session : {actor.sessionTag}
                </dd>
              </div>
            </dl>
          </Section>

          <Section icon={<Braces className="w-3.5 h-3.5 text-pos-neutral" />} title="Charge utile structurée">
            {payload.structured ? (
              <div className="space-y-2">
                {payload.fields.length > 0 && (
                  <dl className="grid grid-cols-1 gap-1.5">
                    {payload.fields.map((field, idx) => (
                      <div
                        key={`${field.label}-${idx}`}
                        className="flex items-start gap-2 bg-pos-card border border-pos-border rounded-lg px-2.5 py-1.5 text-[11px]"
                      >
                        <dt className="pos-kv-key shrink-0 w-28 truncate" title={field.label}>
                          {field.label}
                        </dt>
                        <dd className="text-pos-text flex-1 min-w-0 break-words">{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {payload.metrics.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {payload.metrics.map((metric, idx) => (
                      <span
                        key={`${metric.label}-${idx}`}
                        className="inline-flex items-baseline gap-1 px-2 py-1 rounded-lg bg-pos-card border border-pos-border text-[10px]"
                        title={`${metric.label} : ${metric.value}`}
                      >
                        <span className="text-pos-muted">{metric.label}</span>
                        <span className="font-mono font-bold text-pos-text tabular-nums">{metric.display}</span>
                      </span>
                    ))}
                  </div>
                )}

                {(payload.changes.length > 0 || payload.removedItems.length > 0) && (
                  <div>
                    <h5 className="text-[9px] font-bold uppercase tracking-wider text-pos-muted mb-1.5">
                      État avant / après
                    </h5>
                    <AuditDiffList changes={payload.changes} removedItems={payload.removedItems} />
                  </div>
                )}

                {payload.narrative && payload.narrative !== payload.raw && (
                  <p className="text-[11px] text-pos-muted bg-pos-bg/60 border border-pos-border/60 rounded-lg p-2.5 leading-relaxed">
                    {payload.narrative}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-pos-muted bg-pos-card border border-pos-border rounded-lg p-2.5 leading-relaxed">
                {payload.raw || 'Aucun détail enregistré.'}
              </p>
            )}
          </Section>

          {refs.length > 0 && (
            <Section icon={<Link2 className="w-3.5 h-3.5 text-pos-ok" />} title="Entités liées">
              <div className="flex flex-wrap gap-1.5">
                {refs.map((ref) => (
                  <button
                    key={`${ref.type}-${ref.id}`}
                    type="button"
                    onClick={() => onEntityNavigate(ref.id, ref.type)}
                    className="inline-flex items-center gap-1.5 px-2 py-1 bg-pos-ok/10 text-pos-ok border border-pos-ok/30 rounded-lg text-[10px] font-mono hover:bg-pos-ok/20 transition cursor-pointer"
                  >
                    {ref.id}
                    <span className="text-pos-ok/70 font-sans">({ref.type})</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </button>
                ))}
              </div>
            </Section>
          )}

          <Section
            icon={<ShieldCheck className="w-3.5 h-3.5 text-pos-warn" />}
            title="Horodatage & intégrité"
          >
            <div className="space-y-2 text-[11px]">
              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                    <Globe className="w-2.5 h-2.5" /> Valeur brute enregistrée
                  </dt>
                  <dd className="font-mono text-pos-text break-all mt-0.5">{timeDesc.raw || '—'}</dd>
                  <dd className="text-pos-muted text-[9px] mt-1 leading-relaxed">
                    Octets exacts stockés dans la ligne — seule valeur horodatrice probante.
                  </dd>
                </div>
                <CopyButton value={timeDesc.raw || ''} label="l'horodatage brut" />
              </div>

              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                  <History className="w-2.5 h-2.5" /> Lecture interprétée
                </dt>
                <dd className="font-mono text-pos-text break-all mt-0.5">{timeDesc.exact}</dd>
                {isLegacyTime && (
                  <dd className="mt-1.5 inline-flex items-center gap-1 pos-micro-badge pos-micro-badge--warn">
                    <History className="w-2.5 h-2.5" aria-hidden="true" /> Date d'origine inconnue (format hérité)
                  </dd>
                )}
                {isSkewed && (
                  <dd className="mt-1.5 inline-flex items-center gap-1 pos-micro-badge pos-micro-badge--warn">
                    <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" /> Horloge locale décalée
                  </dd>
                )}
                {(isLegacyTime || isSkewed || timeDesc.kind !== 'iso') && (
                  <dd className="text-pos-muted text-[9px] mt-1.5 leading-relaxed">
                    {isLegacyTime
                      ? `Heure sans date ("${timeDesc.raw}") : la date affichée ailleurs est une convention d'affichage, pas une preuve. Ne pas attribuer à aujourd'hui.`
                      : isSkewed
                        ? `Horodatage postérieur à l'horloge de consultation (${timeDesc.title}) : horloge de l'appareil suspecte, vérifier NTP / réglage manuel.`
                        : 'Horodatage absent ou illisible : aucune date ne peut être affirmée.'}
                  </dd>
                )}
              </div>

              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide flex items-center gap-1">
                  <Signature className="w-2.5 h-2.5" /> {SIGNATURE_LABEL}
                </dt>

                {signature ? (
                  <>
                    <dd className="mt-1.5 pos-hash-pill">
                      <code className="pos-hash-pill__value">{formatSignature(signature)}</code>
                      <CopyButton value={signature} label="la signature" />
                    </dd>
                    <dd className="text-pos-muted text-[9px] mt-1.5 leading-relaxed">
                      Recalculable à l'identique après export : la forme canonique ci-dessous est
                      celle qui a été hachée, et elle est embarquée dans le manifeste PDF/XLSX.
                    </dd>
                    <dd className="text-pos-muted text-[9px] mt-1 leading-relaxed">
                      Une divergence à la réimportation signifie que la ligne a été modifiée
                      depuis l’exportation ; un simple écart de format n’est pas une altération.
                    </dd>

                    <details className="mt-2 group">
                      <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-wide text-pos-muted hover:text-pos-text transition flex items-center gap-1 select-none">
                        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" aria-hidden="true" />
                        Forme canonique &amp; règles
                      </summary>
                      <div className="mt-1.5 space-y-1.5">
                        <pre className="pos-code-block break-all whitespace-pre-wrap">{canonical}</pre>
                        <p className="text-[9px] text-pos-muted leading-relaxed">
                          <strong className="font-bold text-pos-text">Règles :</strong>{' '}
                          {CANONICAL_RULES_LABEL}.
                        </p>
                        <p className="text-[9px] text-pos-muted leading-relaxed break-words">
                          <strong className="font-bold text-pos-text">Champs couverts :</strong>{' '}
                          <span className="font-mono">{SIGNATURE_SCOPE_LABEL}</span>
                        </p>
                      </div>
                    </details>
                  </>
                ) : (
                  <dd className="text-pos-muted text-[10px] mt-1">Calcul de l'empreinte…</dd>
                )}
              </div>

              <div className="bg-pos-card border border-pos-border rounded-lg p-2.5">
                <dt className="text-pos-muted text-[9px] uppercase font-bold tracking-wide">Identifiant d'audit</dt>
                <dd className="font-mono text-pos-text break-all mt-0.5 flex items-center gap-1">
                  <span className="flex-1 min-w-0 break-all">{entry.id}</span>
                  <CopyButton value={entry.id} label="l'identifiant d'audit" />
                </dd>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};
