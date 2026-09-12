// Cloud credentials API wrappers (rules.md R6.2)
import { invoke } from '@tauri-apps/api/core';
import { toApiError } from './error';

export interface CloudCredentials {
  url: string;
  token: string;
}

export async function getCloudCredentials(): Promise<CloudCredentials | null> {
  try {
    return await invoke<CloudCredentials | null>('get_cloud_credentials');
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

export async function setCloudCredentials(url: string, token: string): Promise<void> {
  try {
    await invoke('set_cloud_credentials', { url, token });
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

export async function deleteCloudCredentials(): Promise<void> {
  try {
    await invoke('delete_cloud_credentials');
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}
