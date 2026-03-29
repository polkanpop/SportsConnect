"""One-shot generator: writes privacy.html, terms.html, privacy_vi.html, terms_vi.html"""
import pathlib

base = pathlib.Path(__file__).parent

SHARED_CSS = """
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: #FF6017; --brand-dk: #d94f0e; --text: #1a1a2e; --muted: #6b7280; --bg: #f9fafb; --card: #ffffff; --border: #e5e7eb; --radius: 10px; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; font-size: 16px; }
    header { background: linear-gradient(135deg, var(--brand) 0%, var(--brand-dk) 100%); color: #fff; padding: 3rem 1.5rem 2.5rem; text-align: center; }
    header .logo { font-size: 1.05rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; opacity: .85; margin-bottom: .6rem; }
    header h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); font-weight: 800; letter-spacing: -.02em; margin-bottom: .5rem; }
    header p.meta { font-size: .875rem; opacity: .75; }
    .container { max-width: 800px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
    .intro-card { background: var(--card); border-left: 4px solid var(--brand); border-radius: var(--radius); padding: 1.25rem 1.5rem; margin-bottom: 2.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.07); font-size: .95rem; color: #374151; }
    section { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.75rem 2rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
    section h2 { font-size: 1.05rem; font-weight: 700; color: var(--brand); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 1rem; display: flex; align-items: center; gap: .5rem; }
    section h2 .num { background: var(--brand); color: #fff; width: 1.65rem; height: 1.65rem; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: .7rem; font-weight: 800; flex-shrink: 0; }
    section p { margin-bottom: .85rem; color: #374151; }
    section p:last-child { margin-bottom: 0; }
    section ul, section ol { list-style: none; margin: .5rem 0 .85rem 0; }
    section ul li, section ol li { padding: .35rem 0 .35rem 1.4rem; position: relative; color: #374151; counter-increment: ol-counter; }
    section ul li::before { content: "\\25B8"; position: absolute; left: 0; color: var(--brand); font-size: .85rem; }
    section ol { counter-reset: ol-counter; }
    section ol li::before { content: counter(ol-counter) "."; position: absolute; left: 0; color: var(--brand); font-size: .85rem; font-weight: 700; }
    .highlight { background: #fff7f3; border: 1px solid #fdd5be; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; font-size: .93rem; color: #7c2d12; }
    .highlight strong { color: #c2410c; }
    .warning { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; font-size: .93rem; color: #78350f; }
    .warning strong { color: #92400e; }
    .table-wrap { overflow-x: auto; margin: .75rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: .875rem; }
    th { background: #f3f4f6; text-align: left; padding: .6rem .8rem; font-weight: 700; border-bottom: 2px solid var(--border); color: #374151; }
    td { padding: .55rem .8rem; border-bottom: 1px solid var(--border); color: #4b5563; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    dl { margin: .5rem 0; }
    dt { font-weight: 700; color: #374151; margin-top: .8rem; }
    dd { margin-left: 1.2rem; color: #4b5563; }
    footer { text-align: center; padding: 2rem 1rem; font-size: .8rem; color: var(--muted); border-top: 1px solid var(--border); }
    footer a { color: var(--brand); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    @media (max-width: 480px) { section { padding: 1.25rem 1.1rem; } }
"""

EN_FOOTER = """<footer>
  <p>&copy; 2026 SportConnect &nbsp;&middot;&nbsp;
    <a href="/terms">Terms of Service</a> &nbsp;&middot;&nbsp;
    <a href="/privacy">Privacy Policy</a> &nbsp;&middot;&nbsp;
    <a href="/terms-vi">&#272;i&#7873;u kho&#7843;n (VI)</a> &nbsp;&middot;&nbsp;
    <a href="/privacy-vi">Quy&#7873;n ri&ecirc;ng t&#432; (VI)</a>
  </p>
  <p style="margin-top:.4rem;">sportconnects.org &nbsp;&middot;&nbsp; Governed by the laws of the Socialist Republic of Vietnam</p>
</footer>"""

VI_FOOTER = """<footer>
  <p>&copy; 2026 SportConnect &nbsp;&middot;&nbsp;
    <a href="/terms-vi">&#272;i&#7873;u kho&#7843;n d&#7883;ch v&#7909;</a> &nbsp;&middot;&nbsp;
    <a href="/privacy-vi">Ch&iacute;nh s&aacute;ch quy&#7873;n ri&ecirc;ng t&#432;</a> &nbsp;&middot;&nbsp;
    <a href="/terms">Terms of Service (EN)</a> &nbsp;&middot;&nbsp;
    <a href="/privacy">Privacy Policy (EN)</a>
  </p>
  <p style="margin-top:.4rem;">sportconnects.org &nbsp;&middot;&nbsp; Tu&acirc;n theo ph&aacute;p lu&#7853;t C&#7897;ng h&ograve;a X&atilde; h&#7897;i ch&#7911; ngh&#297;a Vi&#7879;t Nam</p>
</footer>"""

# ---------------------------------------------------------------------------
# PRIVACY (EN)
# ---------------------------------------------------------------------------
PRIVACY_EN = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy &ndash; SportConnect</title>
  <style>{SHARED_CSS}</style>
</head>
<body>
<header>
  <div class="logo">SportConnect</div>
  <h1>Privacy Policy</h1>
  <p class="meta">Effective Date: 29 March 2026 &nbsp;&middot;&nbsp; Last Updated: 29 March 2026</p>
