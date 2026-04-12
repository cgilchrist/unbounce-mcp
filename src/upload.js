/**
 * Uploads a .unbounce file to Unbounce using the reverse-engineered two-step endpoint.
 * These endpoints are not in the public API but are stable — they're what the Unbounce UI uses.
 *
 * Step 1: GET presigned_post_fields.json → get S3 upload key
 * Step 2: POST import_upload.json → multipart upload with file + key + CSRF token
 */

import FormData from 'form-data'
import { UNBOUNCE_APP_BASE } from './config.js'

/**
 * @param {string} subAccountId
 * @param {Buffer} fileBuffer - The .unbounce TAR buffer
 * @param {string} fileName - e.g. "my-page.unbounce"
 * @param {string[]} cookies - Array of "name=value" strings from Playwright session
 * @param {string} csrfToken - authenticity_token from the Unbounce app page
 * @returns {Promise<void>}
 */
export async function uploadPage(subAccountId, fileBuffer, fileName, cookies, csrfToken) {
  const cookieHeader = cookies.join('; ')

  // Step 1: get presigned fields
  const presignedRes = await fetch(
    `${UNBOUNCE_APP_BASE}/${subAccountId}/page_uploads/presigned_post_fields.json`,
    {
      headers: {
        'Cookie': cookieHeader,
        'X-CSRF-Token': csrfToken,
      },
    }
  )
  if (!presignedRes.ok) {
    throw new Error(`Failed to get presigned upload fields: ${presignedRes.status}`)
  }
  const presigned = await presignedRes.json()
  const uploadKey = presigned.page_bundle_upload_key
  if (!uploadKey) {
    throw new Error('No upload key returned from presigned endpoint')
  }

  // Step 2: multipart upload
  const form = new FormData()
  form.append('upload[key]', uploadKey)
  form.append('authenticity_token', csrfToken)
  form.append('upload[file]', fileBuffer, {
    filename: fileName,
    contentType: 'application/octet-stream',
  })

  const uploadRes = await fetch(
    `${UNBOUNCE_APP_BASE}/${subAccountId}/page_uploads/import_upload.json`,
    {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        ...form.getHeaders(),
      },
      body: form.getBuffer(),
    }
  )

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '')
    throw new Error(`Upload failed (${uploadRes.status}): ${text}`)
  }
}
