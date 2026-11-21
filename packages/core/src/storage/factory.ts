import type { Config } from '../config/schema';
import type { StorageDriver } from '../plugins';
import { AzureBlobStorageDriver } from './azure';
import { GcsStorageDriver } from './gcs';
import { LocalStorageDriver } from './local';
import { S3StorageDriver } from './s3';

export type StorageDriverId = Config['storage']['driver'];
export const STORAGE_DRIVERS: readonly StorageDriverId[] = ['local', 's3', 'azure', 'gcs'];

/** Builds the driver for a configuration; the server passes this, tests may pass a fake. */
export type StorageFactory = (storage: Config['storage'], opts: { dataDir: string; driver?: StorageDriverId }) => Promise<StorageDriver>;

/**
 * The driver named by `storage.driver` (or `opts.driver`, for migrations),
 * from the `storage.<driver>.*` settings. Cloud SDKs are imported here, on
 * demand, so a server on local storage never loads them (D-065).
 */
export const createStorageDriver: StorageFactory = async (storage, opts) => {
  const id = opts.driver ?? storage.driver;
  const timeouts = { connectMs: storage.connectTimeoutSeconds * 1000, requestMs: storage.requestTimeoutSeconds * 1000, maxAttempts: storage.maxAttempts };
  switch (id) {
    case 'local':
      return new LocalStorageDriver(opts.dataDir);
    case 's3': {
      const s = storage.s3;
      return S3StorageDriver.create({
        bucket: s.bucket ?? '',
        region: s.region,
        endpoint: s.endpoint,
        publicEndpoint: s.publicEndpoint,
        forcePathStyle: s.forcePathStyle,
        prefix: s.prefix,
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
        sessionToken: s.sessionToken,
        serverSideEncryption: s.serverSideEncryption,
        kmsKeyId: s.kmsKeyId,
        timeouts,
      });
    }
    case 'azure': {
      const a = storage.azure;
      return AzureBlobStorageDriver.create({
        container: a.container ?? '',
        connectionString: a.connectionString,
        accountUrl: a.accountUrl,
        managedIdentityClientId: a.managedIdentityClientId,
        prefix: a.prefix,
        encryptionScope: a.encryptionScope,
        timeouts,
      });
    }
    case 'gcs': {
      const g = storage.gcs;
      return GcsStorageDriver.create({ bucket: g.bucket ?? '', projectId: g.projectId, prefix: g.prefix, credentialsJson: g.credentialsJson, apiEndpoint: g.apiEndpoint, kmsKeyName: g.kmsKeyName, timeouts });
    }
    default:
      throw new Error(`unknown storage driver "${String(id)}"; use one of ${STORAGE_DRIVERS.join(', ')}`);
  }
};