</header>
<div class="container">
  <div class="intro-card">
    Welcome to <strong>SportConnect</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;), operated by
    the SportConnect development team and accessible at <strong>sportconnects.org</strong>. This Privacy Policy explains
    how we collect, use, disclose, and protect your personal information when you use our mobile application
    (&ldquo;App&rdquo;). By creating an account or using the App, you consent to the practices described herein.
  </div>

  <section>
    <h2><span class="num">1</span> Information We Collect</h2>
    <p><strong>1.1 Phone Number &mdash; Required for OTP Verification</strong></p>
    <div class="highlight">
      We collect your <strong>mobile phone number</strong> exclusively to verify your identity via a one-time
      password (OTP) sent through <strong>Firebase Authentication, a service of Google LLC</strong>. This is
      mandatory to create and secure your SportConnect account. We do not use your phone number for unsolicited
      marketing calls or SMS.
    </div>
    <p><strong>1.2 Account Information</strong></p>
    <ul>
      <li>Display name and username (chosen by you)</li>
      <li>Email address (optional, for account recovery)</li>
      <li>Profile photo (optional, user-uploaded)</li>
    </ul>
    <p><strong>1.3 Booking and Activity Data</strong></p>
    <ul>
      <li>Sports court bookings &mdash; venue, date, time slot, sport type</li>
      <li>Event attendance and training session registrations</li>
      <li>Payment transaction identifiers (we do not store full card details)</li>
    </ul>
    <p><strong>1.4 Device and Technical Data</strong></p>
    <ul>
      <li>Device type, model, OS version, and unique device identifiers</li>
      <li>Push notification tokens (Expo&nbsp;/&nbsp;FCM&nbsp;/&nbsp;APNs) for booking and event alerts</li>
      <li>IP address, app version, crash logs, and session analytics</li>
    </ul>
    <p><strong>1.5 Location Data</strong></p>
    <p>With your permission we collect approximate or precise location to display nearby venues and calculate
    distances. You may revoke this permission at any time in your device settings.</p>
  </section>

  <section>
    <h2><span class="num">2</span> How We Use Your Information</h2>
    <ul>
      <li>Verify your identity via Firebase Phone Authentication (SMS OTP)</li>
      <li>Create and manage your bookings, event registrations, and training sessions</li>
      <li>Send push notifications for booking confirmations, reminders, and cancellations</li>
      <li>Diagnose technical issues, prevent fraud, and improve App performance</li>
      <li>Respond to support requests</li>
      <li>Comply with applicable Vietnamese law and regulations</li>
    </ul>
    <p>We do <strong>not</strong> engage in automated profiling that produces legal or similarly significant
    effects on you.</p>
  </section>

  <section>
    <h2><span class="num">3</span> Sharing of Information</h2>
    <div class="highlight">
      <strong>We do not sell, rent, or trade your personal information to any third party for commercial or
      marketing purposes &mdash; ever.</strong>
    </div>
    <p>We share data only with the providers below, and only to the extent necessary to operate the App:</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Provider</th><th>Purpose</th><th>Data Shared</th></tr></thead>
        <tbody>
          <tr><td>Firebase&nbsp;/ Google LLC</td><td>Phone OTP authentication, crash analytics, FCM push notifications</td><td>Phone number, device token</td></tr>
          <tr><td>Supabase Inc.</td><td>Database &mdash; profiles, bookings, events</td><td>Account and booking data</td></tr>
          <tr><td>Expo Inc.</td><td>Push notification delivery (Expo Push Service)</td><td>Push notification tokens</td></tr>
          <tr><td>Goong Maps</td><td>Map display and distance calculations</td><td>Approximate location</td></tr>
          <tr><td>Render Inc.</td><td>Backend API hosting</td><td>Anonymised request logs</td></tr>
        </tbody>
      </table>
    </div>
    <p>We may disclose information if required by Vietnamese law, court order, or to protect the rights and
    safety of SportConnect, our users, or the public.</p>
  </section>

  <section>
    <h2><span class="num">4</span> Data Retention</h2>
    <p>We retain personal data as long as your account is active. Upon deletion, data is removed or anonymised
    within <strong>30&nbsp;days</strong>, except where retention is required by Vietnamese tax or accounting law.
    SMS OTP codes are single-use and are <strong>not stored</strong> by SportConnect.</p>
  </section>

  <section>
    <h2><span class="num">5</span> Data Security</h2>
    <ul>
      <li>All data in transit is encrypted via TLS&nbsp;1.2+&nbsp;/&nbsp;HTTPS</li>
      <li>Firebase tokens are short-lived and cryptographically signed by Google</li>
      <li>Database access is protected by Supabase Row-Level Security (RLS)</li>
      <li>Backend APIs are rate-limited and validated on every request</li>
    </ul>
    <p>No electronic transmission is 100&nbsp;% secure. You are responsible for keeping your credentials
    confidential.</p>
  </section>

  <section>
    <h2><span class="num">6</span> Your Rights</h2>
    <p>Under applicable Vietnamese law you have the right to access, correct, delete, or restrict processing
    of your personal data, and to withdraw consent to phone number collection (which will prevent OTP login).
    Contact us at <strong>privacy@sportconnects.org</strong> to exercise any right.</p>
  </section>

  <section>
    <h2><span class="num">7</span> Children&rsquo;s Privacy</h2>
    <p>SportConnect is not directed at children under <strong>13</strong>. We do not knowingly collect data
    from children under 13. Contact us immediately if you believe a child has registered without parental
    consent and we will delete the account.</p>
  </section>

  <section>
    <h2><span class="num">8</span> International Data Transfers</h2>
    <p>Data may be processed outside Vietnam by our providers (e.g., Google Firebase in the US&nbsp;/
    Singapore). By using the App you consent to this transfer. All providers must maintain protection
    standards consistent with this Policy.</p>
  </section>

  <section>
    <h2><span class="num">9</span> Changes to This Policy</h2>
    <p>We may update this Policy periodically. Material changes will be notified in-app. Continued use after
    changes constitutes acceptance.</p>
  </section>

  <section>
    <h2><span class="num">10</span> Governing Law &amp; Contact</h2>
    <p>Governed by the laws of the <strong>Socialist Republic of Vietnam</strong>, including the Law on
    Cybersecurity 2018 and <strong>Decree No.&nbsp;13/2023/N&#272;-CP on Personal Data Protection</strong>.</p>
    <ul>
      <li><strong>Email:</strong> privacy@sportconnects.org</li>
      <li><strong>Website:</strong> sportconnects.org</li>
    </ul>
  </section>
