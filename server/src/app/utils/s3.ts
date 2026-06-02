import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import httpStatus from 'http-status'
import path from 'path';
import { config } from '../config/env.config';
import { s3Client } from '../config/s3.config';
import ApiError from '../errors/ApiError';

//upload a single file
export const uploadToS3 = async (
  { file, fileName }: { file: any; fileName?: string },
): Promise<string | null> => {
  const ext = path.extname(file.originalname);
  const baseName = fileName || `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const finalKey = `${baseName}${ext || ''}`;

  const command = new PutObjectCommand({
    Bucket: config.aws.bucket,
    Key: finalKey,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  try {
    await s3Client.send(command);

    const url = `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${finalKey}`;
    return url;
  } catch (error) {
    console.log(error);
    throw new ApiError(httpStatus.BAD_REQUEST, 'File Upload failed');
  }
};

// delete file from s3 bucket
export const deleteFromS3 = async (key: string) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: config.aws.bucket,
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
      const baseName = key || randomPart;
      const newFileName = `${baseName}${ext || ''}`;
      const fileKey = `${folderPath}/${newFileName}`;

      const command = new PutObjectCommand({
        Bucket: config.aws.bucket as string,
        Key: fileKey,
        Body: file?.buffer,
        ContentType: file.mimetype,
      });

      await s3Client.send(command);

      const url = `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${fileKey}`;
      return { url, key: newFileName };
    });

    const uploadedUrls = await Promise.all(uploadPromises);
    return uploadedUrls;
  } catch (error) {
    throw new Error('File Upload failed');
  }
};

export const deleteManyFromS3 = async (keys: string[]) => {
  try {
    const deleteParams = {
      Bucket: config.aws.bucket,
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
