import { connectionManager } from './connection-manager.js';

export async function uploadFile(connectionName: string, localPath: string, remotePath: string): Promise<void> {
  const client = await connectionManager.getReadyClient(connectionName);

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (putErr) => {
        if (putErr) return reject(putErr);
        resolve();
      });
    });
  });
}

export async function downloadFile(connectionName: string, remotePath: string, localPath: string): Promise<void> {
  const client = await connectionManager.getReadyClient(connectionName);

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (getErr) => {
        if (getErr) return reject(getErr);
        resolve();
      });
    });
  });
}
