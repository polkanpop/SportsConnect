// Re-enable NativeWind via Metro wrapper instead of Babel plugin to avoid
// triggering the mysterious Babel '.plugins' option error.
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const config = getDefaultConfig(__dirname)
module.exports = withNativeWind(config, { input: './app/global.css' })