/**
 * withZaloSDK.js  —  Expo config plugin for react-native-zalo-kit
 *
 * Automatically applies every native change required by react-native-zalo-kit so
 * that `npx expo prebuild` produces a build-ready android/ and ios/ folder
 * without any hand-editing.
 *
 * Android changes:
 *   • android/app/src/main/res/values/strings.xml  → add <string name="appID">
 *   • android/app/src/main/AndroidManifest.xml     → meta-data, BrowserLoginActivity, <queries>
 *   • android/app/src/main/java/.../MainApplication.kt → ZaloSDK.Instance.init(this)
 *   • android/app/src/main/java/.../MainActivity.kt    → onActivityResult override
 *   • android/app/proguard-rules.pro               → keep Zalo classes
 *
 * iOS changes:
 *   • ios/<App>/Info.plist  → CFBundleURLTypes (zalo-<appId>), LSApplicationQueriesSchemes
 *   • ios/<App>/AppDelegate.mm → ZaloSDK init + openURL handler
 */

const {
  withAndroidManifest,
  withStringsXml,
  withMainApplication,
  withMainActivity,
  withDangerousMod,
  withInfoPlist,
  withAppDelegate,
} = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// ─── Android ─────────────────────────────────────────────────────────────────

/** 1. strings.xml → <string name="appID">...</string> */
function withZaloStrings(config, { appId }) {
  return withStringsXml(config, (config) => {
    const strings = config.modResults.resources.string ?? [];
    if (!strings.find((s) => s.$?.name === 'appID')) {
      strings.push({ $: { name: 'appID' }, _: appId });
      config.modResults.resources.string = strings;
    }
    return config;
  });
}

/** 2. AndroidManifest.xml → meta-data + BrowserLoginActivity + <queries> */
function withZaloManifest(config, { appId }) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return config;

    // ── meta-data for Zalo App ID ──────────────────────────────────────────
    if (!app['meta-data']) app['meta-data'] = [];
    const hasMeta = app['meta-data'].some(
      (m) => m.$?.['android:name'] === 'com.zing.zalo.zalosdk.appID',
    );
    if (!hasMeta) {
      app['meta-data'].push({
        $: {
          'android:name': 'com.zing.zalo.zalosdk.appID',
          'android:value': '@string/appID',
        },
      });
    }

    // ── BrowserLoginActivity ───────────────────────────────────────────────
    if (!app.activity) app.activity = [];
    const hasActivity = app.activity.some(
      (a) => a.$?.['android:name'] === 'com.zing.zalo.zalosdk.oauth.BrowserLoginActivity',
    );
    if (!hasActivity) {
      app.activity.push({
        $: {
          'android:name': 'com.zing.zalo.zalosdk.oauth.BrowserLoginActivity',
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
            category: [
              { $: { 'android:name': 'android.intent.category.DEFAULT' } },
              { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
            ],
            data: [{ $: { 'android:scheme': `zalo-${appId}` } }],
          },
        ],
      });
    }

    // ── <queries> so Android knows Zalo is a valid target ─────────────────
    if (!manifest.queries) manifest.queries = [];
    const hasZaloQuery = manifest.queries.some((q) =>
      (q.package ?? []).some((p) => p.$?.['android:name'] === 'com.zing.zalo'),
    );
    if (!hasZaloQuery) {
      manifest.queries.push({ package: [{ $: { 'android:name': 'com.zing.zalo' } }] });
    }

    return config;
  });
}

/** 3. MainApplication.kt → ZaloSDK.Instance.init(this) in onCreate */
function withZaloMainApplication(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;

    if (src.includes('ZaloSDK')) return config; // already patched

    // Import
    src = src.replace(
      /^(import expo\.modules\.ApplicationLifecycleDispatcher)/m,
      'import com.zing.zalo.zalosdk.oauth.ZaloSDK\n$1',
    );

    // Init call — insert just before ApplicationLifecycleDispatcher.onApplicationCreate
    src = src.replace(
      /(\s+)(ApplicationLifecycleDispatcher\.onApplicationCreate\(this\))/,
      '$1ZaloSDK.Instance.init(this)\n$1$2',
    );

    config.modResults.contents = src;
    return config;
  });
}