</div>
{EN_FOOTER}
</body>
</html>"""

# ---------------------------------------------------------------------------
# TERMS (EN)
# ---------------------------------------------------------------------------
TERMS_EN = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Terms of Service &ndash; SportConnect</title>
  <style>{SHARED_CSS}</style>
</head>
<body>
<header>
  <div class="logo">SportConnect</div>
  <h1>Terms of Service</h1>
  <p class="meta">Effective Date: 29 March 2026 &nbsp;&middot;&nbsp; Last Updated: 29 March 2026</p>
</header>
<div class="container">
  <div class="intro-card">
    These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement between you
    (&ldquo;User&rdquo;, &ldquo;you&rdquo;) and the SportConnect development team (&ldquo;SportConnect&rdquo;,
    &ldquo;we&rdquo;, &ldquo;us&rdquo;), governing your access to and use of the <strong>SportConnect</strong>
    mobile application and related services at <strong>sportconnects.org</strong> (&ldquo;App&rdquo;).
    By registering an account or using the App, you confirm that you have read, understood, and agree to be
    bound by these Terms. If you do not agree, do not use the App.
  </div>

  <section>
    <h2><span class="num">1</span> Eligibility</h2>
    <ul>
      <li>You must be at least <strong>13&nbsp;years of age</strong> to use the App.</li>
      <li>Users under&nbsp;18 require the consent of a parent or legal guardian.</li>
      <li>By verifying your phone number via OTP you represent that the number belongs to you and all
          information provided is accurate and current.</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">2</span> Account Registration &amp; Security</h2>
    <p><strong>2.1 Account Creation</strong></p>
    <p>You must register using a valid mobile phone number. A one-time password (OTP) will be sent to that
    number via <strong>Firebase Authentication (Google LLC)</strong> to verify your identity.</p>
    <p><strong>2.2 Security</strong></p>
    <ul>
      <li>You are solely responsible for keeping your login credentials confidential.</li>
      <li>Notify us immediately at <strong>support@sportconnects.org</strong> if you suspect unauthorised access.</li>
      <li>SportConnect is not liable for loss arising from your failure to safeguard your credentials.</li>
    </ul>
    <p><strong>2.3 One Account per Person</strong></p>
    <p>Creating duplicate accounts to circumvent restrictions or bans is prohibited and may result in permanent
    suspension of all associated accounts.</p>
  </section>

  <section>
    <h2><span class="num">3</span> Court Bookings</h2>
    <p><strong>3.1 Nature</strong></p>
    <p>SportConnect connects users with sports venues. We are not the operator, owner, or manager of any listed
    venue. The contract for use of a court is between you and the venue directly.</p>
    <p><strong>3.2 Cancellations &amp; Refunds</strong></p>
    <ul>
      <li>Cancellation policies are set by each venue and shown at booking time.</li>
      <li>SportConnect is not responsible for refunds from venue-side cancellations.</li>
    </ul>
    <p><strong>3.3 No-Shows</strong></p>
    <p>Repeated no-shows (confirmed bookings not attended and not cancelled in advance) may result in temporary
    suspension of booking privileges.</p>
  </section>

  <section>
    <h2><span class="num">4</span> User Conduct</h2>
    <div class="warning">
      <strong>Violation of any rule below may result in immediate account suspension or permanent termination.</strong>
    </div>
    <p>You agree <strong>not</strong> to:</p>
    <ul>
      <li>Use the App for any unlawful purpose or in violation of Vietnamese or international law</li>
      <li>Harass, threaten, defame, or abuse other users, venue staff, or SportConnect personnel</li>
      <li>Post false, misleading, or fraudulent reviews, listings, or content</li>
      <li>Impersonate another person or entity</li>
      <li>Attempt unauthorised access to the App, its servers, or databases</li>
      <li>Scrape or extract data using automated means without written consent</li>
      <li>Introduce malware or malicious code into the App or its infrastructure</li>
      <li>Make fraudulent bookings you have no intention of honouring</li>
      <li>Resell or commercially exploit App features without our written authorisation</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">5</span> User-Generated Content</h2>
    <p>By submitting reviews, photos, or other content you grant SportConnect a non-exclusive, worldwide,
    royalty-free licence to use, reproduce, display, and distribute that content within the App. You warrant
    the content does not infringe third-party rights, is truthful, and contains no unlawful material.</p>
    <p>We reserve the right to remove User Content at our sole discretion without notice.</p>
  </section>

  <section>
    <h2><span class="num">6</span> Account Suspension &amp; Termination</h2>
    <p><strong>6.1 Termination by You</strong></p>
    <p>You may delete your account at any time via account settings. Deletion triggers personal data removal
    as described in our <a href="/privacy" style="color:var(--brand);">Privacy Policy</a>.</p>
    <p><strong>6.2 Termination by SportConnect</strong></p>
    <p>We may suspend or permanently terminate your account, with or without notice, if you breach these Terms,
    engage in fraud, cause harm to other users or venues, or if required by law.</p>
    <p><strong>6.3 Effect of Termination</strong></p>
    <p>Your right to use the App ceases immediately upon termination. Sections&nbsp;8&ndash;12 survive
    termination.</p>
  </section>

  <section>
    <h2><span class="num">7</span> Payments</h2>
    <p>Certain bookings may require payment in Vietnamese Dong (VND). We do not store full card details;
    payments are processed by PCI-DSS&ndash;compliant processors. Refund eligibility is governed by each
    venue&rsquo;s cancellation policy.</p>
  </section>

  <section>
    <h2><span class="num">8</span> Intellectual Property</h2>
    <p>All software, design, trademarks, and content comprising the App are the exclusive property of
    SportConnect or its licensors. We grant you a limited, non-exclusive, revocable licence to use the App
    for personal, non-commercial purposes only. No copying, modification, or distribution without prior
    written consent.</p>
  </section>

  <section>
    <h2><span class="num">9</span> Disclaimers</h2>
    <div class="warning">
      <strong>THE APP IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF
      ANY KIND, TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW.</strong>
    </div>
    <p>SportConnect does not warrant uninterrupted availability, that venue information is always accurate, or
    that venues meet any particular quality standard. Use of any venue is at your own risk.</p>
  </section>

  <section>
    <h2><span class="num">10</span> Limitation of Liability</h2>
    <p>To the fullest extent permitted by Vietnamese law, SportConnect shall not be liable for indirect,
    incidental, special, or consequential damages, or for loss of profits, data, or goodwill. Total aggregate
    liability shall not exceed the greater of: (a)&nbsp;amounts paid by you in the prior 12&nbsp;months, or
    (b)&nbsp;VND&nbsp;500,000.</p>
  </section>

  <section>
    <h2><span class="num">11</span> Indemnification</h2>
    <p>You agree to indemnify and hold harmless SportConnect and its team from any claims, losses, and expenses
    arising from: (a)&nbsp;your use of the App; (b)&nbsp;your content; (c)&nbsp;your breach of these Terms;
    or (d)&nbsp;your violation of third-party rights.</p>
  </section>

  <section>
    <h2><span class="num">12</span> Governing Law &amp; Disputes</h2>
    <p>These Terms are governed by the laws of the <strong>Socialist Republic of Vietnam</strong>. Disputes
    shall first be resolved through good-faith negotiation; if unresolved within 30&nbsp;days, they shall be
    submitted to the competent courts of <strong>Ho Chi Minh City, Vietnam</strong>.</p>
  </section>

  <section>
    <h2><span class="num">13</span> Changes to These Terms</h2>
    <p>We may revise these Terms at any time. Material changes will be notified in-app. Continued use after
    the effective date constitutes acceptance.</p>
  </section>

  <section>
    <h2><span class="num">14</span> Contact</h2>
    <ul>
      <li><strong>Legal:</strong> legal@sportconnects.org</li>
      <li><strong>Support:</strong> support@sportconnects.org</li>
      <li><strong>Website:</strong> sportconnects.org</li>
    </ul>
  </section>
</div>
{EN_FOOTER}
</body>
</html>"""

