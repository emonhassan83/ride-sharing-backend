// src/app/modules/uploads/upload.service.ts
import httpStatus from 'http-status';
import { uploadManyToS3, uploadToS3 } from '../../utils/s3';
import ApiError from '../../errors/ApiError';

const multiple = async (files: any) => {
  let fileArray: any[] = [];

  // Normalize multer upload structures
  if (Array.isArray(files)) {
    fileArray = files;
  } else if (files?.files && Array.isArray(files.files)) {
    fileArray = files.files;
  } else if (typeof files === 'object') {
    Object.values(files).forEach((arr: any) => {
      if (Array.isArray(arr)) fileArray.push(...arr);
    });
  }

  if (!fileArray.length) {
    return [];
  }

  // ================== HELPERS ==================
  const getExtension = (file: any): string => {
    if (!file.originalname) return '';
    const parts = file.originalname.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  };

  const sanitizeFileName = (name: string): string => {
    if (!name) return 'file';
    return name
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .trim() || 'file';
  };

  const generateS3Key = (file: any): string => {
    const ext = getExtension(file);
    let baseName = 'file';

    if (file.originalname) {
      baseName = sanitizeFileName(
        file.originalname.replace(new RegExp(`\\.${ext}$`, 'i'), '')
      );
    }

    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);

    return `${baseName}-${timestamp}-${random}${ext ? `.${ext}` : ''}`;
  };

  const determineCategoryAndType = (file: any) => {
    const mimetype = file.mimetype?.toLowerCase() || '';
    const ext = getExtension(file);

    let path = 'others';
    let type = 'unknown';

    if (mimetype.startsWith('image/')) {
      path = 'images';
      type = 'image';
    } else if (mimetype.startsWith('video/')) {
      path = 'videos';
      type = 'video';
    } else if (mimetype.startsWith('audio/')) {
      path = 'audios';
      type = 'audio';
    } else if (mimetype === 'application/pdf' || ext === 'pdf') {
      path = 'documents';
      type = 'document_pdf';
    } else if (
      mimetype.startsWith('application/vnd.') ||
      ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext)
    ) {
      path = 'documents';
      type = 'document_office';
    } else if (
      mimetype === 'text/plain' ||
      mimetype === 'text/csv' ||
      ['txt', 'csv', 'md', 'log', 'json', 'xml', 'yaml', 'yml'].includes(ext)
    ) {
      path = 'documents';
      type = 'document_text';
    } else if (
      ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext) ||
      mimetype.includes('zip') || mimetype.includes('rar')
    ) {
      path = 'archives';
      type = 'archive';
    } else {
      path = 'others';
      type = 'unknown';
    }

    return { path, type };
  };

  // Prepare upload tasks
  const uploadTasks = fileArray.map((file: any) => {
    const { path } = determineCategoryAndType(file);
    const key = generateS3Key(file);   // Full key with extension

    return { file, path, key };
  });

  // Upload to S3
  const uploadedFiles = await uploadManyToS3(uploadTasks);

  // Build final response
  const result = uploadedFiles.map((item: any, index: number) => {
    const originalFile = fileArray[index];
    const sizeInMB = Number((originalFile.size / (1024 * 1024)).toFixed(4));
    const extension = getExtension(originalFile);
    const { type: file_type } = determineCategoryAndType(originalFile);

    return {
      url: item.url,
      size: sizeInMB,
      extension: extension ? `.${extension}` : null,
      type: file_type,
      mimetype: originalFile.mimetype,
      originalName: originalFile.originalname,
    };
  });

  return result;
};

// Single File Upload
const single = async (file: any) => {
  if (!file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'File is required');
  }

  const result = await uploadToS3({
    file,
    fileName: `images/${Math.floor(100000 + Math.random() * 900000)}`,
  });

  const fileSizeInMB = Number((file.size / (1024 * 1024)).toFixed(4));

  return {
    url: result,
    size: fileSizeInMB,
  };
};

export const UploadService = { multiple, single };