import { coday, estimate, claim, start, info } from './scripts.js';
import { logger } from './logger.js';
import fs from 'fs/promises';
import { banner } from './banner.js';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import HttpsProxyAgent from 'https-proxy-agent';

let headers = {
    'Content-Type': 'application/json',
};

// Function to read proxies from proxy.txt
async function getProxies() {
    try {
        const proxyData = await fs.readFile('proxy.txt', 'utf-8');
        return proxyData.split('\n').filter(line => line.trim());
    } catch (err) {
        logger("Failed to read proxy.txt. Make sure the file exists and is properly formatted.", "error");
        return [];
    }
}

// Function to get proxy agent
function getProxyAgent(proxyUrl) {
    if (proxyUrl.startsWith('socks5://')) {
        return new SocksProxyAgent(proxyUrl);
    } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
        return new HttpsProxyAgent(proxyUrl);
    } else {
        logger(`Invalid proxy URL: ${proxyUrl}`, "error");
        return null;
    }
}

// Function to check external IP via proxy
async function checkProxy(proxyUrl) {
    const agent = getProxyAgent(proxyUrl);
    if (!agent) return;

    try {
        const response = await fetch('https://api.ipify.org?format=json', { agent });
        const data = await response.json();
        logger(`External IP via proxy (${proxyUrl}): ${data.ip}`, "info");
    } catch (err) {
        logger(`Failed to check IP via proxy (${proxyUrl}): ${err.message}`, "error");
    }
}

async function readTokensAndIds() {
    try {
        const tokenData = await fs.readFile('token.txt', 'utf-8');
        const tokens = tokenData.split('\n').filter(line => line.trim());

        const idsData = await fs.readFile('unique_id.txt', 'utf-8');
        const uniqueIds = idsData.split('\n').filter(line => line.trim());

        if (tokens.length !== uniqueIds.length) {
            logger("Mismatch between the number of tokens and unique ID lines.", "error");
            return [];
        }

        const accounts = tokens.map((line, index) => {
            const [access_token, refresh_token] = line.split('|').map(token => token.trim());
            const ids = uniqueIds[index].split('|').map(id => id.trim());
            return { access_token, refresh_token, unique_ids: ids };
        });

        return accounts;
    } catch (err) {
        logger("Failed to read token or unique ID file:", "error", err.message);
        return [];
    }
}

// Refresh Token Function
async function refreshToken(refresh_token, accountIndex, proxyAgent) {
    logger(`Refreshing access token for Account ${accountIndex + 1}...`, "info");
    const payloadData = { refresh_token };
    const response = await coday("https://api.meshchain.ai/meshmain/auth/refresh-token", 'POST', headers, payloadData, proxyAgent);

    if (response && response.access_token) {
        const tokenLines = (await fs.readFile('token.txt', 'utf-8')).split('\n');
        tokenLines[accountIndex] = `${response.access_token}|${response.refresh_token}`;
        await fs.writeFile('token.txt', tokenLines.join('\n'), 'utf-8');
        logger(`Account ${accountIndex + 1} token refreshed successfully`, "success");
        return response.access_token;
    }
    logger(`Account ${accountIndex + 1} failed to refresh token`, "error");
    return null;
}

// Main process for a single account
async function processAccount({ access_token, refresh_token, unique_ids }, accountIndex, proxyAgent) {
    headers = {
        ...headers,
        Authorization: `Bearer ${access_token}`,
    };

    for (const unique_id of unique_ids) {
        const profile = await info(unique_id, headers, proxyAgent);

        if (profile.error) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Profile fetch failed, attempting to refresh token...`, "error");
            const newAccessToken = await refreshToken(refresh_token, accountIndex, proxyAgent);
            if (!newAccessToken) return;
            headers.Authorization = `Bearer ${newAccessToken}`;
        } else {
            const { name, total_reward } = profile;
            logger(`Account ${accountIndex + 1} | ${unique_id}: ${name} | Balance: ${total_reward}`, "success");
        }

        const filled = await estimate(unique_id, headers, proxyAgent);
        if (!filled) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to fetch estimate.`, "error");
            continue;
        }

        if (filled.value > 10) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Attempting to claim reward...`);
            const reward = await claim(unique_id, headers, proxyAgent);
            if (reward) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Claim successful! New Balance: ${reward}`, "success");
                await start(unique_id, headers, proxyAgent);
                logger(`Account ${accountIndex + 1} | ${unique_id}: Started mining again.`, "info");
            } else {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to claim reward.`, "error");
            }
        } else {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Mine already started. Mine value: ${filled.value}`, "info");
        }
    }
}

// Main function to process all accounts
async function main() {
    logger(banner, "debug");

    const proxies = await getProxies();
    if (proxies.length === 0) {
        logger("No proxies available. Ensure proxy.txt is properly configured.", "error");
        return;
    }

    let proxyIndex = 0;

    while (true) {
        const accounts = await readTokensAndIds();

        if (accounts.length === 0) {
            logger("No accounts to process.", "error");
            return;
        }

        for (let i = 0; i < accounts.length; i++) {
            const proxyUrl = proxies[proxyIndex];
            proxyIndex = (proxyIndex + 1) % proxies.length; // Rotate proxies

            logger(`Processing Account ${i + 1} with Proxy: ${proxyUrl}`, "info");
            await checkProxy(proxyUrl); // Log external IP for the proxy

            const proxyAgent = getProxyAgent(proxyUrl);
            await processAccount(accounts[i], i, proxyAgent);
        }

        await new Promise(resolve => setTimeout(resolve, 60000)); // Runs every 60 seconds
    }
}

// Run Main
main();
