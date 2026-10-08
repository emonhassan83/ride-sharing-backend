import { S3Client } from '@aws-sdk/client-s3'
import { config } from './env.config'

const { endpoint, region, accessKeyId, secretAccessKey, forcePathStyle } = config.aws

export const s3Client = new S3Client({
  region: region || 'us-east-1',
  ...(endpoint ? { endpoint: `https://${endpoint}` } : {}),
  forcePathStyle,
  credentials: {
    accessKeyId: `${accessKeyId}`,
    secretAccessKey: `${secretAccessKey}`,
  },
  // Non-AWS S3 providers reject the SDK's default CRC32 checksum headers
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})