# ---------------------------------------------------------------------------
# PRIVACY (VI)
# ---------------------------------------------------------------------------
PRIVACY_VI = f"""<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ch&iacute;nh s&aacute;ch Quy&#7873;n ri&ecirc;ng t&#432; &ndash; SportConnect</title>
  <style>{SHARED_CSS}</style>
</head>
<body>
<header>
  <div class="logo">SportConnect</div>
  <h1>Ch&iacute;nh s&aacute;ch Quy&#7873;n ri&ecirc;ng t&#432;</h1>
  <p class="meta">Ng&agrave;y hi&#7879;u l&#7921;c: 29 th&aacute;ng 3 n&#259;m 2026 &nbsp;&middot;&nbsp; C&#7853;p nh&#7853;t l&#7847;n cu&#7889;i: 29 th&aacute;ng 3 n&#259;m 2026</p>
</header>
<div class="container">
  <div class="intro-card">
    Ch&agrave;o m&#7915;ng b&#7841;n &#273;&ecirc;n v&#7899;i <strong>SportConnect</strong> (&ldquo;ch&uacute;ng t&ocirc;i&rdquo;), v&#7853;n h&agrave;nh b&#7903;i
    nh&oacute;m ph&aacute;t tri&#7875;n SportConnect, c&oacute; th&#7875; truy c&#7853;p t&#7841;i <strong>sportconnects.org</strong>.
    Ch&iacute;nh s&aacute;ch n&agrave;y gi&#7843;i th&iacute;ch c&aacute;ch ch&uacute;ng t&ocirc;i thu th&#7853;p, s&#7917; d&#7909;ng v&agrave; b&#7843;o v&#7879;
    th&ocirc;ng tin c&aacute; nh&acirc;n khi b&#7841;n s&#7917; d&#7909;ng &#7912;ng d&#7909;ng di &#273;&#7897;ng (&ldquo;&#7912;ng d&#7909;ng&rdquo;).
    Vi&#7879;c t&#7841;o t&agrave;i kho&#7843;n ho&#7863;c s&#7917; d&#7909;ng &#7912;ng d&#7909;ng &#273;&#7891;ng ngh&#297;a v&#7899;i vi&#7879;c b&#7841;n
    &#273;&#7891;ng &yacute; v&#7899;i c&aacute;c th&#7911; t&#7909;c &#273;&#432;&#7907;c m&ocirc; t&#7843; trong t&agrave;i li&#7879;u n&agrave;y.
  </div>

  <section>
    <h2><span class="num">1</span> Th&ocirc;ng tin ch&uacute;ng t&ocirc;i thu th&#7853;p</h2>
    <p><strong>1.1 S&#7889; &#273;i&#7879;n tho&#7841;i &mdash; B&#7855;t bu&#7897;c &#273;&#7875; x&aacute;c minh OTP</strong></p>
    <div class="highlight">
      Ch&uacute;ng t&ocirc;i thu th&#7853;p <strong>s&#7889; &#273;i&#7879;n tho&#7841;i di &#273;&#7897;ng</strong> c&#7911;a b&#7841;n ch&#7881; d&#7915;ng
      &#273;&#7875; x&aacute;c minh danh t&iacute;nh qua m&atilde; OTP g&#7917;i b&#7903;i
      <strong>Firebase Authentication &mdash; d&#7883;ch v&#7909; c&#7911;a Google LLC</strong>.
      &#272;&acirc;y l&agrave; th&ocirc;ng tin b&#7855;t bu&#7897;c &#273;&#7875; t&#7841;o v&agrave; b&#7843;o m&#7853;t t&agrave;i kho&#7843;n c&#7911;a b&#7841;n.
      Ch&uacute;ng t&ocirc;i kh&ocirc;ng s&#7917; d&#7909;ng s&#7889; &#273;i&#7879;n tho&#7841;i cho m&#7909;c &#273;&iacute;ch qu&#7843;ng c&aacute;o.
    </div>
    <p><strong>1.2 Th&ocirc;ng tin t&agrave;i kho&#7843;n</strong></p>
    <ul>
      <li>T&ecirc;n hi&#7875;n th&#7883; v&agrave; t&ecirc;n ng&#432;&#7901;i d&ugrave;ng</li>
      <li>&#272;&#7883;a ch&#7881; email (t&#7921;y ch&#7885;n &mdash; kh&ocirc;i ph&#7909;c t&agrave;i kho&#7843;n)</li>
      <li>&#7842;nh &#273;&#7841;i di&#7879;n (t&#7921;y ch&#7885;n &mdash; do ng&#432;&#7901;i d&ugrave;ng t&#7843;i l&ecirc;n)</li>
    </ul>
    <p><strong>1.3 D&#7919; li&#7879;u &#273;&#7863;t ch&#7895; v&agrave; ho&#7841;t &#273;&#7897;ng</strong></p>
    <ul>
      <li>&#272;&#7863;t s&acirc;n th&#7875; thao &mdash; s&acirc;n, ng&agrave;y, khung gi&#7901;, m&ocirc;n th&#7875; thao</li>
      <li>&#272;&#259;ng k&yacute; s&#7921; ki&#7879;n v&agrave; bu&#7893;i t&#7853;p</li>
      <li>M&atilde; giao d&#7883;ch (kh&ocirc;ng l&#432;u th&ocirc;ng tin th&#7867; &#273;&#7847;y &#273;&#7911;)</li>
    </ul>
    <p><strong>1.4 D&#7919; li&#7879;u thi&#7871;t b&#7883;</strong></p>
    <ul>
      <li>Lo&#7841;i thi&#7871;t b&#7883;, m&#7903; h&igrave;nh, phi&ecirc;n b&#7843;n h&#7879; &#273;i&#7873;u h&agrave;nh, m&atilde; thi&#7871;t b&#7883;</li>
      <li>M&atilde; th&ocirc;ng b&aacute;o &#273;&#7849;y (Expo / FCM / APNs)</li>
      <li>&#272;&#7883;a ch&#7881; IP, phi&ecirc;n b&#7843;n &#7912;ng d&#7909;ng, nh&#7853;t k&yacute; s&#7921; c&#7889;</li>
    </ul>
    <p><strong>1.5 V&#7883; tr&iacute;</strong></p>
    <p>Khi &#273;&#432;&#7907;c c&#7845;p ph&eacute;p, ch&uacute;ng t&ocirc;i thu th&#7853;p v&#7883; tr&iacute; &#273;&#7875; hi&#7875;n th&#7883; c&aacute;c s&acirc;n g&#7847;n v&agrave; t&iacute;nh
    kho&#7843;ng c&aacute;ch. B&#7841;n c&oacute; th&#7875; thu h&#7891;i quy&#7873;n n&agrave;y b&#7845;t k&#7923; l&uacute;c n&agrave;o.</p>
  </section>

  <section>
    <h2><span class="num">2</span> C&aacute;ch s&#7917; d&#7909;ng th&ocirc;ng tin</h2>
    <ul>
      <li>X&aacute;c minh danh t&iacute;nh qua Firebase Phone Authentication (OTP)</li>
      <li>Qu&#7843;n l&yacute; &#273;&#7863;t ch&#7895;, s&#7921; ki&#7879;n, bu&#7893;i t&#7853;p</li>
      <li>G&#7917;i th&ocirc;ng b&aacute;o &#273;&#7849;y: x&aacute;c nh&#7853;n, nh&#7855;c nh&#7903;, h&#7911;y ch&#7895;</li>
      <li>Ch&#7849;n &#273;o&aacute;n l&#7895;i k&#7929; thu&#7853;t, ng&#259;n gian l&#7853;n, c&#7843;i thi&#7879;n hi&#7879;u su&#7845;t</li>
      <li>H&#7895; tr&#7907; kh&aacute;ch h&agrave;ng</li>
      <li>Tu&acirc;n th&#7911; ph&aacute;p lu&#7853;t Vi&#7879;t Nam</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">3</span> Chia s&#7867; th&ocirc;ng tin</h2>
    <div class="highlight">
      <strong>Ch&uacute;ng t&ocirc;i tuy&#7879;t &#273;&#7889;i kh&ocirc;ng b&aacute;n, cho thu&ecirc; hay trao &#273;&#7893;i d&#7919; li&#7879;u c&aacute; nh&acirc;n
      c&#7911;a b&#7841;n cho b&ecirc;n th&#7913; ba v&igrave; m&#7909;c &#273;&iacute;ch th&#432;&#417;ng m&#7841;i.</strong>
    </div>
    <p>Ch&#7881; chia s&#7867; v&#7899;i c&aacute;c nh&agrave; cung c&#7845;p sau &#7903; m&#7913;c c&#7847;n thi&#7871;t:</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Nh&agrave; cung c&#7845;p</th><th>M&#7909;c &#273;&iacute;ch</th><th>D&#7919; li&#7879;u chia s&#7867;</th></tr></thead>
        <tbody>
          <tr><td>Firebase / Google LLC</td><td>X&aacute;c th&#7921;c OTP, ph&acirc;n t&iacute;ch s&#7921; c&#7889;, FCM</td><td>S&#7889; &#273;i&#7879;n tho&#7841;i, m&atilde; thi&#7871;t b&#7883;</td></tr>
          <tr><td>Supabase Inc.</td><td>C&#417; s&#7903; d&#7919; li&#7879;u</td><td>D&#7919; li&#7879;u t&agrave;i kho&#7843;n v&agrave; &#273;&#7863;t ch&#7895;</td></tr>
          <tr><td>Expo Inc.</td><td>Push notification</td><td>M&atilde; th&ocirc;ng b&aacute;o &#273;&#7849;y</td></tr>
          <tr><td>Goong Maps</td><td>B&#7843;n &#273;&#7891; v&agrave; kho&#7843;ng c&aacute;ch</td><td>V&#7883; tr&iacute; x&#7845;p x&#7881;</td></tr>
          <tr><td>Render Inc.</td><td>L&#432;u tr&#7919; API</td><td>Nh&#7853;t k&yacute; &#7849;n danh</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2><span class="num">4</span> L&#432;u tr&#7919; d&#7919; li&#7879;u</h2>
    <p>D&#7919; li&#7879;u &#273;&#432;&#7907;c l&#432;u trong su&#7889;t th&#7901;i gian t&agrave;i kho&#7843;n ho&#7841;t &#273;&#7897;ng. Sau khi x&oacute;a t&agrave;i kho&#7843;n,
    d&#7919; li&#7879;u s&#7869; &#273;&#432;&#7907;c x&oacute;a trong v&ograve;ng <strong>30&nbsp;ng&agrave;y</strong>, tr&#7915; c&aacute;c tr&#432;&#7901;ng h&#7907;p
    b&#7855;t bu&#7897;c theo quy &#273;&#7883;nh ph&aacute;p lu&#7853;t. M&atilde; OTP kh&ocirc;ng &#273;&#432;&#7907;c SportConnect l&#432;u tr&#7919;.</p>
  </section>

  <section>
    <h2><span class="num">5</span> B&#7843;o m&#7853;t</h2>
    <ul>
      <li>TLS 1.2+ / HTTPS cho m&#7885;i k&#7871;t n&#7889;i</li>
      <li>Token Firebase c&oacute; th&#7901;i h&#7841;n ng&#7855;n, &#273;&#432;&#7907;c Google k&yacute; s&#7889;</li>
      <li>Row-Level Security (Supabase RLS)</li>
      <li>API gi&#7899;i h&#7841;n t&#7889;c &#273;&#7897; v&agrave; x&aacute;c th&#7921;c m&#7885;i y&ecirc;u c&#7847;u</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">6</span> Quy&#7873;n c&#7911;a b&#7841;n</h2>
    <ul>
      <li><strong>Truy c&#7853;p</strong> d&#7919; li&#7879;u ch&uacute;ng t&ocirc;i n&#7855;m gi&#7919;</li>
      <li><strong>Ch&#7881;nh s&#7917;a</strong> d&#7919; li&#7879;u kh&ocirc;ng ch&iacute;nh x&aacute;c</li>
      <li><strong>X&oacute;a</strong> t&agrave;i kho&#7843;n v&agrave; d&#7919; li&#7879;u c&aacute; nh&acirc;n</li>
      <li><strong>R&uacute;t l&#7841;i &#273;&#7891;ng &yacute;</strong> cung c&#7845;p s&#7889; &#273;i&#7879;n tho&#7841;i (s&#7869; m&#7845;t kh&#7843; n&#259;ng &#273;&#259;ng nh&#7853;p OTP)</li>
      <li><strong>Ph&#7843;n &#273;&#7889;i</strong> x&#7917; l&yacute; d&#7919; li&#7879;u cho ph&acirc;n t&iacute;ch</li>
    </ul>
    <p>Li&ecirc;n h&#7879;: <strong>privacy@sportconnects.org</strong></p>
  </section>

  <section>
    <h2><span class="num">7</span> Tr&#7867; em</h2>
    <p>&#7912;ng d&#7909;ng kh&ocirc;ng d&agrave;nh cho tr&#7867; em d&#432;&#7899;i <strong>13&nbsp;tu&#7893;i</strong>. N&#7871;u ph&aacute;t hi&#7879;n,
    vui l&ograve;ng li&ecirc;n h&#7879; &#273;&#7875; x&oacute;a t&agrave;i kho&#7843;n ngay.</p>
  </section>

  <section>
    <h2><span class="num">8</span> Chuy&#7875;n d&#7919; li&#7879;u qu&#7889;c t&#7871;</h2>
    <p>D&#7919; li&#7879;u c&oacute; th&#7875; &#273;&#432;&#7907;c x&#7917; l&yacute; ngo&agrave;i Vi&#7879;t Nam (v&iacute; d&#7909;: Google Firebase t&#7841;i M&#7929; /
    Singapore). B&#7857;ng c&aacute;ch s&#7917; d&#7909;ng &#7912;ng d&#7909;ng, b&#7841;n &#273;&#7891;ng &yacute; v&#7899;i vi&#7879;c chuy&#7875;n n&agrave;y.</p>
  </section>

  <section>
    <h2><span class="num">9</span> Thay &#273;&#7893;i ch&iacute;nh s&aacute;ch</h2>
    <p>Ch&uacute;ng t&ocirc;i c&oacute; th&#7875; c&#7853;p nh&#7853;t ch&iacute;nh s&aacute;ch n&agrave;y. C&aacute;c thay &#273;&#7893;i quan tr&#7885;ng s&#7869; &#273;&#432;&#7907;c
    th&ocirc;ng b&aacute;o qua &#7912;ng d&#7909;ng. Ti&#7871;p t&#7909;c s&#7917; d&#7909;ng sau thay &#273;&#7893;i l&agrave; &#273;&#7891;ng &yacute; ch&iacute;nh s&aacute;ch
    m&#7899;i.</p>
  </section>

  <section>
    <h2><span class="num">10</span> Lu&#7853;t &#273;i&#7873;u ch&#7881;nh &amp; Li&ecirc;n h&#7879;</h2>
    <p>&#272;i&#7873;u ch&#7881;nh b&#7903;i ph&aacute;p lu&#7853;t <strong>C&#7897;ng h&ograve;a X&atilde; h&#7897;i ch&#7911; ngh&#297;a Vi&#7879;t Nam</strong>,
    bao g&#7891;m Lu&#7853;t An ninh m&#7841;ng 2018 v&agrave;
    <strong>Ngh&#7883; &#273;&#7883;nh s&#7889; 13/2023/N&#272;-CP v&#7873; b&#7843;o v&#7879; d&#7919; li&#7879;u c&aacute; nh&acirc;n</strong>.</p>
    <ul>
      <li><strong>Email:</strong> privacy@sportconnects.org</li>
      <li><strong>Website:</strong> sportconnects.org</li>
    </ul>
  </section>
</div>
{VI_FOOTER}
</body>
</html>"""

