import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import { config } from './env.config'

const firebaseConfig = {
  type: 'service_account',
  project_id: config.firebase.project_id,
  private_key_id: config.firebase.private_key_id,
  privateKey: config.firebase.private_key ? config.firebase.private_key.replace(/\\n/g, '\n') : undefined,
  client_email: config.firebase.client_email,
  client_id: config.firebase.client_id,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url:
    'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: config.firebase.client_x509_cert_url,
}

// Check if a Firebase instance has already been initialized globally
const apps = getApps();
let firebaseApp;

if (!apps.length) {
  // Initialize a fresh Firebase Admin application instance
  firebaseApp = initializeApp({
    credential: cert(firebaseConfig),
  });
} else {
  // Reuse the existing active application instance
  firebaseApp = apps[0];
}

// Instantiate the Firebase Cloud Messaging instance for push notifications
export const messaging = getMessaging(firebaseApp);

export default firebaseApp;