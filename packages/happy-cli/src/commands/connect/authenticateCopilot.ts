/**
 * Copilot OAuth Authentication
 *
 * Implements GitHub OAuth device flow for Copilot CLI authentication.
 *
 * Device flow steps:
 * 1. POST https://github.com/login/device/code to get device_code + user_code
 * 2. Display user_code and verification_uri to user
 * 3. Open browser to verification_uri
 * 4. Poll https://github.com/login/oauth/access_token until user completes auth
 * 5. Return access_token
 */

import chalk from 'chalk';
import open from 'open';

// GitHub OAuth App Client ID for Happy CLI (Copilot access).
// Uses the device flow — no client secret required (public client).
//
// To obtain this ID, the project maintainer must register an OAuth App at:
//   https://github.com/settings/applications/new
//
// Required settings:
//   - "Enable Device Flow" must be checked
//   - Callback URL can be http://localhost (unused by device flow)
//
// The resulting Client ID (e.g., "Iv23li...") replaces the placeholder below.
// This should be done by whoever operates the Happy server, not individual contributors.
const GITHUB_CLIENT_ID = 'Iv1.XXXXXXXXXXXXXXXX';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPES = 'copilot read:user';

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

interface TokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

export async function authenticateCopilot(): Promise<TokenResponse> {
    // Step 1: Request device code
    console.log(chalk.gray('  Requesting device authorization...'));

    const deviceCodeRes = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            scope: SCOPES,
        }),
    });

    if (!deviceCodeRes.ok) {
        throw new Error(`Failed to request device code: ${deviceCodeRes.status} ${deviceCodeRes.statusText}`);
    }

    const deviceCode = await deviceCodeRes.json() as DeviceCodeResponse;

    // Step 2: Display instructions
    console.log('');
    console.log(chalk.bold('  📋 Your code: ') + chalk.cyan.bold(deviceCode.user_code));
    console.log('');
    console.log(chalk.gray(`  Open ${deviceCode.verification_uri} and enter the code above`));
    console.log('');

    // Step 3: Open browser
    try {
        await open(deviceCode.verification_uri);
        console.log(chalk.gray('  Browser opened. Waiting for authorization...'));
    } catch {
        console.log(chalk.yellow('  Could not open browser. Please open the URL above manually.'));
    }

    // Step 4: Poll for access token
    const expiresAt = Date.now() + deviceCode.expires_in * 1000;
    const interval = (deviceCode.interval || 5) * 1000;

    while (Date.now() < expiresAt) {
        await new Promise(resolve => setTimeout(resolve, interval));

        const tokenRes = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                device_code: deviceCode.device_code,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });

        if (!tokenRes.ok) {
            continue;
        }

        const tokenData = await tokenRes.json() as Record<string, string>;

        if (tokenData.error === 'authorization_pending') {
            continue;
        }

        if (tokenData.error === 'slow_down') {
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
        }

        if (tokenData.error) {
            throw new Error(`GitHub OAuth error: ${tokenData.error} - ${tokenData.error_description || ''}`);
        }

        if (tokenData.access_token) {
            console.log(chalk.green('  ✓ Authorization successful!'));
            return {
                access_token: tokenData.access_token,
                token_type: tokenData.token_type || 'bearer',
                scope: tokenData.scope || SCOPES,
            };
        }
    }

    throw new Error('Authorization timed out. Please try again.');
}
