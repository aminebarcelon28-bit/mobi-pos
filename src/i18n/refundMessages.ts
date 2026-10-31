/**
 * Refund refusal copy — FR / AR / EN.
 *
 * The app's i18n dictionaries ship `fr` and `ar`; the owner asked for this
 * message in all three, so it carries its own EN variant rather than reshaping
 * the translation type space for a P0 fix.
 */
export type RefundRefusalKey = 'avoirRecipientRequired' | 'avoirRecipientOffline';

type Locale = 'fr' | 'ar' | 'en';

const MESSAGES: Record<Locale, Record<RefundRefusalKey, string>> = {
  fr: {
    avoirRecipientRequired:
      "Aucun client sur ce ticket : un remboursement en Avoir ne peut créditer personne. Identifiez le client, ou remboursez en espèces (dans la limite du plafond hors-ligne restant).",
    avoirRecipientOffline:
      "Plafond espèces hors-ligne atteint et aucun client sur ce ticket : l'Avoir n'a personne à créditer. Reconnectez-vous pour rembourser en espèces, ou remboursez dans la limite du plafond hors-ligne restant.",
  },
  ar: {
    avoirRecipientRequired:
      'لا يوجد عميل على هذه التذكرة: استرداد المبلغ كرصيد (أفوار) لا يمكن أن يُقيَّد لأي شخص. حدّد العميل، أو استرد المبلغ نقدًا ضمن سقف النقد المتبقي دون اتصال.',
    avoirRecipientOffline:
      'تم بلوغ سقف النقد دون اتصال ولا يوجد عميل على هذه التذكرة: لا يوجد من يُقيَّد له الرصيد. أعد الاتصال للاسترداد نقدًا، أو استرد ضمن سقف النقد المتبقي دون اتصال.',
  },
  en: {
    avoirRecipientRequired:
      'No customer on this ticket: an Avoir (store-credit) refund would credit nobody. Identify the customer, or refund in cash (within the remaining offline cap).',
    avoirRecipientOffline:
      'Offline cash cap reached and this ticket has no customer: the Avoir has nobody to credit. Reconnect to refund in cash, or refund within the remaining offline cash cap.',
  },
};

/** Active locale from the shell (fr default, ar when selected). */
export function refundLocale(): Locale {
  try {
    const stored = window.localStorage.getItem('mobi_pos_locale');
    if (stored === 'ar') return 'ar';
    if (stored === 'en') return 'en';
  } catch {
    /* restricted WebView */
  }
  return 'fr';
}

export function refundRefusalMessage(key: RefundRefusalKey, locale: Locale = refundLocale()): string {
  return MESSAGES[locale]?.[key] ?? MESSAGES.fr[key];
}
