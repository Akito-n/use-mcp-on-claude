#!/usr/bin/env node
import { authenticateAndSaveCredentials } from './googleDrive'

// 認証処理を実行
authenticateAndSaveCredentials()
  .then(() => {
    console.error('Authentication completed successfully!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Authentication failed:', error)
    process.exit(1)
  })
