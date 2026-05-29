// Device-code login — mirrors `gh auth login` / OAuth 2.0 device flow.
//
// Backend contract (frames monorepo `backend/src/routes/auth.ts`):
//   POST /api/auth/device-code   (unauthenticated)
//     → 200 { deviceCode, userCode, verificationUrl, expiresIn, interval }
//   POST /api/auth/device-token  (unauthenticated, body { deviceCode })
//     → 428 { status: 'authorization_pending' }   (keep polling)
//     → 200 { status: 'complete', apiKey: 'frm_...' }
//     → 400 { status: 'expired' | 'denied' }
//
// The user approves in-browser at `verificationUrl` (the `/device` page) while
// logged in; that mints a key scoped to their account and flips the device code
// to approved. We never see their session — only the one-time `frm_...` key.

import { openBrowser } from './open-browser.mjs';

class DeviceAuthError extends Error {}

/**
 * Run the full device-code login against `backendUrl`.
 * Returns the minted `frm_...` apiKey, or throws DeviceAuthError on
 * expiry/denial/timeout. Network/transport failures bubble as-is so the
 * caller's try/catch can fall back to the manual path.
 */
export async function deviceLogin(backendUrl, { log = console.log } = {}) {
  const base = backendUrl.replace(/\/$/, '');

  const startRes = await fetch(`${base}/api/auth/device-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!startRes.ok) {
    throw new DeviceAuthError(
      `device-code request failed (HTTP ${startRes.status}). The backend may not yet expose the device-auth flow.`,
    );
  }
  const grant = await startRes.json();
  const { deviceCode, userCode, verificationUrl } = grant;
  const intervalMs = Math.max(1, Number(grant.interval) || 5) * 1000;
  const expiresMs = Math.max(30, Number(grant.expiresIn) || 600) * 1000;

  log('');
  log('  To finish setup, approve this device in your browser:');
  log(`    ${verificationUrl}`);
  log('');
  log(`  Verification code: ${userCode}`);
  log('  (Opening your browser. If it does not open, visit the URL above.)');
  log('');

  openBrowser(verificationUrl);

  const deadline = Date.now() + expiresMs;
  // OAuth device-flow politeness: respect the server interval between polls.
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let pollRes;
    try {
      pollRes = await fetch(`${base}/api/auth/device-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
    } catch {
      // Transient network blip — keep polling until the deadline.
      continue;
    }

    if (pollRes.status === 428) continue; // authorization_pending
    if (pollRes.ok) {
      const data = await pollRes.json();
      if (data.status === 'complete' && typeof data.apiKey === 'string') {
        return data.apiKey;
      }
      throw new DeviceAuthError('Unexpected device-token response.');
    }

    // 400 → expired or denied.
    let status = 'denied';
    try {
      ({ status } = await pollRes.json());
    } catch {
      /* keep default */
    }
    throw new DeviceAuthError(
      status === 'expired'
        ? 'Device code expired before approval.'
        : 'Device authorization was denied.',
    );
  }
  throw new DeviceAuthError('Timed out waiting for browser approval.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
