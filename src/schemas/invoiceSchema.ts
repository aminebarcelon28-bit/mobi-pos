import { z } from 'zod';

export const CsvInvoiceRowSchema = z.object({
  sku: z.string().min(1, 'SKU / Référence obligatoire'),
  qty: z.number().int().positive('La quantité doit être un entier positif'),
  cost: z.number().nonnegative('Le coût unitaire ne peut pas être négatif').optional(),
  imei: z.string().trim().regex(/^\d{14,16}$/, 'L\'IMEI doit comporter 14 à 16 chiffres').optional(),
});

export type CsvInvoiceRow = z.infer<typeof CsvInvoiceRowSchema>;
