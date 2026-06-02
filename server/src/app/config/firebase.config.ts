import admin from 'firebase-admin'
import { config } from './env.config'

const firebaseConfig = {
  type: 'service_account',
  project_id: config.firebase.project_id,
  private_key_id: config.firebase.private_key_id,
  private_key: config.firebase.private_key?.replace(/\\n/g, '\n'),
  client_email: config.firebase.client_email,
  client_id: config.firebase.client_id,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url:
    'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: config.firebase.client_x509_cert_url,
}

// prevent re-initialization
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      firebaseConfig as admin.ServiceAccount,
    ),
  })
}

export default admin