# ---------------------------------------------------------------------------
# TERMS (VI)
# ---------------------------------------------------------------------------
TERMS_VI = f"""<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>&#272;i&#7873;u kho&#7843;n D&#7883;ch v&#7909; &ndash; SportConnect</title>
  <style>{SHARED_CSS}</style>
</head>
<body>
<header>
  <div class="logo">SportConnect</div>
  <h1>&#272;i&#7873;u kho&#7843;n D&#7883;ch v&#7909;</h1>
  <p class="meta">Ng&agrave;y hi&#7879;u l&#7921;c: 29 th&aacute;ng 3 n&#259;m 2026 &nbsp;&middot;&nbsp; C&#7853;p nh&#7853;t l&#7847;n cu&#7889;i: 29 th&aacute;ng 3 n&#259;m 2026</p>
</header>
<div class="container">
  <div class="intro-card">
    Nh&#7919;ng &#272;i&#7873;u kho&#7843;n D&#7883;ch v&#7909; n&agrave;y (&ldquo;&#272;i&#7873;u kho&#7843;n&rdquo;) l&agrave; th&#7887;a thu&#7853;n r&agrave;ng
    bu&#7897;c ph&aacute;p l&yacute; gi&#7919;a b&#7841;n (&ldquo;Ng&#432;&#7901;i d&ugrave;ng&rdquo;) v&agrave; nh&oacute;m ph&aacute;t tri&#7875;n SportConnect
    (&ldquo;ch&uacute;ng t&ocirc;i&rdquo;), &#273;i&#7873;u ch&#7881;nh vi&#7879;c s&#7917; d&#7909;ng &#7912;ng d&#7909;ng
    <strong>SportConnect</strong> t&#7841;i <strong>sportconnects.org</strong>. Vi&#7879;c &#273;&#259;ng k&yacute;
    ho&#7863;c s&#7917; d&#7909;ng &#7912;ng d&#7909;ng &#273;&#432;&#7907;c hi&#7875;u l&agrave; b&#7841;n &#273;&#7891;ng &yacute; v&#7899;i c&aacute;c &#272;i&#7873;u
    kho&#7843;n n&agrave;y.
  </div>

  <section>
    <h2><span class="num">1</span> &#272;i&#7873;u ki&#7879;n s&#7917; d&#7909;ng</h2>
    <ul>
      <li>T&#7915; <strong>13&nbsp;tu&#7893;i tr&#7903; l&ecirc;n</strong>.</li>
      <li>D&#432;&#7899;i 18&nbsp;tu&#7893;i c&#7847;n s&#7921; &#273;&#7891;ng &yacute; c&#7911;a cha m&#7865; / ng&#432;&#7901;i gi&aacute;m h&#7897;.</li>
      <li>X&aacute;c minh OTP kh&#7859;ng &#273;&#7883;nh s&#7889; &#273;i&#7879;n tho&#7841;i thu&#7897;c v&#7873; b&#7841;n v&agrave; th&ocirc;ng tin cung c&#7845;p l&agrave; ch&iacute;nh x&aacute;c.</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">2</span> &#272;&#259;ng k&yacute; t&agrave;i kho&#7843;n &amp; B&#7843;o m&#7853;t</h2>
    <p>&#272;&#259;ng k&yacute; b&#7857;ng s&#7889; &#273;i&#7879;n tho&#7841;i h&#7907;p l&#7879;. M&atilde; OTP &#273;&#432;&#7907;c g&#7917;i qua
    <strong>Firebase Authentication (Google LLC)</strong>. B&#7841;n c&oacute; tr&aacute;ch nhi&#7879;m b&#7843;o m&#7853;t
    th&ocirc;ng tin &#273;&#259;ng nh&#7853;p. Th&ocirc;ng b&aacute;o ngay cho ch&uacute;ng t&ocirc;i t&#7841;i
    <strong>support@sportconnects.org</strong> khi c&oacute; d&#7845;u hi&#7879;u truy c&#7853;p tr&aacute;i ph&eacute;p.</p>
  </section>

  <section>
    <h2><span class="num">3</span> &#272;&#7863;t ch&#7895; s&acirc;n</h2>
    <p>SportConnect l&agrave; n&#7873;n t&#7843;ng trung gian; h&#7907;p &#273;&#7891;ng s&#7917; d&#7909;ng s&acirc;n l&agrave; gi&#7919;a b&#7841;n v&agrave;
    c&#417; s&#7903; tr&#7921;c ti&#7871;p. Ch&iacute;nh s&aacute;ch h&#7911;y do t&#7915;ng c&#417; s&#7903; quy &#273;&#7883;nh. Nhi&#7873;u l&#7847;n kh&ocirc;ng
    &#273;&#7871;n s&acirc;n kh&ocirc;ng c&oacute; l&yacute; do c&oacute; th&#7875; b&#7883; h&#7841;n ch&#7871; quy&#7873;n &#273;&#7863;t ch&#7895;.</p>
  </section>

  <section>
    <h2><span class="num">4</span> Quy t&#7855;c s&#7917; d&#7909;ng</h2>
    <div class="warning">
      <strong>Vi ph&#7841;m b&#7845;t k&#7923; quy t&#7855;c n&agrave;o c&oacute; th&#7875; d&#7851;n &#273;&#7871;n kh&oacute;a ho&#7863;c ch&#7845;m d&#7913;t t&agrave;i kho&#7843;n ngay l&#7853;p t&#7913;c.</strong>
    </div>
    <p>B&#7841;n <strong>kh&ocirc;ng &#273;&#432;&#7907;c</strong>:</p>
    <ul>
      <li>S&#7917; d&#7909;ng v&agrave;o m&#7909;c &#273;&iacute;ch b&#7845;t h&#7907;p ph&aacute;p</li>
      <li>Qu&#7845;y r&#7889;i, &#273;e d&#7885;a ho&#7863;c l&#7841;m d&#7909;ng ng&#432;&#7901;i d&ugrave;ng kh&aacute;c hay nh&acirc;n vi&ecirc;n</li>
      <li>&#272;&#259;ng th&ocirc;ng tin sai l&#7879;ch, gian l&#7853;n</li>
      <li>M&#7841;o danh ng&#432;&#7901;i kh&aacute;c</li>
      <li>Truy c&#7853;p tr&aacute;i ph&eacute;p v&agrave;o h&#7879; th&#7889;ng</li>
      <li>R&agrave; qu&eacute;t d&#7919; li&#7879;u b&#7857;ng c&ocirc;ng c&#7909; t&#7921; &#273;&#7897;ng</li>
      <li>C&agrave;i m&atilde; &#273;&#7897;c h&#7841;i v&agrave;o h&#7879; th&#7889;ng</li>
      <li>&#272;&#7863;t ch&#7895; gian l&#7853;n</li>
      <li>B&aacute;n l&#7841;i t&iacute;nh n&#259;ng kh&ocirc;ng c&oacute; s&#7921; cho ph&eacute;p</li>
    </ul>
  </section>

  <section>
    <h2><span class="num">5</span> N&#7897;i dung ng&#432;&#7901;i d&ugrave;ng</h2>
    <p>B&#7857;ng c&aacute;ch g&#7917;i &#273;&aacute;nh gi&aacute;, h&igrave;nh &#7843;nh ho&#7863;c n&#7897;i dung kh&aacute;c, b&#7841;n c&#7845;p cho SportConnect
    gi&#7845;y ph&eacute;p s&#7917; d&#7909;ng, hi&#7875;n th&#7883; v&agrave; ph&acirc;n ph&#7889;i trong &#7912;ng d&#7909;ng. N&#7897;i dung ph&#7843;i
    trung th&#7921;c, kh&ocirc;ng vi ph&#7841;m quy&#7873;n c&#7911;a b&ecirc;n th&#7913; ba. Ch&uacute;ng t&ocirc;i c&oacute; th&#7875; x&oacute;a
    n&#7897;i dung b&#7845;t k&#7923; l&uacute;c n&agrave;o.</p>
  </section>

  <section>
    <h2><span class="num">6</span> T&#7841;m ng&#432;ng v&agrave; ch&#7845;m d&#7913;t t&agrave;i kho&#7843;n</h2>
    <p>B&#7841;n c&oacute; th&#7875; x&oacute;a t&agrave;i kho&#7843;n b&#7845;t k&#7923; l&uacute;c n&agrave;o. Ch&uacute;ng t&ocirc;i c&oacute; th&#7875; t&#7841;m ng&#432;ng
    ho&#7863;c ch&#7845;m d&#7913;t t&agrave;i kho&#7843;n khi b&#7841;n vi ph&#7841;m &#272;i&#7873;u kho&#7843;n, gian l&#7853;n ho&#7863;c c&oacute;
    y&ecirc;u c&#7847;u t&#7915; c&#417; quan c&oacute; th&#7849;m quy&#7873;n. C&aacute;c &#272;i&#7873;u kho&#7843;n 8&ndash;12 v&#7851;n c&oacute; hi&#7879;u
    l&#7921;c sau ch&#7845;m d&#7913;t.</p>
  </section>

  <section>
    <h2><span class="num">7</span> Thanh to&aacute;n</h2>
    <p>M&#7897;t s&#7889; d&#7883;ch v&#7909; y&ecirc;u c&#7847;u thanh to&aacute;n b&#7857;ng VN&#272;. Ch&uacute;ng t&ocirc;i kh&ocirc;ng l&#432;u
    th&ocirc;ng tin th&#7867;. Quy&#7873;n ho&agrave;n ti&#7873;n ph&#7909; thu&#7897;c ch&iacute;nh s&aacute;ch c&#7911;a t&#7915;ng c&#417; s&#7903;.</p>
  </section>

  <section>
    <h2><span class="num">8</span> S&#7903; h&#7919;u tr&iacute; tu&#7879;</h2>
    <p>T&#7845;t c&#7843; n&#7897;i dung v&agrave; ph&#7847;n m&#7873;m c&#7911;a &#7912;ng d&#7909;ng l&agrave; t&agrave;i s&#7843;n c&#7911;a SportConnect ho&#7863;c
    b&ecirc;n c&#7845;p ph&eacute;p. Ch&uacute;ng t&ocirc;i c&#7845;p cho b&#7841;n gi&#7845;y ph&eacute;p c&oacute; gi&#7899;i h&#7841;n, c&aacute; nh&acirc;n, phi
    th&#432;&#417;ng m&#7841;i.</p>
  </section>

  <section>
    <h2><span class="num">9</span> Tuy&ecirc;n b&#7889; mi&#7877;n tr&aacute;ch nhi&#7879;m</h2>
    <div class="warning">
      <strong>&#7912;NG D&#7908;NG &#272;&#431;&#7906;C CUNG C&#7844;P &ldquo;NGUY&Ecirc;N TR&#7840;NG&rdquo; KH&Ocirc;NG K&Egrave;M B&#7842;O &#272;&#7842;M,
      T&#7888;I M&#7�;C T&#7888;I &#272;A &#272;&#431;&#7906;C PH&Eacute;P B&#7872;I PH&Aacute;P LU&#7840;T VI&#7878;T NAM.</strong>
    </div>
    <p>SportConnect kh&ocirc;ng &#273;&#7843;m b&#7843;o &#7912;ng d&#7909;ng ho&#7841;t &#273;&#7897;ng li&ecirc;n t&#7909;c, th&ocirc;ng tin c&#417; s&#7903; lu&ocirc;n
    ch&iacute;nh x&aacute;c ho&#7863;c c&#417; s&#7903; &#273;&#7841;t ti&ecirc;u chu&#7849;n ch&#7845;t l&#432;&#7907;ng c&#7909; th&#7875;.</p>
  </section>

  <section>
    <h2><span class="num">10</span> Gi&#7899;i h&#7841;n tr&aacute;ch nhi&#7879;m</h2>
    <p>SportConnect kh&ocirc;ng ch&#7883;u tr&aacute;ch nhi&#7879;m v&#7873; thi&#7879;t h&#7841;i gi&aacute;n ti&#7871;p, m&#7845;t l&#7907;i nhu&#7853;n hay d&#7919;
    li&#7879;u. T&#7893;ng tr&aacute;ch nhi&#7879;m kh&ocirc;ng v&#432;&#7907;t qu&aacute; s&#7889; ti&#7873;n l&#7899;n h&#417;n gi&#7919;a: (a)&nbsp;s&#7889; ti&#7873;n b&#7841;n
    &#273;&atilde; thanh to&aacute;n trong 12&nbsp;th&aacute;ng tr&#432;&#7899;c, ho&#7863;c (b)&nbsp;500.000&nbsp;&#272;.</p>
  </section>

  <section>
    <h2><span class="num">11</span> B&#7891;i th&#432;&#7901;ng</h2>
    <p>B&#7841;n &#273;&#7891;ng &yacute; b&#7891;i th&#432;&#7901;ng SportConnect kh&#7887;i c&aacute;c khi&#7871;u n&#7841;i ph&aacute;t sinh t&#7915; vi&#7879;c b&#7841;n
    s&#7917; d&#7909;ng &#7912;ng d&#7909;ng, n&#7897;i dung c&#7911;a b&#7841;n ho&#7863;c vi ph&#7841;m &#272;i&#7873;u kho&#7843;n.</p>
  </section>

  <section>
    <h2><span class="num">12</span> Lu&#7853;t &#273;i&#7873;u ch&#7881;nh &amp; Gi&#7843;i quy&#7871;t tranh ch&#7845;p</h2>
    <p>&#272;i&#7873;u ch&#7881;nh b&#7903;i ph&aacute;p lu&#7853;t <strong>C&#7897;ng h&ograve;a X&atilde; h&#7897;i ch&#7911; ngh&#297;a Vi&#7879;t Nam</strong>.
    Tranh ch&#7845;p gi&#7843;i quy&#7871;t c&#7911;a b&#7857;ng th&#432;&#417;ng l&#432;&#7907;ng trong 30&nbsp;ng&agrave;y; sau &#273;&oacute; t&#7841;i
    t&ograve;a &aacute;n c&oacute; th&#7849;m quy&#7873;n t&#7841;i <strong>Th&agrave;nh ph&#7889; H&#7891; Ch&iacute; Minh</strong>.</p>
  </section>

  <section>
    <h2><span class="num">13</span> Thay &#273;&#7893;i &#272;i&#7873;u kho&#7843;n</h2>
    <p>C&oacute; th&#7875; c&#7853;p nh&#7853;t b&#7845;t k&#7923; l&uacute;c n&agrave;o; thay &#273;&#7893;i quan tr&#7885;ng s&#7869; &#273;&#432;&#7907;c th&ocirc;ng b&aacute;o
    trong &#7912;ng d&#7909;ng. Ti&#7871;p t&#7909;c s&#7917; d&#7909;ng l&agrave; &#273;&#7891;ng &yacute; thay &#273;&#7893;i.</p>
  </section>

  <section>
    <h2><span class="num">14</span> Li&ecirc;n h&#7879;</h2>
    <ul>
      <li><strong>Email ph&aacute;p l&yacute;:</strong> legal@sportconnects.org</li>
      <li><strong>H&#7895; tr&#7907;:</strong> support@sportconnects.org</li>
      <li><strong>Website:</strong> sportconnects.org</li>
    </ul>
  </section>
</div>
{VI_FOOTER}
</body>
</html>"""

# Write files
base.joinpath("privacy.html").write_text(PRIVACY_EN, encoding="utf-8")
base.joinpath("terms.html").write_text(TERMS_EN, encoding="utf-8")
base.joinpath("privacy_vi.html").write_text(PRIVACY_VI, encoding="utf-8")
base.joinpath("terms_vi.html").write_text(TERMS_VI, encoding="utf-8")

for f in sorted(base.iterdir()):
    if f.suffix == ".html":
        print(f"{f.name}: {f.stat().st_size / 1024:.1f} KB")
print("Done.")
