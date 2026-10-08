import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ObjectCannedACL,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import httpStatus from 'http-status'
import path from 'path';
import { config } from '../config/env.config';
import { s3Client } from '../config/s3.config';
import ApiError from '../errors/ApiError';

const { bucket, region, endpoint, publicUrl, forcePathStyle, objectAcl } = config.aws;

/** Public URL for an uploaded object (Hetzner: https://<bucket>.hel1.your-objectstorage.com/<key>). */
export const getPublicFileUrl = (key: string): string => {
  if (publicUrl) return `${publicUrl}/${key}`;
  if (endpoint) {
    return forcePathStyle
      ? `https://${endpoint}/${bucket}/${key}`
      : `https://${bucket}.${endpoint}/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

const aclOption = (): { ACL?: ObjectCannedACL } =>
  objectAcl && objectAcl !== 'none' ? { ACL: objectAcl as ObjectCannedACL } : {};

const describeError = (error: any): string =>
  [error?.name || error?.Code, error?.message].filter(Boolean).join(': ') || 'Unknown error';

//upload a single file
export const uploadToS3 = async (
  { file, fileName }: { file: any; fileName?: string },
): Promise<string | null> => {
  const ext = path.extname(file.originalname);
  const baseName = fileName || `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const finalKey = `${baseName}${ext || ''}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: finalKey,
    Body: file.buffer,
    ContentType: file.mimetype,
    ...aclOption(),
  });

  try {
    await s3Client.send(command);
    return getPublicFileUrl(finalKey);
  } catch (error) {
    console.error('uploadToS3 error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, `File Upload failed (${describeError(error)})`);
  }
};

// delete file from s3 bucket
export const deleteFromS3 = async (key: string) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
    await s3Client.send(command)
  } catch (error) {
    console.log('🚀 deleteFromS3 error:', error)
    throw new Error('s3 file delete failed')
  }
}

// upload multiple files
export const uploadManyToS3 = async (
  files: {
    file: any;
    path: string;
    key?: string;
  }[],
): Promise<{ url: string; key: string }[]> => {
  try {
    const uploadPromises = files.map(async ({ file, path: folderPath, key }) => {
      const ext = path.extname(file.originalname);
      const randomPart = `${Math.floor(100000 + Math.random() * 900000)}${Date.now()}`;

      // ✅ key already has extension (from generateS3Key) → don't add ext again
      const newFileName = key || `${randomPart}${ext || ''}`;
      const fileKey     = `${folderPath}/${newFileName}`;

      const command = new PutObjectCommand({
        Bucket:      bucket,
        Key:         fileKey,
        Body:        file?.buffer,
        ContentType: file.mimetype,
        ...aclOption(),
      });

      await s3Client.send(command);

      return { url: getPublicFileUrl(fileKey), key: newFileName };
    });

    const uploadedUrls = await Promise.all(uploadPromises);
    return uploadedUrls;
  } catch (error) {
    console.error('uploadManyToS3 error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, `File Upload failed (${describeError(error)})`);
  }
};

export const deleteManyFromS3 = async (keys: string[]) => {
  try {
    const deleteParams = {
      Bucket: bucket,
      Delete: {
        Objects: keys.map((key) => ({ Key: key })),
        Quiet: false,
      },
    }
    const command = new DeleteObjectsCommand(deleteParams)
    const response = await s3Client.send(command)
    return response
  } catch (error) {
    console.error('Error deleting S3 files:', error)
    throw new ApiError(httpStatus.BAD_REQUEST, 'S3 file delete failed')
  }
}
