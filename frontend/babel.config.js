// Minimal Babel config with scoped NativeWind. If the previous global plugin
// triggered a Metro bug, this keeps transformation simple. No dotenv plugin.
// Final simplified Babel config: rely ONLY on Expo preset.
// NativeWind handled by metro (withNativeWind); plugin removed due to '.plugins' error.
module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo']
  }
}