import { useState, useEffect } from 'react';
import { getDeviceRole, setDeviceRoleOverride, type DeviceRole } from '../utils/platform';

export function useDeviceMode() {
  const [role, setRole] = useState<DeviceRole>(() => getDeviceRole());

  useEffect(() => {
    const updateRole = () => {
      setRole(getDeviceRole());
    };

    window.addEventListener('resize', updateRole);
    window.addEventListener('mobi:devicerole-change', updateRole);

    return () => {
      window.removeEventListener('resize', updateRole);
      window.removeEventListener('mobi:devicerole-change', updateRole);
    };
  }, []);

  const setRoleMode = (newRole: DeviceRole | null) => {
    setDeviceRoleOverride(newRole);
    setRole(getDeviceRole());
  };

  const toggleMobileMode = () => {
    if (role === 'companion_mobile') {
      setRoleMode('pos_primary');
    } else {
      setRoleMode('companion_mobile');
    }
  };

  return {
    role,
    isMobile: role === 'companion_mobile',
    isDesktop: role === 'pos_primary',
    setRoleMode,
    toggleMobileMode,
  };
}