/** 4. MainActivity.kt → onActivityResult override */
function withZaloMainActivity(config) {
  return withMainActivity(config, (config) => {
    let src = config.modResults.contents;

    if (src.includes('ZaloSDK')) return config; // already patched

    // Imports — add after existing android.os.* block
    src = src.replace(
      /^(import android\.os\.Bundle)/m,
      'import android.content.Intent\n$1',
    );
    src = src.replace(
      /^(import com\.facebook\.react\.ReactActivity)/m,
      'import com.zing.zalo.zalosdk.oauth.ZaloSDK\n$1',
    );

    // Add override before the class closing brace
    const override = [
      '',
      '  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {',
      '    super.onActivityResult(requestCode, resultCode, data)',
      '    ZaloSDK.Instance.onActivityResult(this, requestCode, resultCode, data)',
      '  }',
    ].join('\n');

    // Insert before the final closing brace of the class
    src = src.replace(/(\n\})\s*$/, `\n${override}\n}`);

    config.modResults.contents = src;
    return config;
  });
}

/** 5. proguard-rules.pro → keep Zalo classes */
function withZaloProguard(config) {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const proguardPath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro',
      );
      const rules = [
        '',
        '# Zalo SDK — added by withZaloSDK plugin',
        '-keep class com.zing.zalo.**{ *; }',
        '-keep enum com.zing.zalo.**{ *; }',
        '-keep interface com.zing.zalo.**{ *; }',
        '',
      ].join('\n');

      const current = fs.existsSync(proguardPath)
        ? fs.readFileSync(proguardPath, 'utf8')
        : '';
      if (!current.includes('com.zing.zalo')) {
        fs.appendFileSync(proguardPath, rules, 'utf8');
      }
      return config;
    },
  ]);
}

// ─── iOS ─────────────────────────────────────────────────────────────────────

/** 6. Info.plist → URL scheme + LSApplicationQueriesSchemes */
function withZaloInfoPlist(config, { appId }) {
  return withInfoPlist(config, (config) => {
    const plist = config.modResults;

    // CFBundleURLTypes — zalo-<appId>
    if (!plist.CFBundleURLTypes) plist.CFBundleURLTypes = [];
    const hasZaloURL = plist.CFBundleURLTypes.some((t) =>
      (t.CFBundleURLSchemes ?? []).includes(`zalo-${appId}`),
    );
    if (!hasZaloURL) {
      plist.CFBundleURLTypes.push({
        CFBundleURLName: 'zalo',
        CFBundleURLSchemes: [`zalo-${appId}`],
      });
    }

    // LSApplicationQueriesSchemes
    if (!plist.LSApplicationQueriesSchemes) plist.LSApplicationQueriesSchemes = [];
    for (const scheme of ['zalosdk', 'zaloshareext']) {
      if (!plist.LSApplicationQueriesSchemes.includes(scheme)) {
        plist.LSApplicationQueriesSchemes.push(scheme);
      }
    }

    return config;
  });
}

/** 7. AppDelegate.mm → ZaloSDK init + openURL handler */
function withZaloAppDelegate(config, { appId }) {
  return withAppDelegate(config, (config) => {
    let src = config.modResults.contents;

    if (src.includes('ZaloSDK')) return config; // already patched

    // Import header
    src = src.replace(
      /#import <React\/RCTBundleURLProvider\.h>/,
      `#import <React/RCTBundleURLProvider.h>\n#import <ZaloSDK/ZaloSDK.h>`,
    );

    // Init call (Expo AppDelegate pattern)
    const initLine = `  [[ZaloSDK sharedInstance] initializeWithAppId:@"${appId}"];\n`;
    src = src.replace(
      /return \[super application:application didFinishLaunchingWithOptions:launchOptions\];/,
      `${initLine}  return [super application:application didFinishLaunchingWithOptions:launchOptions];`,
    );

    // openURL handler — insert before the final @end
    if (!src.includes('ZDKApplicationDelegate')) {
      const openURL = [
        '',
        '- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {',
        '  return [[ZDKApplicationDelegate sharedInstance] application:application openURL:url options:options];',
        '}',
        '',
      ].join('\n');
      src = src.replace(/\n@end\s*$/, `\n${openURL}\n@end`);
    }

    config.modResults.contents = src;
    return config;
  });
}

// ─── Compose ─────────────────────────────────────────────────────────────────

/** Main plugin — apply all sub-plugins */
module.exports = (config, options = {}) => {
  const appId = (options.appId || '').toString().trim();
  if (!appId) {
    throw new Error('[withZaloSDK] `appId` option is required. Pass your Zalo App ID.');
  }

  config = withZaloStrings(config, { appId });
  config = withZaloManifest(config, { appId });
  config = withZaloMainApplication(config);
  config = withZaloMainActivity(config);
  config = withZaloProguard(config);
  config = withZaloInfoPlist(config, { appId });
  config = withZaloAppDelegate(config, { appId });

  return config;
};
