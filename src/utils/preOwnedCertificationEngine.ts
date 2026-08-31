/**
 * Professional Pre-Owned Device Certification & Catalog Ingestion Engine
 * Author: Principal Systems Architect
 */
import type { TradeInItem, Product, PreOwnedInspectionChecklist } from '../types/pos';
import { productRepository } from '../db/repositories/productRepository';
import { sqliteAdapter } from '../db/sqliteAdapter';

export class PreOwnedCertificationEngine {
  public static async intakeQuarantinedDevice(tradeIn: TradeInItem): Promise<void> {
    const quarantinedRecord: TradeInItem = {
      ...tradeIn,
      status: 'EN_TEST_DIAGNOSTIC',
    };
    await sqliteAdapter.saveTradeIn(quarantinedRecord);
  }

  public static async certifyAndPromoteToCatalog(
    tradeIn: TradeInItem,
    checklist: PreOwnedInspectionChecklist,
    resalePrice: number,
    warrantyMonths: number = 3
  ): Promise<Product> {
    if (!checklist.icloudFrpRemoved) {
      throw new Error(
        "Impossible de mettre en vente : Le compte iCloud / Google FRP n'est pas supprimé !"
      );
    }

    const certifiedProduct: Product = {
      id: `PROD-USED-${tradeIn.imei.slice(-8)}`,
      sku: `OCCASION-${tradeIn.imei.slice(-6)}`,
      barcode: tradeIn.imei,
      title: `${tradeIn.deviceModel} (Occasion ${checklist.chassisGrade}) - Batt. ${checklist.batteryHealthPercent}%`,
      brand: tradeIn.deviceModel.includes('iPhone') ? 'Apple' : 'Samsung',
      compatibleModel: tradeIn.deviceModel,
      category: "Téléphones d'Occasion (Reprise)",
      price: resalePrice,
      wholesalePrice: resalePrice,
      costPrice: tradeIn.buybackValue,
      stock: 1,
      isSerialized: true,
      imeiNumber: tradeIn.imei,
      warrantyMonths: warrantyMonths,
      reorderPoint: 0,
      imageUrl: '',
      vendorName: 'Client Comptoir (Reprise)',
      leadTimeDays: 0,
      dailySalesVelocity: 0,
    };

    const updatedTradeIn: TradeInItem = {
      ...tradeIn,
      status: 'PRET_A_LA_VENTE',
      targetResalePrice: resalePrice,
      inspectionChecklist: checklist,
      certifiedAt: new Date().toISOString(),
    };

    await productRepository.save(certifiedProduct);
    await sqliteAdapter.saveTradeIn(updatedTradeIn);
    await sqliteAdapter.saveIMEIRecord({
      imei: tradeIn.imei,
      productId: certifiedProduct.id,
      receivedAt: tradeIn.createdAt,
    });

    return certifiedProduct;
  }
}
