/**
 * metro.config.js — Metro bundler config for the AeroOps mobile app.
 *
 * Key configuration:
 *   watchFolders: include the monorepo root so Metro can resolve workspace
 *                 packages (primarily @aeroops/core) during dev.
 *   resolver.extraNodeModules: maps the @aeroops/core alias to the package
 *                              source so Metro resolves it identically to tsc.
 *
 * This file is NOT imported during typecheck — it is Metro-only.
 * The boundary enforced here: @aeroops/api and @aeroops/db MUST NOT appear
 * in extraNodeModules (Node-only packages; would fail at RN runtime).
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

const config = getDefaultConfig(__dirname);

// Allow Metro to watch the monorepo root so workspace packages resolve.
config.watchFolders = [repoRoot];

// Map @aeroops/core to its source (RN-safe; no Node-only deps).
config.resolver = {
  ...config.resolver,
  extraNodeModules: {
    '@aeroops/core': path.resolve(repoRoot, 'packages/core/src'),
  },
};

module.exports = config;
