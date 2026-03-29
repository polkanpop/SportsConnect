const appJson = require('./app.json')

function hasPackage(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

function ensurePlugin(plugins, candidate) {
  const name = Array.isArray(candidate) ? candidate[0] : candidate
  const exists = plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name)
  if (!exists) {
    plugins.push(candidate)
  }
}

module.exports = () => {
  const expo = appJson.expo ?? {}
  const plugins = [...(expo.plugins ?? [])]

  ensurePlugin(plugins, [
    'expo-location',
    {
      locationWhenInUsePermission: 'Allow $(PRODUCT_NAME) to show your location on the map.',
    },
  ])

  // expo-notifications: adds FCM service for Android and configures APNs entitlement on iOS.
  // Switch mode to 'production' when submitting to the stores.
  ensurePlugin(plugins, [
    'expo-notifications',
    {
      icon: './assets/icons/SportConnect_icon.png',
      color: '#FF6017',
      defaultChannel: 'default',
      sounds: [],
      iosDisplayInForeground: true,
      mode: 'development',
    },
  ])

  if (hasPackage('@rnmapbox/maps')) {
    ensurePlugin(plugins, [
      '@rnmapbox/maps',
      {
        // Build-time token for downloading the native Mapbox SDK used by @rnmapbox/maps.
        RNMapboxMapsDownloadToken: process.env.RNMAPBOX_MAPS_DOWNLOAD_TOKEN ?? '',
        RNMapboxMapsVersion: '11.0.0',
      },
    ])
  }

  return {
    ...expo,
    extra: {
      ...(expo.extra ?? {}),
      GOONG_MAPTILES_KEY: process.env.EXPO_PUBLIC_GOONG_MAPTILES_KEY ?? '',
      MAPBOX_PUBLIC_TOKEN: process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN ?? '',
    },
    plugins,
  }
}