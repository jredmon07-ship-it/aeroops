/**
 * Babel config for Expo / React Native.
 * babel-preset-expo is the Expo-managed preset — handles JSX, TS, and
 * the module resolution that Metro uses at runtime.
 *
 * NOTE: Metro resolves modules at runtime (not tsc). The tsconfig paths
 *       (like @aeroops/core) are handled by Metro's watchFolders +
 *       resolver.extraNodeModules in metro.config.js.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
