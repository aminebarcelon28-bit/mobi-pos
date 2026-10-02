import React, { useState, useCallback } from 'react';
import { ReplenishmentModal, mockSuppliers, mockKPIs, type FilterCategory, type SupplierItem, type SupplierActionState } from '.';

interface ReplenishmentDemoProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ReplenishmentDemo: React.FC<ReplenishmentDemoProps> = ({ isOpen, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('ALL');
  const [suppliers] = useState<SupplierItem[]>(mockSuppliers);
  const [actionStates, setActionStates] = useState<Record<string, SupplierActionState>>({});

  const handleCreatePO = useCallback(async (supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    if (!supplier) return;
    
    setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: true, isLoadingContact: false } }));
    
    try {
      console.log('Create PO for:', supplier?.name);
      await new Promise(resolve => setTimeout(resolve, 1000));
      alert(`Créer bon de commande pour ${supplier?.name}`);
    } finally {
      setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: false, isLoadingContact: false } }));
    }
  }, [suppliers]);

  const handleViewDetails = useCallback((supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    console.log('View details for:', supplier?.name);
    alert(`Voir détails de ${supplier?.name}`);
  }, [suppliers]);

  const handleContactAction = useCallback(async (supplierId: string, action: 'call' | 'whatsapp' | 'email') => {
    const supplier = suppliers.find(s => s.id === supplierId);
    const contact = supplier?.contact;
    let message = '';
    
    setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: false, isLoadingContact: true } }));
    
    try {
      switch (action) {
        case 'call':
          message = contact?.phone ? `Appeler ${contact.phone}` : 'Numéro non disponible';
          break;
        case 'whatsapp':
          message = contact?.whatsapp ? `WhatsApp ${contact.whatsapp}` : 
                    contact?.phone ? `WhatsApp ${contact.phone}` : 'Numéro non disponible';
          break;
        case 'email':
          message = contact?.email ? `Email ${contact.email}` : 'Email non disponible';
          break;
      }
      console.log(`${action} for:`, supplier?.name, message);
      await new Promise(resolve => setTimeout(resolve, 500));
      alert(message);
    } finally {
      setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: false, isLoadingContact: false } }));
    }
  }, [suppliers]);

  const handleAddContact = useCallback(async (supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    
    setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: false, isLoadingContact: true } }));
    
    try {
      console.log('Add contact for:', supplier?.name);
      await new Promise(resolve => setTimeout(resolve, 500));
      alert(`Ajouter/Modifier contact pour ${supplier?.name}`);
    } finally {
      setActionStates(prev => ({ ...prev, [supplierId]: { isCreatingPO: false, isLoadingContact: false } }));
    }
  }, [suppliers]);

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setActiveFilter('ALL');
  }, []);

  return (
    <ReplenishmentModal
      isOpen={isOpen}
      onClose={onClose}
      kpis={mockKPIs}
      suppliers={suppliers}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onCreatePO={handleCreatePO}
      onViewDetails={handleViewDetails}
      onContactAction={handleContactAction}
      onAddContact={handleAddContact}
      onResetFilters={handleResetFilters}
      actionStates={actionStates}
    />
  );
};

export default ReplenishmentDemo;