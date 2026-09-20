// Cloud credentials API wrappers (rules.md R6.2)
import { invokeCommand } from '../platform/invoke';

export interface CloudCredentials {
  url: string;
  token: string;
}

export async function getCloudCredentials(): Promise<CloudCredentials | null> {
  return invokeCommand<CloudCredentials | null>('get_cloud_credentials');
}

export async function setCloudCredentials(url: string, token: string): Promise<void> {
  await invokeCommand('set_cloud_credentials', { url, token });
}

export async function deleteCloudCredentials(): Promise<void> {
  await invokeCommand('delete_cloud_credentials');
}