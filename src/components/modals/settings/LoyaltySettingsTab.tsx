import React, { useState } from 'react';
import {
  Award,
  Zap,
  Sparkles,
  Trash2,
  TrendingUp,
  Tag,
  Calendar,
  Eye,
  Plus,
  Percent,
} from 'lucide-react';
import { MoneyInput } from '../../ui/MoneyInput';
import { dinarsToMinor, toLegacyReal, formatDZD } from '../../../utils/currency';
import {
  normalizeLoyaltyConfig,
  calculateFinancialProfitImpact,
} from '../../../utils/loyaltyEngine';
import type {
  ReceiptSettings,
  LoyaltyProgramConfig,
  CategoryType,
  PromoCampaignRule,
} from '../../../types/pos';

interface LoyaltySettingsTabProps {
  receiptSettings: ReceiptSettings;
  onSave: (updated: ReceiptSettings) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

export const LoyaltySettingsTab: React.FC<LoyaltySettingsTabProps> = ({
  receiptSettings,
  onSave,
  showToast,
}) => {
  const cfg = normalizeLoyaltyConfig(receiptSettings.loyaltyConfig);

  const [newCatName, setNewCatName] = useState<string>('Accessoires');
  const [newCatMultiplier, setNewCatMultiplier] = useState<number>(1.5);

  const [newCampName, setNewCampName] = useState<string>('');
  const [newCampMultiplier, setNewCampMultiplier] = useState<number>(2.0);

  const updateLoyaltyCfg = (next: LoyaltyProgramConfig) => {
    const updated = {
      ...receiptSettings,
      loyaltyConfig: normalizeLoyaltyConfig(next),
    };
    onSave(updated);
  };

  const freshId = (prefix: string) =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as Crypto).randomUUID()
      : `${prefix}-${Date.now().toString(36)}`;

