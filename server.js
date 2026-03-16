const express = require("express");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");
const cheerio = require("cheerio");
const stream = require("stream");

// ============================================================
// CONFIGURATION
// ============================================================
const TARGET_HOST = process.env.TARGET_HOST || "coretaxdjp.pajak.go.id";
const TARGET_PROTOCOL = process.env.TARGET_PROTOCOL || "https";
const PORT = parseInt(process.env.PORT, 10) || 3000;
// YOUR_DOMAIN: set this to your actual proxy domain (e.g. "coretaxdjp.yourdomain.com")
// If not set, it will be auto-detected from the Host header
const YOUR_DOMAIN = process.env.YOUR_DOMAIN || "";

const app = express();

// Disable x-powered-by for security
app.disable("x-powered-by");

// Trust proxy (for Railway, Render, Fly.io behind load balancers)
app.set("trust proxy", true);

// ============================================================
// HELPERS
// ============================================================
function getProxyDomain(req) {
  if (YOUR_DOMAIN) return YOUR_DOMAIN;
  return req.get("host") || req.hostname;
}

function getProxyProtocol(req) {
  return req.protocol || "https";
}

function getProxyOrigin(req) {
  return `${getProxyProtocol(req)}://${getProxyDomain(req)}`;
}

/**
 * Decompress response body based on content-encoding
 */
function decompressBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (!encoding) return resolve(buffer);
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip") {
      zlib.gunzip(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (enc === "deflate") {
      zlib.inflate(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (enc === "br") {
      zlib.brotliDecompress(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else {
      resolve(buffer);
    }
  });
}

/**
 * Rewrite all URLs in HTML content:
 * - Replace target hostname with proxy hostname
 * - Ensure canonical tag points to proxy domain
 * - Rewrite meta tags, og tags, etc.
 * - Add SEO-friendly meta if missing
 */
function rewriteHTML(html, req) {
  const proxyDomain = getProxyDomain(req);
  const proxyOrigin = getProxyOrigin(req);
  const targetOrigin = `${TARGET_PROTOCOL}://${TARGET_HOST}`;

  const $ = cheerio.load(html, { decodeEntities: false });

  // --- 1. Rewrite canonical link to prevent duplicate content ---
  const currentPath = req.originalUrl || req.url;
  const canonicalUrl = `${proxyOrigin}${currentPath}`;

  // Remove existing canonical links and add our own
  $('link[rel="canonical"]').remove();
  $("head").append(`<link rel="canonical" href="${canonicalUrl}" />`);

  // --- 2. Add/update meta robots - allow indexing ---
  $('meta[name="robots"]').remove();
  $("head").append('<meta name="robots" content="index, follow" />');

  // --- 3. Rewrite Open Graph / Twitter meta tags ---
  $('meta[property="og:url"]').attr("content", canonicalUrl);
  $('meta[name="twitter:url"]').attr("content", canonicalUrl);
  $('meta[property="og:site_name"]').each(function () {
    const val = $(this).attr("content") || "";
    $(this).attr("content", val.replace(TARGET_HOST, proxyDomain));
  });

  // --- 4. Rewrite all href/src/action attributes ---
  const urlAttrs = [
    { sel: "[href]", attr: "href" },
    { sel: "[src]", attr: "src" },
    { sel: "[action]", attr: "action" },
    { sel: "[data-src]", attr: "data-src" },
    { sel: "[data-href]", attr: "data-href" },
    { sel: "[poster]", attr: "poster" },
    { sel: "[srcset]", attr: "srcset" },
  ];

  for (const { sel, attr } of urlAttrs) {
    $(sel).each(function () {
      let val = $(this).attr(attr);
      if (!val) return;

      if (attr === "srcset") {
        // srcset has format: "url size, url size, ..."
        val = val.replace(
          new RegExp(`(https?:)?//${escapeRegex(TARGET_HOST)}`, "gi"),
          ""
        );
        $(this).attr(attr, val);
        return;
      }

      // Replace absolute URLs pointing to target
      val = val.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      val = val.replace(
        new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
        `//${proxyDomain}`
      );

      $(this).attr(attr, val);
    });
  }

  // --- 5. Rewrite inline styles with url() ---
  $("[style]").each(function () {
    let style = $(this).attr("style");
    if (style && style.includes(TARGET_HOST)) {
      style = style.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      style = style.replace(
        new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
        `//${proxyDomain}`
      );
      $(this).attr("style", style);
    }
  });

  // --- 6. Rewrite <style> blocks ---
  $("style").each(function () {
    let css = $(this).html();
    if (css && css.includes(TARGET_HOST)) {
      css = css.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      css = css.replace(
        new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
        `//${proxyDomain}`
      );
      $(this).html(css);
    }
  });

  // --- 7. Rewrite inline <script> blocks ---
  $("script").each(function () {
    let js = $(this).html();
    if (js && js.includes(TARGET_HOST)) {
      js = js.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      js = js.replace(
        new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
        `//${proxyDomain}`
      );
      $(this).html(js);
    }
  });

  // --- 8. Rewrite <base> tag if present ---
  $("base[href]").each(function () {
    let val = $(this).attr("href");
    val = val.replace(
      new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
      proxyOrigin
    );
    $(this).attr("href", val);
  });

  // --- 9. Rewrite alternate/hreflang links ---
  $('link[rel="alternate"]').each(function () {
    let val = $(this).attr("href");
    if (val && val.includes(TARGET_HOST)) {
      val = val.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      $(this).attr("href", val);
    }
  });

  return $.html();
}

/**
 * Rewrite CSS content: replace target host URLs
 */
function rewriteCSS(css, req) {
  const proxyOrigin = getProxyOrigin(req);
  const proxyDomain = getProxyDomain(req);

  css = css.replace(
    new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
    proxyOrigin
  );
  css = css.replace(
    new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
    `//${proxyDomain}`
  );
  return css;
}

/**
 * Rewrite JS content: replace target host references
 */
function rewriteJS(js, req) {
  const proxyOrigin = getProxyOrigin(req);
  const proxyDomain = getProxyDomain(req);

  js = js.replace(
    new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
    proxyOrigin
  );
  js = js.replace(
    new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
    `//${proxyDomain}`
  );
  // Also handle escaped URLs in JSON strings
  js = js.replace(
    new RegExp(`${escapeRegex(TARGET_PROTOCOL)}:\\\\/\\\\/${escapeRegex(TARGET_HOST)}`, "gi"),
    `${proxyOrigin.replace(/\//g, "\\/")}`
  );
  return js;
}

/**
 * Rewrite JSON content
 */
function rewriteJSON(json, req) {
  const proxyOrigin = getProxyOrigin(req);
  const proxyDomain = getProxyDomain(req);

  json = json.replace(
    new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
    proxyOrigin
  );
  json = json.replace(
    new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
    `//${proxyDomain}`
  );
  // Handle escaped slashes in JSON
  json = json.replace(
    new RegExp(
      `${escapeRegex(TARGET_PROTOCOL)}:\\\\/\\\\/${escapeRegex(TARGET_HOST).replace(/\./g, "\\\\.")}`,
      "gi"
    ),
    `${getProxyProtocol(req)}:\\/\\/${proxyDomain.replace(/\./g, "\\.")}`
  );
  return json;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Determine content type category from Content-Type header
 */
function getContentCategory(contentType) {
  if (!contentType) return "binary";
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return "html";
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  if (ct.includes("application/json") || ct.includes("+json")) return "json";
  if (ct.includes("text/xml") || ct.includes("application/xml") || ct.includes("+xml")) return "html"; // treat XML like HTML for rewrites
  if (ct.includes("text/")) return "text";
  return "binary";
}

// ============================================================
// SITEMAP ROUTE (for SEO)
// ============================================================
app.get("/robots.txt", async (req, res) => {
  const proxyOrigin = getProxyOrigin(req);
  // First try to fetch the original robots.txt
  try {
    const targetUrl = `${TARGET_PROTOCOL}://${TARGET_HOST}/robots.txt`;
    const body = await fetchRaw(targetUrl, req);
    let robotsTxt = body.toString("utf-8");

    // Rewrite any sitemap URLs to point to our domain
    robotsTxt = robotsTxt.replace(
      new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
      proxyOrigin
    );

    // Ensure our sitemap is referenced
    if (!robotsTxt.toLowerCase().includes("sitemap:")) {
      robotsTxt += `\nSitemap: ${proxyOrigin}/sitemap.xml\n`;
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(robotsTxt);
  } catch {
    // Fallback robots.txt
    const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${proxyOrigin}/sitemap.xml\n`;
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(robotsTxt);
  }
});

// ============================================================
// MAIN PROXY HANDLER
// ============================================================
app.all("*", async (req, res) => {
  try {
    const proxyDomain = getProxyDomain(req);
    const proxyOrigin = getProxyOrigin(req);
    const targetUrl = `${TARGET_PROTOCOL}://${TARGET_HOST}${req.originalUrl}`;

    // --- Build upstream request headers ---
    const upstreamHeaders = {};
    const skipHeaders = new Set([
      "host",
      "connection",
      "accept-encoding",
      "cf-connecting-ip",
      "cf-ray",
      "cf-visitor",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-forwarded-host",
      "x-real-ip",
    ]);

    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipHeaders.has(key.toLowerCase())) {
        upstreamHeaders[key] = value;
      }
    }

    upstreamHeaders["host"] = TARGET_HOST;
    upstreamHeaders["accept-encoding"] = "gzip, deflate, br";

    // Rewrite Referer/Origin headers
    if (upstreamHeaders["referer"]) {
      upstreamHeaders["referer"] = upstreamHeaders["referer"].replace(
        new RegExp(escapeRegex(proxyDomain), "gi"),
        TARGET_HOST
      );
    }
    if (upstreamHeaders["origin"]) {
      upstreamHeaders["origin"] = `${TARGET_PROTOCOL}://${TARGET_HOST}`;
    }

    // --- Collect request body for non-GET/HEAD ---
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });

      // Rewrite body if it's form data containing our proxy domain
      if (body.length > 0) {
        const bodyStr = body.toString("utf-8");
        if (bodyStr.includes(proxyDomain)) {
          body = Buffer.from(
            bodyStr.replace(new RegExp(escapeRegex(proxyDomain), "gi"), TARGET_HOST)
          );
          upstreamHeaders["content-length"] = body.length.toString();
        }
      }
    }

    // --- Make upstream request ---
    const upstreamResponse = await makeRequest(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body,
      maxRedirects: 0, // Handle redirects manually
    });

    // --- Handle redirects ---
    const statusCode = upstreamResponse.statusCode;
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      let location = upstreamResponse.headers["location"] || "";
      // Rewrite redirect location to use proxy domain
      location = location.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      location = location.replace(
        new RegExp(`//${escapeRegex(TARGET_HOST)}`, "gi"),
        `//${proxyDomain}`
      );

      const responseHeaders = processResponseHeaders(upstreamResponse.headers, req);
      responseHeaders["location"] = location;

      for (const [key, value] of Object.entries(responseHeaders)) {
        res.setHeader(key, value);
      }
      return res.status(statusCode).end();
    }

    // --- Process response headers ---
    const responseHeaders = processResponseHeaders(upstreamResponse.headers, req);

    const contentType = upstreamResponse.headers["content-type"] || "";
    const contentEncoding = upstreamResponse.headers["content-encoding"] || "";
    const category = getContentCategory(contentType);

    // --- For binary content, stream directly ---
    if (category === "binary") {
      // Remove content-encoding since we pass through as-is
      for (const [key, value] of Object.entries(responseHeaders)) {
        res.setHeader(key, value);
      }
      res.status(statusCode);
      upstreamResponse.pipe(res);
      return;
    }

    // --- For text content, buffer, decompress, rewrite, send ---
    const rawBody = await streamToBuffer(upstreamResponse);
    let textBody;

    try {
      const decompressed = await decompressBody(rawBody, contentEncoding);
      textBody = decompressed.toString("utf-8");
    } catch {
      // If decompression fails, try raw
      textBody = rawBody.toString("utf-8");
    }

    // Rewrite content based on type
    switch (category) {
      case "html":
        textBody = rewriteHTML(textBody, req);
        break;
      case "css":
        textBody = rewriteCSS(textBody, req);
        break;
      case "js":
        textBody = rewriteJS(textBody, req);
        break;
      case "json":
        textBody = rewriteJSON(textBody, req);
        break;
      case "text":
        // Generic text rewrite
        textBody = textBody.replace(
          new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
          proxyOrigin
        );
        break;
    }

    // Remove content-encoding since we've decompressed
    delete responseHeaders["content-encoding"];
    // Update content-length
    const responseBuffer = Buffer.from(textBody, "utf-8");
    responseHeaders["content-length"] = responseBuffer.length.toString();

    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }

    res.status(statusCode).send(responseBuffer);
  } catch (err) {
    console.error(`[PROXY ERROR] ${req.method} ${req.originalUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(502).send("Bad Gateway");
    }
  }
});

// ============================================================
// RESPONSE HEADER PROCESSING
// ============================================================
function processResponseHeaders(headers, req) {
  const proxyDomain = getProxyDomain(req);
  const proxyOrigin = getProxyOrigin(req);
  const result = {};

  const skipResponseHeaders = new Set([
    "transfer-encoding",
    "connection",
    "keep-alive",
    "strict-transport-security", // Don't forward HSTS from target
    "content-security-policy", // Let the proxy define its own CSP
    "content-security-policy-report-only",
    "x-frame-options",
    "alt-svc",
  ]);

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (skipResponseHeaders.has(lowerKey)) continue;

    if (lowerKey === "set-cookie") {
      // Rewrite cookie domains
      const cookies = Array.isArray(value) ? value : [value];
      const rewritten = cookies.map((cookie) => {
        let c = cookie.replace(
          new RegExp(`domain=${escapeRegex(TARGET_HOST)}`, "gi"),
          `domain=${proxyDomain}`
        );
        c = c.replace(
          new RegExp(`domain=\\.${escapeRegex(TARGET_HOST)}`, "gi"),
          `domain=.${proxyDomain}`
        );
        return c;
      });
      result[key] = rewritten;
      continue;
    }

    if (lowerKey === "location") {
      let loc = Array.isArray(value) ? value[0] : value;
      loc = loc.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      result[key] = loc;
      continue;
    }

    if (lowerKey === "link") {
      let linkVal = Array.isArray(value) ? value.join(", ") : value;
      linkVal = linkVal.replace(
        new RegExp(`${escapeRegex(TARGET_PROTOCOL)}://${escapeRegex(TARGET_HOST)}`, "gi"),
        proxyOrigin
      );
      result[key] = linkVal;
      continue;
    }

    result[key] = value;
  }

  // Add security headers
  result["x-content-type-options"] = "nosniff";

  return result;
}

// ============================================================
// HTTP REQUEST HELPER
// ============================================================
function makeRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === "https:" ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: 30000,
    };

    const upstreamReq = lib.request(reqOptions, (upstreamRes) => {
      resolve(upstreamRes);
    });

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy();
      reject(new Error("Upstream request timeout"));
    });

    if (options.body) {
      upstreamReq.write(options.body);
    }

    upstreamReq.end();
  });
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (chunk) => chunks.push(chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

function fetchRaw(url, req) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    lib
      .get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { host: parsed.hostname, "accept-encoding": "identity" },
          timeout: 10000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MIRROR PROXY] Running on port ${PORT}`);
  console.log(`[MIRROR PROXY] Target: ${TARGET_PROTOCOL}://${TARGET_HOST}`);
  if (YOUR_DOMAIN) {
    console.log(`[MIRROR PROXY] Proxy domain: ${YOUR_DOMAIN}`);
  } else {
    console.log(`[MIRROR PROXY] Proxy domain: auto-detect from Host header`);
  }
});
