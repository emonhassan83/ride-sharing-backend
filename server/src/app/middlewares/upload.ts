import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

// Utility function to create a multer instance with custom settings
const createUploadMiddleware = (maxSizeMB: number = 20, allowedFileTypes: string[] | string = 'all') => {
  // Ensure uploads directory exists
  const ensureUploadsDirectory = () => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    return uploadDir;
  };

  // Set up the storage engine for multer
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Store files in the 'uploads' directory (create if doesn't exist)
      const uploadDir = ensureUploadsDirectory();
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      // Generate a random file name using UUID and add the file extension
      const randomFileName = uuidv4() + path.extname(file.originalname);
      cb(null, randomFileName);
    },
  });

  // File filter to accept only specific file types
  const fileFilter = (req: any, file: any, cb: any) => {
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (allowedFileTypes === 'all' || allowedFileTypes.includes(fileExtension)) {
      cb(null, true); // Accept the file
    } else {
      cb(new Error('Invalid file type'), false); // Reject the file
    }
  };

  // Create the upload middleware with dynamic settings
  return multer({
    storage,
    limits: { fileSize: maxSizeMB * 1024 * 1024 }, // Max file size
    fileFilter,
  });
};

export default createUploadMiddleware;