  const numField = (raw: string, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const handleAddCategoryMultiplier = () => {
    const trimmed = newCatName.trim() as CategoryType;
    if (!trimmed) return;
    const existing = cfg.categoryMultipliers || [];
    if (existing.some((c) => c.category === trimmed)) {
      showToast('Cette catégorie a déjà un multiplicateur.', 'warning');
      return;
    }
    const nextList = [...existing, { category: trimmed, multiplier: newCatMultiplier }];
    updateLoyaltyCfg({ ...cfg, categoryMultipliers: nextList });
    showToast(`Multiplicateur ${newCatMultiplier}x ajouté pour ${trimmed}.`, 'success');
  };

  const handleRemoveCategoryMultiplier = (cat: CategoryType) => {
    const nextList = (cfg.categoryMultipliers || []).filter((c) => c.category !== cat);
    updateLoyaltyCfg({ ...cfg, categoryMultipliers: nextList });
  };

  const handleAddCampaign = () => {
    const trimmed = newCampName.trim();
    if (!trimmed) {
      showToast('Saisissez le nom de la campagne promotionnelle.', 'warning');
      return;
    }
    const now = Date.now();
    const newCamp: PromoCampaignRule = {
      id: freshId('camp'),
      name: trimmed,
      startDate: new Date(now).toISOString(),
      endDate: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
      multiplier: Math.max(1, newCampMultiplier),
      active: true,
    };
    const nextList = [...(cfg.activeCampaigns || []), newCamp];
    updateLoyaltyCfg({ ...cfg, activeCampaigns: nextList });
    setNewCampName('');
    showToast(`Campagne « ${trimmed} » (${newCampMultiplier}x) ajoutée !`, 'success');
  };

  const handleToggleCampaign = (id: string) => {
    const nextList = (cfg.activeCampaigns || []).map((c) =>
      c.id === id ? { ...c, active: !c.active } : c
    );
    updateLoyaltyCfg({ ...cfg, activeCampaigns: nextList });
  };

  const handleRemoveCampaign = (id: string) => {
    const nextList = (cfg.activeCampaigns || []).filter((c) => c.id !== id);
    updateLoyaltyCfg({ ...cfg, activeCampaigns: nextList });
  };

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      {/* Studio Header Card + Master Switch */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
            <Award className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-pos-text flex items-center gap-2">
              Studio Fidélité & Modèle Financier
              <span
                className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full border ${
                  cfg.enabled
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                }`}
              >
                {cfg.enabled ? 'Actif' : 'Désactivé'}
              </span>
            </h3>
            <p className="text-[11px] text-pos-muted">
              Contrôle granulaire des points, multiplicateurs par catégorie, campagnes et simulation de marge nette.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => updateLoyaltyCfg({ ...cfg, enabled: !cfg.enabled })}
            className={`px-4 py-2 font-bold text-xs rounded-xl shadow-lg cursor-pointer transition ${
              cfg.enabled
                ? 'bg-slate-700 hover:bg-slate-600 text-white'
                : 'bg-gradient-to-r from-amber-500 to-emerald-600 hover:from-amber-400 hover:to-emerald-500 text-slate-950 shadow-amber-500/20'
            }`}
          >
            {cfg.enabled ? 'Désactiver le Programme' : 'Activer le Programme'}
          </button>
        </div>
      </div>

      {/* Visibility & Customer UI Toggle */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Eye className="w-4 h-4 text-cyan-400" />
          <div>
            <h4 className="text-xs font-bold text-pos-text">
              Affichage des Points & Badges de Fidélité
            </h4>
            <p className="text-[11px] text-pos-muted">
              Affiche les points, rangs et étoiles sur les reçus thermiques et sur la puce client de l'en-tête de caisse.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            updateLoyaltyCfg({ ...cfg, loyaltyVisible: !(cfg.loyaltyVisible ?? true) })
          }
          className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
            cfg.loyaltyVisible ?? true
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
              : 'bg-slate-500/20 text-slate-400 border-slate-500/30'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              cfg.loyaltyVisible ?? true ? 'bg-cyan-400 animate-pulse' : 'bg-slate-500'
            }`}
          />
          <span>{cfg.loyaltyVisible ?? true ? 'Visible Partout' : 'Masqué (Interne)'}</span>
        </button>
      </div>

      {/* Disabled-mode selector */}
      {!cfg.enabled && (
        <div className="bg-pos-card border border-amber-500/30 rounded-xl p-4 space-y-2">
          <h4 className="text-xs font-bold text-pos-text">Comportement à l'arrêt</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={() => updateLoyaltyCfg({ ...cfg, disabledMode: 'freeze-all' })}
              className={`p-2.5 rounded-lg border text-left cursor-pointer transition ${
                cfg.disabledMode === 'freeze-all'
                  ? 'border-amber-500 bg-amber-500/10 text-pos-text font-bold'
                  : 'border-pos-border bg-pos-bg text-pos-muted'
              }`}
            >
              <span className="block font-bold mb-0.5">❄️ Gel total</span>
              <span className="text-[10px]">Soldes conservés. Ni gain, ni échange.</span>
            </button>
            <button
              type="button"
              onClick={() => updateLoyaltyCfg({ ...cfg, disabledMode: 'earn-off-redeem-on' })}
              className={`p-2.5 rounded-lg border text-left cursor-pointer transition ${
                cfg.disabledMode === 'earn-off-redeem-on'
                  ? 'border-emerald-500 bg-emerald-500/10 text-pos-text font-bold'
                  : 'border-pos-border bg-pos-bg text-pos-muted'
              }`}
            >
              <span className="block font-bold mb-0.5">💰 Gains coupés, échanges ouverts</span>
              <span className="text-[10px]">Les clients dépensent leurs points sans en gagner.</span>
            </button>
          </div>
        </div>
      )}

      {/* Distribution & Redemption Rules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Rule Card 1: Earning & Redemption Rates */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
          <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
            <Zap className="w-4 h-4 text-amber-400" /> Règles de Gain & Conversion de Points
          </h4>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() =>
                updateLoyaltyCfg({ ...cfg, pointsEnabled: !(cfg.pointsEnabled ?? true) })
              }
              className={`p-2 rounded-lg border text-left cursor-pointer transition ${
                cfg.pointsEnabled ?? true
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-pos-border bg-pos-bg opacity-70'
              }`}
            >
              <span className="block text-[11px] font-bold text-pos-text">⭐ Système de points</span>
              <span
                className={`text-[9px] font-bold uppercase ${
                  cfg.pointsEnabled ?? true ? 'text-emerald-400' : 'text-pos-muted'
                }`}
              >
                {cfg.pointsEnabled ?? true ? 'Activé' : 'Coupé'}
              </span>
            </button>

            <button
              type="button"
              onClick={() =>
                updateLoyaltyCfg({
                  ...cfg,
                  tierMultipliersEnabled: !(cfg.tierMultipliersEnabled ?? true),
                })
              }
              className={`p-2 rounded-lg border text-left cursor-pointer transition ${
                cfg.tierMultipliersEnabled ?? true
                  ? 'border-cyan-500/60 bg-cyan-500/10'
                  : 'border-pos-border bg-pos-bg opacity-70'
              }`}
            >
              <span className="block text-[11px] font-bold text-pos-text">✖️ Multiplicateurs palier</span>
              <span
                className={`text-[9px] font-bold uppercase ${
                  cfg.tierMultipliersEnabled ?? true ? 'text-emerald-400' : 'text-pos-muted'
                }`}
              >
                {cfg.tierMultipliersEnabled ?? true ? 'Activés (1.0x–2.5x)' : 'Forcés à 1.0x'}
              </span>
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                Montant d'Achat par Point de Base (DA)
              </label>
              <MoneyInput
                label="Montant d'Achat par Point de Base (DA)"
                valueMinor={dinarsToMinor(cfg.baseSpendPerPoint || 0)}
                onChangeMinor={(minor) =>
                  updateLoyaltyCfg({
                    ...cfg,
                    baseSpendPerPoint: Math.max(1, toLegacyReal(minor)),
                  })
                }
                className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
              />
              <span className="text-[9.5px] text-pos-muted mt-0.5 block">
                {cfg.baseSpendPerPoint} DA dépensés = 1 Point de Base
              </span>
            </div>

            <div>
              <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                Valeur de Conversion en Avoir Client (DA par Point)
              </label>
              <MoneyInput
                label="Valeur de Conversion en Avoir Client (DA par Point)"
                valueMinor={dinarsToMinor(cfg.pointRedemptionRate || 0)}
                onChangeMinor={(minor) =>
                  updateLoyaltyCfg({
                    ...cfg,
                    pointRedemptionRate: Math.max(1, toLegacyReal(minor)),
                  })
                }
                className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-emerald-400 font-bold"
              />
              <span className="text-[9.5px] text-pos-muted mt-0.5 block">
                1 Point = {cfg.pointRedemptionRate} DA d'Avoir Client
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                  Seuil Min. Échange (Points)
                </label>
                <input
                  type="number"
                  min={1}
                  value={cfg.minimumRedemptionPoints}
                  onChange={(e) =>
                    updateLoyaltyCfg({
                      ...cfg,
                      minimumRedemptionPoints: Math.max(
                        1,
                        Math.floor(numField(e.target.value, cfg.minimumRedemptionPoints))
                      ),
                    })
                  }
                  className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                />
              </div>

              <div>
                <label className="text-[11px] text-pos-muted font-semibold block mb-1">
                  Plafond Panier (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={cfg.maximumRedemptionPercentPerSale}
                  onChange={(e) =>
                    updateLoyaltyCfg({
                      ...cfg,
                      maximumRedemptionPercentPerSale: Math.min(
                        100,
                        Math.max(
                          0,
                          numField(e.target.value, cfg.maximumRedemptionPercentPerSale)
                        )
                      ),
                    })
                  }
                  className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 text-pos-text font-bold"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Rule Card 2: Tier table editor */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
          <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5 border-b border-pos-border/60 pb-2">
            <Sparkles className="w-4 h-4 text-cyan-400" /> Paliers & Multiplicateurs
          </h4>
          <div className="space-y-2 text-xs">
            {cfg.tiers.map((t) => (
              <div key={t.id} className="bg-pos-bg p-2 rounded-lg border border-pos-border space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{t.style.icon}</span>
                  <input
                    type="text"
                    value={t.name}
                    disabled={t.id === 'tier-0'}
                    title={t.id === 'tier-0' ? 'Palier de base verrouillé' : 'Nom du palier'}
                    onChange={(e) => {
                      const tiers = cfg.tiers.map((x) =>
                        x.id === t.id ? { ...x, name: e.target.value } : x
                      );
                      updateLoyaltyCfg({ ...cfg, tiers });
                    }}
                    className="flex-1 min-w-0 bg-transparent border border-transparent hover:border-pos-border focus:border-amber-500 rounded px-1 py-0.5 font-semibold text-pos-text focus:outline-none disabled:opacity-70"
                  />
                  {t.id === 'tier-0' ? (
                    <span className="text-[9px] font-bold text-pos-muted uppercase">Base 🔒</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        updateLoyaltyCfg({
                          ...cfg,
                          tiers: cfg.tiers.filter((x) => x.id !== t.id),
                        })
                      }
                      className="p-1 text-pos-muted hover:text-red-400 cursor-pointer"
                      title="Supprimer ce palier"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="block">
                    <span className="text-[9px] text-pos-muted uppercase font-semibold">Seuil (DA)</span>
                    <MoneyInput
                      label="Seuil (DA)"
                      valueMinor={dinarsToMinor(t.minSpend || 0)}
                      onChangeMinor={(minor) => {
                        const tiers = cfg.tiers.map((x) =>
                          x.id === t.id
                            ? { ...x, minSpend: Math.max(0, toLegacyReal(minor)) }
                            : x
                        );
                        updateLoyaltyCfg({ ...cfg, tiers });
                      }}
                      disabled={t.id === 'tier-0'}
                      className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-pos-text focus:outline-none focus:border-amber-500 disabled:opacity-70"
                    />
                  </label>
                  <label className={`block ${(cfg.tierMultipliersEnabled ?? true) ? '' : 'opacity-40'}`}>
                    <span className="text-[9px] text-pos-muted uppercase font-semibold">
                      Multiplicateur{(cfg.tierMultipliersEnabled ?? true) ? '' : ' (forcé 1.0x)'}
                    </span>
                    <input
                      type="number"
                      min={0.1}
                      step={0.05}
                      value={t.multiplier}
                      disabled={!(cfg.tierMultipliersEnabled ?? true)}
                      onChange={(e) => {
                        const tiers = cfg.tiers.map((x) =>
                          x.id === t.id
                            ? { ...x, multiplier: Math.max(0.1, numField(e.target.value, t.multiplier)) }
                            : x
                        );
                        updateLoyaltyCfg({ ...cfg, tiers });
                      }}
                      className="w-full bg-pos-card border border-pos-border rounded px-1.5 py-1 font-mono font-bold text-pos-text focus:outline-none focus:border-amber-500 disabled:cursor-not-allowed"
                    />
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const maxSpend = cfg.tiers.reduce((m, t) => Math.max(m, t.minSpend), 0);
                const lastMult = cfg.tiers[cfg.tiers.length - 1]?.multiplier ?? 1;
                updateLoyaltyCfg({
                  ...cfg,
                  tiers: [
                    ...cfg.tiers,
                    {
                      id: freshId('tier'),
                      name: `Palier ${cfg.tiers.length + 1}`,
                      minSpend: maxSpend + 50000,
                      multiplier: lastMult,
                      style: {
                        badgeColor: 'text-pos-text',
                        bgColor: 'bg-pos-bg',
                        borderColor: 'border-pos-border',
                        icon: '⭐',
                      },
                    },
                  ],
                });
              }}
              className="w-full py-1.5 rounded-lg border border-dashed border-pos-border hover:border-amber-500/50 text-[11px] font-bold text-pos-muted hover:text-pos-text cursor-pointer"
            >
              + Ajouter un palier
            </button>
          </div>
        </div>
      </div>

      {/* Category Multipliers Studio */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-emerald-400" />
            <h4 className="text-xs font-bold text-pos-text">
              Multiplicateurs de Points par Catégorie Produit
            </h4>
          </div>
          <span className="text-[10px] text-pos-muted">
            Boostez les catégories à forte marge (ex: Accessoires 1.5x)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end pt-1">
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">Catégorie</label>
            <input
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="Ex: Accessoires, Coques, Chargeurs"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-bold"
            />
          </div>
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">Multiplicateur (x)</label>
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.1}
              value={newCatMultiplier}
              onChange={(e) => setNewCatMultiplier(numField(e.target.value, 1.5))}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-pos-text"
            />
          </div>
          <button
            type="button"
            onClick={handleAddCategoryMultiplier}
            className="py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Ajouter Multiplicateur</span>
          </button>
        </div>

        {/* Existing Category Multipliers List */}
        <div className="flex flex-wrap gap-2 pt-2">
          {(cfg.categoryMultipliers || []).length === 0 ? (
            <span className="text-xs text-pos-muted italic">
              Aucun multiplicateur de catégorie configuré (taux standard 1.0x appliqué).
            </span>
          ) : (
            (cfg.categoryMultipliers || []).map((cm) => (
              <div
                key={cm.category}
                className="bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs"
              >
                <span className="font-bold text-pos-text">{cm.category}</span>
                <span className="bg-emerald-500/20 text-emerald-300 font-mono font-bold px-1.5 py-0.5 rounded text-[10px]">
                  {cm.multiplier}x
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveCategoryMultiplier(cm.category)}
                  className="text-pos-muted hover:text-rose-400 cursor-pointer p-0.5"
                  title="Supprimer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Promotional Campaigns Studio */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-purple-400" />
            <h4 className="text-xs font-bold text-pos-text">
              Campagnes Promotionnelles Temporaires & Événements
            </h4>
          </div>
          <span className="text-[10px] text-pos-muted">
            Multiplicateurs temporaires (ex: Week-end 2x points)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end pt-1">
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">Nom de la Campagne</label>
            <input
              type="text"
              value={newCampName}
              onChange={(e) => setNewCampName(e.target.value)}
              placeholder="Ex: Soldes d'Hiver, Ramadan, Week-end"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-bold"
            />
          </div>
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">Multiplicateur (x)</label>
            <input
              type="number"
              min={1.1}
              max={10}
              step={0.1}
              value={newCampMultiplier}
              onChange={(e) => setNewCampMultiplier(numField(e.target.value, 2.0))}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-pos-text"
            />
          </div>
          <button
            type="button"
            onClick={handleAddCampaign}
            className="py-1.5 px-3 bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Créer la Campagne (7j)</span>
          </button>
        </div>

        {/* Existing Campaigns List */}
        <div className="space-y-2 pt-2">
          {(cfg.activeCampaigns || []).length === 0 ? (
            <span className="text-xs text-pos-muted italic">
              Aucune campagne active actuellement.
            </span>
          ) : (
            (cfg.activeCampaigns || []).map((camp) => (
              <div
                key={camp.id}
                className="bg-pos-bg border border-pos-border rounded-xl p-3 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-pos-text truncate">{camp.name}</span>
                    <span className="bg-purple-500/20 text-purple-300 font-mono font-bold px-2 py-0.5 rounded text-[10px]">
                      {camp.multiplier}x Points
                    </span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        camp.active
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-slate-500/15 text-slate-400'
                      }`}
                    >
                      {camp.active ? 'Actif' : 'En pause'}
                    </span>
                  </div>
                  <p className="text-[10px] text-pos-muted mt-0.5">
                    Du {new Date(camp.startDate).toLocaleDateString('fr-FR')} au{' '}
                    {new Date(camp.endDate).toLocaleDateString('fr-FR')}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleToggleCampaign(camp.id)}
                    className="px-2.5 py-1 rounded bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-[11px] cursor-pointer"
                  >
                    {camp.active ? 'Mettre en pause' : 'Réactiver'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveCampaign(camp.id)}
                    className="p-1 text-pos-muted hover:text-rose-400 cursor-pointer"
                    title="Supprimer la campagne"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Financial Simulator */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
          <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4 text-emerald-400" /> Simulateur d'Impact Financier & Marge Nette
          </h4>
          <span className="text-[10px] text-pos-muted">Calcule le profit net réel après Avoir & Réductions</span>
        </div>

        {(() => {
          const sim = calculateFinancialProfitImpact(10000, 500, 1000, 4500, 150, cfg);
          return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-xs">
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
                <span className="text-[10px] text-emerald-400 uppercase font-semibold block">Bénéfice Net Réel</span>
                <span className="text-base font-black text-emerald-400">{formatDZD(sim.netProfit)}</span>
                <span className="text-[9px] text-emerald-300 font-bold block mt-0.5">
                  Marge Nette: {sim.netProfitMarginPercent}%
                </span>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};
