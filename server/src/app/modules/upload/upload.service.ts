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

  // Helper: Get extension (without dot)
  const getExtension = (file: any): string => {
    if (!file.originalname) return '';
    const parts = file.originalname.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  };

  // Helper: Sanitize filename (remove dangerous chars)
  const sanitizeFileName = (name: string): string => {
    if (!name) return 'file';
    return (
      name
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .trim() || 'file'
    );
  };

  // Generate safe, unique S3 key with original name preserved
  const generateS3Key = (file: any): string => {
    const ext = getExtension(file);
    let baseName = 'file';

    if (file.originalname) {
      baseName = sanitizeFileName(
        file.originalname.replace(new RegExp(`\\.${ext}$`, 'i'), ''),
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

    // Images
    if (mimetype.startsWith('image/')) {
      path = 'images';
      type = 'image';
    }
    // Videos
    else if (mimetype.startsWith('video/')) {
      path = 'videos';
      type = 'video';
    }
    // Audios
    else if (mimetype.startsWith('audio/')) {
      path = 'audios';
      type = 'audio';
    }
    // PDFs
    else if (mimetype === 'application/pdf' || ext === 'pdf') {
      path = 'documents';
      type = 'document_pdf';
    }
    // Office documents
    else if (
      mimetype.startsWith('application/vnd.') ||
      [
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'odt',
        'ods',
        'odp',
      ].includes(ext)
    ) {
      path = 'documents';
      type = 'document_office';
    }
    // Plain text / CSV / Markdown
    else if (
      mimetype === 'text/plain' ||
      mimetype === 'text/csv' ||
      ['txt', 'csv', 'md', 'log', 'json', 'xml', 'yaml', 'yml'].includes(ext)
    ) {
      path = 'documents';
      type = 'document_text';
    }
    // Archives
    else if (
      [
        'application/zip',
        'application/x-zip-compressed',
        'application/x-rar-compressed',
        'application/x-7z-compressed',
        'application/x-tar',
        'application/gzip',
      ].includes(mimetype) ||
      ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)
    ) {
      path = 'archives';
      type = 'archive';
    }
    // Fonts
    else if (
      mimetype.startsWith('font/') ||
      mimetype === 'application/font-woff' ||
      ['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext)
    ) {
      path = 'fonts';
      type = 'font';
    }
    // Code / Scripts (NEW)
    else if (
      [
        'js',
        'ts',
        'py',
        'java',
        'cpp',
        'c',
        'cs',
        'go',
        'php',
        'rb',
        'swift',
        'kt',
        'rs',
        'sh',
        'bash',
        'html',
        'css',
        'scss',
      ].includes(ext) ||
      mimetype === 'application/javascript' ||
      mimetype === 'text/x-python' ||
      mimetype.startsWith('text/x-')
    ) {
      path = 'code';
      type = 'code_source';
    }
    // 3D Models / CAD (NEW)
    else if (
      ['stl', 'obj', 'fbx', 'glb', 'gltf', 'blend', '3ds', 'dae'].includes(
        ext,
      ) ||
      mimetype === 'model/gltf-binary' ||
      mimetype === 'application/octet-stream' // common for .glb/.stl
    ) {
      path = 'models';
      type = 'model_3d';
    }
    // Executable / Binary (NEW - but stored separately for review/security)
    else if (
      ['exe', 'msi', 'dmg', 'apk', 'deb', 'rpm', 'bin', 'app'].includes(ext) ||
      mimetype === 'application/x-msdownload' ||
      mimetype === 'application/octet-stream'
    ) {
      path = 'binaries';
      type = 'executable';
    }
    // Subtitle files (NEW)
    else if (['srt', 'vtt', 'ass', 'ssa'].includes(ext)) {
      path = 'subtitles';
      type = 'subtitle';
    }

    return { path, type };
  };

  // Prepare upload tasks — NOW WITH KEY!
  const uploadTasks = fileArray.map((file: any) => {
    const { path } = determineCategoryAndType(file);
    const key = generateS3Key(file); // This is the fix!

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
      originalName: originalFile.originalname, // Optional: nice to have
    };
  });

  return result;
};

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
