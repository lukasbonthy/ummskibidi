const express = require('express');
const { chromium } = require('playwright');
const { extractFirstProxyVideo } = require('./src/extractor');

const app = express();
const PORT = process.env.PORT || 3000;
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 25000);

let browserPromise;

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }
  return browserPromise;
}

async function resolveMovie(movieId) {
  const sourceUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();
  const textBuckets = [];
  let firstResult = null;

  const checkText = (text, source = 'unknown') => {
    if (firstResult || !text) return;
    const result = extractFirstProxyVideo(String(text));
    if (result) {
      firstResult = { ...result, foundIn: source };
    }
  };

  page.on('request', (request) => {
    checkText(request.url(), `request:${request.resourceType()}`);
  });

  page.on('response', async (response) => {
    if (firstResult) return;
    const url = response.url();
    checkText(url, 'response-url');
    if (firstResult) return;

    const requestType = response.request().resourceType();
    const contentType = (response.headers()['content-type'] || '').toLowerCase();
    const length = Number(response.headers()['content-length'] || 0);

    const looksText =
      ['document', 'script', 'xhr', 'fetch'].includes(requestType) ||
      contentType.includes('text') ||
      contentType.includes('json') ||
      contentType.includes('javascript');

    if (!looksText) return;
    if (length && length > 5_000_000) return;

    try {
      const body = await response.text();
      textBuckets.push(body);
      checkText(body, `response-body:${requestType}`);
    } catch (_) {
      // Some responses cannot be read. Ignore them and keep scanning.
    }
  });

  try {
    await page.goto(sourceUrl, {
      waitUntil: 'domcontentloaded',
      timeout: SCAN_TIMEOUT_MS
    });

    // Give scripts/fetches/iframes a chance to create the proxy URL.
    await page.waitForTimeout(5000);

    checkText(await page.content(), 'page-html');

    // Some embeds reveal the URL only after clicking play-like controls.
    const selectors = [
      'button',
      '[role="button"]',
      '.play',
      '#play',
      '[class*="play"]',
      'video',
      'iframe'
    ];

    for (const selector of selectors) {
      if (firstResult) break;
      const handles = await page.$$(selector);
      for (const handle of handles.slice(0, 5)) {
        if (firstResult) break;
        try {
          await handle.click({ timeout: 800, force: true });
          await page.waitForTimeout(1200);
          checkText(await page.content(), `after-click:${selector}`);
        } catch (_) {}
      }
    }

    // Check frames too.
    for (const frame of page.frames()) {
      if (firstResult) break;
      try {
        checkText(frame.url(), 'frame-url');
        checkText(await frame.content(), 'frame-html');
      } catch (_) {}
    }

    // Storage sometimes contains the generated link.
    try {
      const storageDump = await page.evaluate(() => {
        const out = [];
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            out.push(`${k}=${store.getItem(k)}`);
          }
        }
        return out.join('\n');
      });
      checkText(storageDump, 'browser-storage');
    } catch (_) {}

    // Last fallback: scan all captured response bodies together.
    checkText(textBuckets.join('\n'), 'all-response-bodies');

    return {
      ok: Boolean(firstResult),
      movieId,
      sourceUrl,
      result: firstResult
    };
  } finally {
    await context.close().catch(() => {});
  }
}

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'MovieResolver API\n\nUse: GET /movie/{number}\nExample: /movie/1726\nHealth: /healthz\n'
  );
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/movie/:id', async (req, res) => {
  const movieId = String(req.params.id || '').trim();

  if (!/^\d+$/.test(movieId)) {
    return jsonError(res, 400, 'Movie id must be a number. Example: /movie/1726');
  }

  try {
    const scan = await resolveMovie(movieId);

    if (!scan.ok || !scan.result) {
      return jsonError(res, 404, 'No proxy-video URL found.', {
        movieId,
        sourceUrl: scan.sourceUrl
      });
    }

    return res.json({
      ok: true,
      movieId,
      sourceUrl: scan.sourceUrl,
      proxyVideo: scan.result.workingEncodedProxyUrl,
      originalCapturedUrl: scan.result.originalCapturedUrl,
      decodedProxyUrl: scan.result.decodedProxyUrl,
      decodedVideoUrl: scan.result.decodedVideoUrl,
      apikey: scan.result.apikey || null,
      referer: scan.result.referer || null,
      origin: scan.result.origin || null,
      foundIn: scan.result.foundIn
    });
  } catch (err) {
    return jsonError(res, 500, err.message || 'Scan failed.');
  }
});

app.use((req, res) => {
  jsonError(res, 404, 'Route not found. Use /movie/{number}.');
});

app.listen(PORT, () => {
  console.log(`MovieResolver API running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  try {
    const browser = await browserPromise;
    await browser?.close();
  } catch (_) {}
  process.exit(0);
});
