/**
 * SportConnect – Cloudflare Worker (sportconnect-static)
 *
 * Fully self-contained: no fetch() passthrough to origin.
 * Serves: / (homepage), /privacy, /terms, /icon.png
 * Zero cold start — all content is inlined in this worker.
 */

const BRAND = "#FF6017";

// Basketball icon served as SVG — no external dependency, no 404
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="48" fill="#FF6017"/>
  <clipPath id="b"><circle cx="50" cy="50" r="48"/></clipPath>
  <g clip-path="url(#b)" stroke="white" stroke-width="3.5" fill="none">
    <line x1="2" y1="50" x2="98" y2="50"/>
    <line x1="50" y1="2" x2="50" y2="98"/>
    <path d="M50,2 C22,18 22,82 50,98"/>
    <path d="M50,2 C78,18 78,82 50,98"/>
  </g>
</svg>`;

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SportConnect – Basketball Court Booking App</title>
  <meta name="description" content="Find and book basketball courts, join pickup games and training sessions, and connect with players near you. Available in Vietnam." />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: ${BRAND}; }
    body { font-family: sans-serif; background: #f9fafb; color: #1a1a2e; text-align: center; padding: 3rem 1.5rem; }
    h1 { color: var(--brand); font-size: 2.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #555; margin-bottom: 2rem; font-size: 1.1rem; }
    .features { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.75rem; margin: 1.5rem 0; }
    .feature { background: #fff; border: 1px solid #e5e7eb; border-radius: 999px; padding: 0.5rem 1.2rem; font-size: 0.95rem; }
    .about { max-width: 640px; margin: 2rem auto; background: #fff; padding: 2rem; border-radius: 14px; text-align: left; line-height: 1.7; }
    .about h2 { color: var(--brand); margin-bottom: 0.75rem; }
    .about p + p { margin-top: 0.75rem; }
    .policy-box { border: 2px solid var(--brand); border-radius: 10px; padding: 1rem 1.5rem; margin-top: 1.25rem; font-weight: 600; }
    a { color: var(--brand); font-weight: bold; text-decoration: none; }
    a:hover { text-decoration: underline; }
    footer { margin-top: 3rem; font-size: 0.8rem; color: #888; }
    footer a { color: #888; font-weight: normal; }
    footer a:hover { color: var(--brand); }
  </style>
</head>
<body>
  <img src="/icon.png" alt="SportConnect logo" width="80" height="80" style="border-radius:18px;margin-bottom:1rem;" />
  <h1>SportConnect</h1>
  <p class="subtitle">Find and book basketball courts, join pickup games and<br/>training sessions, and connect with players near you.</p>

  <div class="features">
    <span class="feature">🏀 Basketball Courts</span>
    <span class="feature">🏆 Games &amp; Training</span>
    <span class="feature">📍 Nearby Venues</span>
    <span class="feature">👥 Player Community</span>
  </div>

  <p>Download now on <a href="#">iOS</a> &amp; <a href="#">Android</a>.</p>

  <div class="about">
    <h2>About SportConnect</h2>
    <p>SportConnect is a mobile application built exclusively for basketball players and fans in Vietnam. Find and instantly book basketball courts at venues across Ho Chi Minh City and beyond — all from your phone.</p>
    <p>Beyond court booking, SportConnect helps you discover pickup games, join structured training sessions, and connect with a community of basketball players who share your passion — all from one app.</p>
    <div class="policy-box">
      Legal Documentation: Read our <a href="https://sportconnects.org/privacy">Privacy Policy here</a>.
    </div>
    <p style="margin-top:0.75rem;">Review our <a href="https://sportconnects.org/terms">Terms of Service</a> for full usage details.</p>
  </div>

  <footer>
    <a href="https://sportconnects.org/privacy">Privacy Policy</a> &nbsp;·&nbsp;
    <a href="https://sportconnects.org/terms">Terms of Service</a><br/>
    &copy; 2026 SportConnect · sportconnects.org
  </footer>
</body>
</html>`;

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy – SportConnect</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: ${BRAND}; }
    body { font-family: sans-serif; background: #f9fafb; color: #1a1a2e; max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.8; }
    h1 { color: var(--brand); margin-bottom: 0.5rem; }
    h2 { color: var(--brand); margin: 2rem 0 0.5rem; font-size: 1.15rem; }
    p { margin-bottom: 1rem; }
    a { color: var(--brand); }
    footer { margin-top: 3rem; font-size: 0.8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><em>Last updated: March 2026</em></p>

  <p>Thank you for using SportConnect. This Privacy Policy explains how we collect, use, and protect your information when you use our mobile application.</p>

  <h2>1. Information We Collect</h2>
  <p>We collect information you provide directly to us when you create an account, including your name, email address, and profile photo. We also collect usage data such as court bookings, event registrations, and training session participation.</p>

  <h2>2. How We Use Your Information</h2>
  <p>We use your information to provide, maintain, and improve our services, process bookings and payments, send service-related notifications, and connect you with other players in the SportConnect community.</p>

  <h2>3. Information Sharing</h2>
  <p>SportConnect does not sell, trade, or share your personal information with third parties for marketing purposes. We may share data with service providers who assist in operating the app (such as payment processors) under strict confidentiality agreements.</p>

  <h2>4. Data Security</h2>
  <p>We use industry-standard security measures to protect your personal information. All data is transmitted via HTTPS and stored in secured, access-controlled databases.</p>

  <h2>5. Your Rights</h2>
  <p>You may access, update, or delete your personal information at any time through the app's profile settings. To request account deletion, contact us at the email below.</p>

  <h2>6. Contact Us</h2>
  <p>If you have any questions about this Privacy Policy, please contact us at: <a href="mailto:cudentri@gmail.com">cudentri@gmail.com</a></p>

  <footer>
    <a href="https://sportconnects.org/">Home</a> &nbsp;·&nbsp;
    <a href="https://sportconnects.org/terms">Terms of Service</a><br/>
    &copy; 2026 SportConnect
  </footer>
</body>
</html>`;

const TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Terms of Service – SportConnect</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: ${BRAND}; }
    body { font-family: sans-serif; background: #f9fafb; color: #1a1a2e; max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.8; }
    h1 { color: var(--brand); margin-bottom: 0.5rem; }
    h2 { color: var(--brand); margin: 2rem 0 0.5rem; font-size: 1.15rem; }
    p { margin-bottom: 1rem; }
    a { color: var(--brand); }
    footer { margin-top: 3rem; font-size: 0.8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p><em>Last updated: March 2026</em></p>

  <p>By using SportConnect, you agree to these Terms of Service. Please read them carefully.</p>

  <h2>1. Use of the App</h2>
  <p>SportConnect is provided for personal, non-commercial use. You agree not to misuse the service, violate any laws, or interfere with other users' experience.</p>

  <h2>2. Account Responsibility</h2>
  <p>You are responsible for maintaining the confidentiality of your account credentials and for all activities under your account.</p>

  <h2>3. Bookings and Payments</h2>
  <p>Court bookings are subject to venue availability. Cancellation policies are determined by individual venues. SportConnect facilitates bookings but is not responsible for venue-level decisions.</p>

  <h2>4. Limitation of Liability</h2>
  <p>SportConnect is provided "as is". We are not liable for any damages arising from your use of the app, including but not limited to injuries during sporting activities.</p>

  <h2>5. Changes to Terms</h2>
  <p>We may update these Terms from time to time. Continued use of the app after changes constitutes acceptance of the new Terms.</p>

  <h2>6. Contact</h2>
  <p>Questions? Contact us at <a href="mailto:cudentri@gmail.com">cudentri@gmail.com</a></p>

  <footer>
    <a href="https://sportconnects.org/">Home</a> &nbsp;·&nbsp;
    <a href="https://sportconnects.org/privacy">Privacy Policy</a><br/>
    &copy; 2026 SportConnect
  </footer>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/"; // normalize trailing slashes

    // Shared response headers: tell Google Bot these are public, cacheable pages
    const headers = { 
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "index, follow",
    };

    if (path === "/zalo-callback") {
      // Bridge Zalo OAuth redirect (must be HTTPS) → app deep link.
      // Zalo redirects here with ?code=...&state=... after user authorises.
      // expo-web-browser.openAuthSessionAsync intercepts the sportconnect:// URL and
      // resolves the promise — CCT closes, app returns to foreground.
      const qs = url.searchParams.toString();
      const deepLink = `sportconnect://zalo-code${qs ? "?" + qs : ""}`;

      return new Response(null, {
        status: 302,
        headers: {
          "Location": deepLink,
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/privacy") {
      return new Response(PRIVACY_HTML, { headers });
    }

    if (path === "/terms") {
      return new Response(TERMS_HTML, { headers });
    }

    // Zalo token-info proxy — fetches user_id from Zalo's OAuth endpoint.
    // oauth.zaloapp.com/v4/tokeninfo is accessible from any region (unlike graph.zalo.me).
    // Called by the app after the code exchange to get the Zalo user_id.
    if (path === "/zalo-proxy/tokeninfo" && request.method === "POST") {
      try {
        const body = await request.json();
        const accessToken = body.access_token;
        if (!accessToken || typeof accessToken !== "string") {
          return new Response(JSON.stringify({ error: "missing access_token" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Simple tokeninfo call — just access_token header, returns {user_id, app_id, exp}
        const zaloResp = await fetch(
          "https://oauth.zaloapp.com/v4/tokeninfo",
          { headers: { "access_token": accessToken } }
        );
        const data = await zaloResp.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "proxy_error", message: String(err) }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Serve the basketball icon as SVG — fixes the 404 on /icon.png
    if (path === "/icon.png" || path === "/favicon.ico") {
      return new Response(ICON_SVG, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    // Homepage (/ or anything else that lands here via the Worker route)
    return new Response(HOME_HTML, { headers });

    // ⚠️  NO fetch(request) passthrough — never proxy to the origin server.
  },
};
